/**
 * The Daily Paper, pure part: the owner's section list and its defaults, the
 * checks on what an agent publishes, when the evening task and the compiled
 * edition are due, the archive order, the copy for the Daily brief issue and
 * the edition compiled from the numbers.
 */
import { describe, expect, it } from "vitest";
import {
  BACKDATE_DAYS,
  briefToEdition,
  checkPublish,
  compileEdition,
  countWords,
  defaultSections,
  defaultSettings,
  editionMarkdown,
  fallbackDue,
  indexEntry,
  longDate,
  normalizeSections,
  normalizeSettings,
  PAPER_LIMITS,
  paperName,
  parseEdition,
  parseIndex,
  sastDate,
  sastMinutes,
  shortDate,
  taskDue,
  upsertIndex,
  type BriefLike,
  type PaperEditionDoc,
} from "../src/paper-model.js";

// 13 Nov 2026 is a Friday. 15:30 UTC is 17:30 SAST.
const FRI_1730 = new Date("2026-11-13T15:30:00.000Z");
const SAT_1730 = new Date("2026-11-14T15:30:00.000Z");

const doc = (over: Partial<PaperEditionDoc> = {}): PaperEditionDoc => ({
  date: "2026-11-13",
  edition: "morning",
  number: 7,
  name: "The Partners in Biz Daily",
  headline: "Queue at 65, oldest item waits 12 days",
  standfirst: "Cash is R33,313 and nothing is overdue.",
  figures: [{ label: "Cash", value: "R33,313" }, { label: "Waiting on you", value: "65", note: "oldest 12 days", tone: "warn" }],
  sections: [
    { id: "needs-you", title: "Needs you", body: "- Approve the [Tvisha invoice](/PAR/issues/PAR-1) for R6,250.", source: "company" },
    { id: "tech-news", title: "Tech and AI news", body: "- A new model shipped. [Source](https://example.com/a)", source: "web" },
  ],
  source: "agent",
  author: "Thandi",
  authorAgentId: "a1",
  publishedAt: "2026-11-13T05:03:00.000Z",
  revision: 1,
  words: 0,
  ...over,
});

describe("time", () => {
  it("reads the SAST day and minute", () => {
    expect(sastDate(new Date("2026-11-13T22:30:00.000Z"))).toBe("2026-11-14");
    expect(sastMinutes(FRI_1730)).toBe(17 * 60 + 30);
    expect(longDate("2026-11-13")).toBe("Friday, 13 November 2026");
    expect(shortDate("2026-11-13")).toBe("Fri 13 Nov");
  });
});

describe("settings", () => {
  it("start with a morning and an evening edition, tech news listed but off", () => {
    const s = defaultSettings();
    expect(s.editions.morning.sections.map((x) => x.id)).toEqual(["needs-you", "money", "clients", "sales-marketing", "risks", "team", "today", "good-news", "tech-news"]);
    expect(s.editions.morning.sections.find((x) => x.id === "tech-news")).toMatchObject({ enabled: false, source: "web" });
    expect(s.editions.evening.time).toBe("17:00");
    expect(defaultSections("evening")[0]!.id).toBe("done-today");
  });

  it("keep what the owner saved and repair what is malformed", () => {
    const s = normalizeSettings({
      name: "  The   PiB Post ",
      editions: {
        morning: { enabled: false, time: "05:00", days: "weekdays", note: "Lead with cash", sections: [{ title: "On X", instruction: "What @levelsio posted", source: "web" }, { title: "" }, { title: "On X", instruction: "second" }] },
        evening: { time: "25:99" },
      },
    });
    expect(s.name).toBe("The PiB Post");
    // The morning edition follows the daily review, so a saved time is ignored.
    expect(s.editions.morning).toMatchObject({ enabled: false, time: "07:00", days: "weekdays", note: "Lead with cash" });
    expect(s.editions.morning.sections.map((x) => x.id)).toEqual(["on-x", "on-x-2"]);
    expect(s.editions.morning.sections[0]).toMatchObject({ source: "web", enabled: true });
    expect(s.editions.evening.time).toBe("17:00");
    expect(s.editions.evening.sections.length).toBeGreaterThan(3);
    expect(normalizeSettings(null)).toEqual(defaultSettings());
  });

  it("cap the list and name the paper after the company", () => {
    expect(normalizeSections(Array.from({ length: 40 }, (_, i) => ({ title: `S ${i}` }))).length).toBe(PAPER_LIMITS.sections);
    expect(paperName({ name: "" }, "Partners in Biz")).toBe("The Partners in Biz Daily");
    expect(paperName({ name: "The Post" }, "Partners in Biz")).toBe("The Post");
    expect(paperName({ name: "" }, null)).toBe("The Daily Paper");
  });
});

describe("when things are due", () => {
  const evening = defaultSettings().editions.evening;
  it("opens the evening task once, from its time", () => {
    expect(taskDue(evening, new Date("2026-11-13T14:59:00.000Z"), { taskDate: null, publishedDate: null })).toBe(false);
    expect(taskDue(evening, FRI_1730, { taskDate: null, publishedDate: null })).toBe(true);
    expect(taskDue(evening, FRI_1730, { taskDate: "2026-11-13", publishedDate: null })).toBe(false);
    expect(taskDue(evening, FRI_1730, { taskDate: "2026-11-12", publishedDate: "2026-11-13" })).toBe(false);
    expect(taskDue({ ...evening, enabled: false }, FRI_1730, { taskDate: null, publishedDate: null })).toBe(false);
  });

  it("skips the weekend for a weekdays edition", () => {
    expect(taskDue({ ...evening, days: "weekdays" }, SAT_1730, { taskDate: null, publishedDate: null })).toBe(false);
    expect(taskDue(evening, SAT_1730, { taskDate: null, publishedDate: null })).toBe(true);
  });

  it("compiles an edition two hours after its time when none arrived", () => {
    const morning = defaultSettings().editions.morning;
    expect(fallbackDue(morning, new Date("2026-11-13T06:59:00.000Z"), { publishedDate: "2026-11-12" })).toBe(false);
    expect(fallbackDue(morning, new Date("2026-11-13T07:00:00.000Z"), { publishedDate: "2026-11-12" })).toBe(true);
    expect(fallbackDue(morning, new Date("2026-11-13T07:00:00.000Z"), { publishedDate: "2026-11-13" })).toBe(false);
    expect(fallbackDue(evening, FRI_1730, { publishedDate: null })).toBe(false);
    expect(fallbackDue(evening, new Date("2026-11-13T17:00:00.000Z"), { publishedDate: null })).toBe(true);
  });

  it("does not make up for an edition whose time had passed when the paper was first switched on, nor compile one at night", () => {
    const morning = defaultSettings().editions.morning;
    const noon = new Date("2026-11-13T10:00:00.000Z");
    // First seen at 11:00 SAST, after the 07:00 edition: not compiled that day, compiled the next.
    expect(fallbackDue(morning, noon, { publishedDate: null, firstSeenAt: "2026-11-13T09:00:00.000Z" })).toBe(false);
    expect(fallbackDue(morning, new Date("2026-11-14T10:00:00.000Z"), { publishedDate: null, firstSeenAt: "2026-11-13T09:00:00.000Z" })).toBe(true);
    expect(fallbackDue(morning, noon, { publishedDate: null, firstSeenAt: "2026-11-12T09:00:00.000Z" })).toBe(true);
    // 07:00 + 8 hours is 15:00 SAST: after that it is left alone.
    expect(fallbackDue(morning, new Date("2026-11-13T13:01:00.000Z"), { publishedDate: null })).toBe(false);
  });
});

describe("what an agent publishes", () => {
  const spec = defaultSettings().editions.morning.sections;
  const good = {
    edition: "morning",
    headline: "Queue at 65,\n oldest item waits 12 days",
    standfirst: "Cash is R33,313.",
    figures: [{ label: "Cash", value: "R33,313" }, { label: "Queue", value: 65, tone: "warn" }, { label: "", value: "x" }],
    sections: [
      { id: "needs-you", title: "Needs you", body: "- Approve the invoice." },
      { title: "tech and ai news", body: "- A story. [Source](https://example.com)" },
      { title: "Something new", body: "A paragraph." },
      { id: "risks", title: "Risks", body: "   " },
    ],
  };

  it("is cleaned and given each section's source from the owner's list", () => {
    const r = checkPublish(good, spec, FRI_1730);
    if (!r.ok) throw new Error(r.error);
    expect(r.input.date).toBe("2026-11-13");
    expect(r.input.headline).toBe("Queue at 65, oldest item waits 12 days");
    expect(r.input.figures).toEqual([{ label: "Cash", value: "R33,313" }, { label: "Queue", value: "65", tone: "warn" }]);
    expect(r.input.sections.map((s) => [s.id, s.source])).toEqual([["needs-you", "company"], ["tech-news", "web"], ["something-new", "company"]]);
  });

  it("is refused with a reason an agent can act on", () => {
    const bad = (patch: Record<string, unknown>) => {
      const r = checkPublish({ ...good, ...patch }, spec, FRI_1730);
      return r.ok ? "" : r.error;
    };
    expect(bad({ edition: "noon" })).toContain("morning");
    expect(bad({ headline: " " })).toContain("headline is required");
    expect(bad({ standfirst: "" })).toContain("standfirst is required");
    expect(bad({ sections: [] })).toContain("sections is required");
    expect(bad({ sections: [{ title: "A", body: "" }] })).toContain("Every section body is empty");
    expect(bad({ sections: [{ title: "A", body: "x".repeat(PAPER_LIMITS.sectionBody + 1) }] })).toContain("Cut it");
    expect(bad({ date: "2026-11-14" })).toContain("in the future");
    expect(bad({ date: "2026-11-01" })).toContain(`more than ${BACKDATE_DAYS} days back`);
    expect(bad({ date: "13 Nov" })).toContain("YYYY-MM-DD");
    expect(checkPublish({ ...good, date: "2026-11-12" }, spec, FRI_1730).ok).toBe(true);
  });
});

describe("the archive", () => {
  it("lists newest first, the evening edition above the morning one, each day and edition once", () => {
    const a = indexEntry(doc());
    const b = indexEntry(doc({ edition: "evening", headline: "Evening" }));
    const c = indexEntry(doc({ date: "2026-11-12", headline: "Yesterday" }));
    let list = upsertIndex(upsertIndex(upsertIndex([], c), a), b);
    expect(list.map((e) => e.headline)).toEqual(["Evening", "Queue at 65, oldest item waits 12 days", "Yesterday"]);
    list = upsertIndex(list, indexEntry(doc({ headline: "Rewritten" })));
    expect(list.map((e) => e.headline)).toEqual(["Evening", "Rewritten", "Yesterday"]);
    expect(parseIndex(JSON.parse(JSON.stringify(list)))).toEqual(list);
    expect(parseIndex([{ date: "bad" }, null])).toEqual([]);
  });

  it("keeps a short standfirst and reads a stored edition back", () => {
    const long = indexEntry(doc({ standfirst: "word ".repeat(200) }));
    expect(long.standfirst.length).toBeLessThanOrEqual(PAPER_LIMITS.indexStandfirst);
    expect(long.standfirst.endsWith("…")).toBe(true);
    const d = doc();
    expect(parseEdition(JSON.parse(JSON.stringify(d)))).toEqual(d);
    expect(parseEdition({ date: "2026-11-13" })).toBeNull();
  });

  it("counts a link as its label", () => {
    expect(countWords({ headline: "One two", standfirst: "three", sections: [{ id: "a", title: "Four", body: "- five [six seven](https://example.com/very/long) **eight**", source: "company" }] })).toBe(8);
  });
});

describe("the copy on the Daily brief issue", () => {
  it("carries the headline, the numbers, every section and the link to the paper", () => {
    const md = editionMarkdown(doc(), "/PAR/cockpit?tab=paper&date=2026-11-13&edition=morning");
    expect(md).toContain("**The Partners in Biz Daily: morning edition, Friday, 13 November 2026**");
    expect(md).toContain("## Queue at 65, oldest item waits 12 days");
    expect(md).toContain("**Waiting on you** 65 (oldest 12 days)");
    expect(md).toContain("**Needs you**");
    expect(md).toContain("**Tech and AI news**");
    expect(md.endsWith("[Read it as a paper](/PAR/cockpit?tab=paper&date=2026-11-13&edition=morning)")).toBe(true);
  });

  it("is cut to fit a comment, and says so", () => {
    const big = doc({ sections: Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, title: `Section ${i}`, body: "x".repeat(3000), source: "company" as const })) });
    const md = editionMarkdown(big, "/PAR/cockpit?tab=paper");
    expect(md.length).toBeLessThanOrEqual(8000);
    expect(md).toContain("_The rest is in the paper._");
    expect(md).toContain("**Section 0**");
    expect(md).not.toContain("**Section 5**");
  });
});

describe("the edition the Cockpit compiles itself", () => {
  const brief: BriefLike = {
    today: "65 items wait on you. Health: warnings.",
    waiting: [
      { title: "Approve the Tvisha invoice", why: "R6,250", kind: "money", href: "/billing", identifier: "PAR-1", link: "/PAR/issues/PAR-1", ageHours: 300 },
      { title: "Sign in to App Store Connect", kind: "grant", href: null, identifier: null, ageHours: 12 },
    ],
    health: { status: "warn", problems: [{ plugin: "Mailbox", status: "bad", title: "Sender domain revoked", detail: "SES", href: "/PAR/mailbox" }], agentAlerts: [{ title: "Max is paused", detail: null, href: null }] },
    kpis: { money: [{ label: "Cash", value: "R33,313", href: "/PAR/accounting" }, { label: "Overdue", value: "R0", tone: "ok", href: null }], pipeline: [{ label: "Open deals", value: 4, href: null }] },
    activity: [{ agent: "Sofia", done: [{ text: "Closed 6 SEO tasks", href: "/PAR/seo" }] }, { agent: "Idle", done: [] }],
    agents: [{ name: "Sofia", status: "active" }, { name: "Max", status: "paused" }],
    degraded: ["goals"],
    links: { cockpit: "/PAR/cockpit" },
  };

  it("fills what the numbers can fill and names what needs a writer", () => {
    const spec = defaultSettings().editions.morning.sections.map((s) => (s.id === "tech-news" ? { ...s, enabled: true } : s));
    const out = compileEdition({ brief, edition: "morning", date: "2026-11-13", spec, why: "Compiled by the Cockpit." });
    expect(out.headline).toBe("2 items wait on you, the oldest for 12 days");
    expect(out.standfirst).toBe("65 items wait on you. Health: warnings. Compiled by the Cockpit.");
    expect(out.figures.map((f) => f.label)).toEqual(["Cash", "Overdue", "Waiting on you", "Agents active"]);
    expect(out.figures[1]).toMatchObject({ tone: "ok" });
    const byId = Object.fromEntries(out.sections.map((s) => [s.id, s.body]));
    expect(byId["needs-you"]).toContain("[PAR-1: Approve the Tvisha invoice](/PAR/issues/PAR-1). R6,250");
    expect(byId.money).toContain("[Cash](/PAR/accounting): **R33,313**");
    expect(byId.risks).toContain("[Sender domain revoked](/PAR/mailbox) (Mailbox): SES");
    expect(byId.risks).toContain("Max is paused");
    expect(byId.team).toBe("- **Sofia**: [Closed 6 SEO tasks](/PAR/seo)");
    expect(byId["sales-marketing"]).toContain("Open deals: **4**");
    expect(byId["not-written"]).toBe("These sections need a writer and were left out: Client desk, Today, Good news, Tech and AI news.");
    expect(byId.gaps).toContain("goals");
  });

  it("has a headline when nothing waits", () => {
    const calm = compileEdition({ brief: { ...brief, waiting: [], health: { status: "ok", problems: [], agentAlerts: [] }, degraded: [] }, edition: "evening", date: "2026-11-13", spec: defaultSections("evening"), why: "" });
    expect(calm.headline).toBe("Nothing waits on you");
    expect(calm.sections.find((s) => s.id === "still-open")!.body).toBe("Nothing waits on you.");
    expect(calm.sections.find((s) => s.id === "incidents")!.body).toBe("Every health check passes.");
  });
});

describe("the daily brief read as an edition", () => {
  const BRIEF = `**Daily brief, Fri 13 Nov.** Note: company-brief timed out once (504), then worked on retry.

**Paperclip status**
- Done yesterday: Sofia closed 6 SEO tasks. Cash R33,313; revenue this month R7,500; nothing overdue.
- Blocked: 3 issues wait on Max ([PAR-4436](/PAR/issues/PAR-4436)).

**Waiting on Peet (65, batched; hard stops first)**
- Money/client: approve invoice to Tvisha Aesthetics R6,250.

**Consent gate**

**Grok Bot work (Elon)**
- PAR-8566 blocked.`;

  it("takes the bold lines as sections, the note after the title as the standfirst and the waiting count as the headline", () => {
    const e = briefToEdition(BRIEF)!;
    expect(e.headline).toBe("65 items wait on you");
    expect(e.standfirst).toBe("Note: company-brief timed out once (504), then worked on retry.");
    // An empty section is dropped; a bracket after a title is a note, not part of it.
    expect(e.sections.map((s) => [s.id, s.title])).toEqual([["paperclip-status", "Paperclip status"], ["waiting-on-peet", "Waiting on Peet"], ["grok-bot-work", "Grok Bot work"]]);
    expect(e.sections[0]!.body).toContain("[PAR-4436](/PAR/issues/PAR-4436)");
    expect(e.figures).toEqual([]);
  });

  it("reads the skill's own shape and a brief that opens with a sentence", () => {
    const shaped = briefToEdition("**Daily brief, Friday 13 November**\n\n**Done yesterday**\n- Rhea published 3 posts.\n\n## Risks\n- None");
    expect(shaped).toMatchObject({ headline: "Rhea published 3 posts.", standfirst: "Daily brief, Friday 13 November" });
    expect(shaped!.sections.map((s) => s.title)).toEqual(["Done yesterday", "Risks"]);
    const prose = briefToEdition("Morning. Cash is R33,313 and nothing is overdue.\n\n**Money**\n- Approve the invoice.");
    expect(prose).toMatchObject({ headline: "Morning. Cash is R33,313 and nothing is overdue.", standfirst: "Morning. Cash is R33,313 and nothing is overdue." });
  });

  it("is not made from the Weekly retro or from a text with no sections", () => {
    expect(briefToEdition("**Weekly retro**\n\n**What worked**\n- A")).toBeNull();
    expect(briefToEdition("Just one line.")).toBeNull();
  });
});
