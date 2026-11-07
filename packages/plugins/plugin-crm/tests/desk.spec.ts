import { describe, expect, it } from "vitest";
import {
  activitySeries,
  batchRows,
  bucketOf,
  buildQueue,
  composeHref,
  dueDateInDays,
  funnel,
  outcomeBody,
  outcomeSuggestion,
  queueCounts,
  recordPath,
  startOfDay,
  telHref,
  type DeskActivity,
} from "../src/desk.js";

const TZ = "Africa/Johannesburg";
// 2026-11-07 10:00 SAST (08:00 UTC).
const NOW = Date.parse("2026-11-07T08:00:00Z");
const day = (n: number) => new Date(NOW + n * 86_400_000).toISOString();

describe("buckets and dates", () => {
  it("starts the day at local midnight", () => {
    expect(new Date(startOfDay(NOW, TZ)).toISOString()).toBe("2026-11-06T22:00:00.000Z");
    expect(new Date(startOfDay(NOW, "UTC")).toISOString()).toBe("2026-11-07T00:00:00.000Z");
  });

  it("sorts a due date into overdue, today, soon, later or undated", () => {
    expect(bucketOf(null, NOW, TZ)).toBe("undated");
    expect(bucketOf("not a date", NOW, TZ)).toBe("undated");
    expect(bucketOf("2026-11-06T21:59:00Z", NOW, TZ)).toBe("overdue");
    expect(bucketOf("2026-11-06T22:00:00Z", NOW, TZ)).toBe("today");
    expect(bucketOf("2026-11-07T20:00:00Z", NOW, TZ)).toBe("today");
    expect(bucketOf(day(1), NOW, TZ)).toBe("soon");
    expect(bucketOf(day(6), NOW, TZ)).toBe("soon");
    expect(bucketOf(day(8), NOW, TZ)).toBe("later");
  });

  it("gives a date N days on in the company's day", () => {
    expect(dueDateInDays(NOW, 0, TZ)).toBe("2026-11-07");
    expect(dueDateInDays(NOW, 1, TZ)).toBe("2026-11-08");
    expect(dueDateInDays(NOW, 7, TZ)).toBe("2026-11-14");
  });
});

describe("outcomes", () => {
  it("suggests the usual next step", () => {
    expect(outcomeSuggestion("no_answer")).toEqual({ kind: "call", inDays: 1 });
    expect(outcomeSuggestion("reached")).toEqual({ kind: "email", inDays: 2, lifecycle: "prospect" });
    expect(outcomeSuggestion("not_interested")).toEqual({ kind: null, inDays: null, lifecycle: "churned" });
    expect(outcomeSuggestion("meeting_booked").kind).toBe("meet");
    expect(outcomeSuggestion("meeting_booked").inDays).toBeNull();
  });

  it("writes a timeline line a person can read", () => {
    expect(outcomeBody("call", "no_answer", "")).toBe("No answer");
    expect(outcomeBody("call", "reached", "Wants a quote by Friday")).toBe("Spoke to them · Wants a quote by Friday");
    expect(outcomeBody("email", "sent", undefined)).toBe("Email: sent");
    expect(outcomeBody("meeting", "meeting_booked", " ")).toBe("Meeting: meeting booked");
  });
});

describe("the queue", () => {
  const accounts = [{ id: "acme", name: "Acme", phone: "+27 21 000 0000", billingEmail: "accounts@acme.test" }];
  const links = [{ contactId: "ada", accountId: "acme", roleLabel: "owner" }];
  const contacts = [
    { id: "ada", name: "Ada", emails: ["ada@acme.test"], phones: ["+27 82 123 4567"], lifecycle: "lead", nextActionKind: "call", nextActionDueAt: day(-3), leadScore: { fit: 3, intent: 2, urgency: 2, confidence: 0.9, scoredAt: day(-1) } },
    { id: "bob", name: "Bob", emails: [], phones: [], lifecycle: "lead", nextActionKind: "email", nextActionDueAt: null },
    { id: "cy", name: "Cy", emails: ["cy@x.test"], phones: [], lifecycle: "customer", nextActionKind: null, nextActionDueAt: null },
    { id: "di", name: "Di", emails: ["di@x.test"], phones: ["082 000 1111"], lifecycle: "lead", nextActionKind: "call", nextActionDueAt: "2026-11-07T12:00:00Z", emailStatus: "bounced" },
  ];
  const deals = [
    { id: "d1", title: "Acme site", amountMinor: 950_000, currency: "ZAR", stageId: "open", contactId: "ada", accountId: "acme", nextActionKind: "email", nextActionDueAt: day(2) },
    { id: "d2", title: "Lost one", amountMinor: 0, currency: "ZAR", stageId: "lost", contactId: null, accountId: "acme", nextActionKind: "call", nextActionDueAt: day(-1) },
  ];
  const activities: DeskActivity[] = [
    { id: "a1", recordType: "contact", recordId: "ada", kind: "brief", body: "Say AY-da. Site is down. Offer the roadmap.", createdAt: day(-0.5) },
    { id: "a2", recordType: "contact", recordId: "ada", kind: "call", body: "No answer", createdAt: day(-1) },
    { id: "a3", recordType: "contact", recordId: "ada", kind: "brief", body: "older brief", createdAt: day(-2) },
    { id: "a4", recordType: "contact", recordId: "di", kind: "given", body: "Given to Sales Lead: PAR-1", createdAt: day(-1) },
  ];
  const queue = buildQueue({ contacts, deals, accounts, links, openStageIds: new Set(["open"]), activities, now: NOW, timezone: TZ });

  it("lists every open next action, overdue first, and skips closed deals and records with none", () => {
    expect(queue.map((item) => item.key)).toEqual(["contact:ada", "contact:di", "deal:d1", "contact:bob"]);
    expect(queue.map((item) => item.bucket)).toEqual(["overdue", "today", "soon", "undated"]);
    expect(queueCounts(queue)).toEqual({ overdue: 1, today: 1, soon: 1, later: 0, undated: 1, now: 2 });
  });

  it("carries the phone, email, company, band, the newest brief and the last touch", () => {
    const ada = queue[0]!;
    expect(ada).toMatchObject({ company: "Acme", companyId: "acme", phone: "+27 82 123 4567", email: "ada@acme.test", band: "hot", emailOk: true });
    expect(ada.brief?.body).toBe("Say AY-da. Site is down. Offer the roadmap.");
    expect(ada.lastTouch).toMatchObject({ kind: "call", body: "No answer" });
  });

  it("a deal row uses its contact's phone, email and brief; a bounced email is not offered", () => {
    const deal = queue[2]!;
    expect(deal).toMatchObject({ recordType: "deal", contactId: "ada", name: "Ada", phone: "+27 82 123 4567", deal: { id: "d1", title: "Acme site" } });
    expect(deal.brief?.body).toContain("AY-da");
    expect(queue[1]).toMatchObject({ name: "Di", emailOk: false });
    expect(queue[1]!.lastTouch).toBeNull();
  });

  it("finds the record's page", () => {
    expect(recordPath(queue[0]!)).toBe("/crm?client=contact%3Aada");
    expect(recordPath(queue[2]!)).toBe("/crm?client=contact%3Aada");
    expect(recordPath({ recordType: "deal", recordId: "x", contactId: null, companyId: "acme" })).toBe("/crm?client=company%3Aacme");
    expect(recordPath({ recordType: "deal", recordId: "x", contactId: null, companyId: null })).toBeNull();
  });
});

describe("series, funnel and batches", () => {
  const rows = [
    { kind: "call", createdAt: day(-0.2) },
    { kind: "call", createdAt: day(-1) },
    { kind: "email_sent", createdAt: day(-2) },
    { kind: "note", createdAt: day(-3) },
    { kind: "call", createdAt: day(-9) },
    { kind: "lead_captured", createdAt: day(-1) },
    { kind: "call", createdAt: day(-40) },
  ];

  it("counts touches per day and per week", () => {
    const series = activitySeries(rows, NOW, TZ, 28);
    expect(series.days).toHaveLength(28);
    expect(series.days.at(-1)?.date).toBe("2026-11-07");
    expect(series.days.at(-1)?.call).toBe(1);
    expect(series.days.at(-2)?.call).toBe(1);
    expect(series.days.at(-3)?.email).toBe(1);
    expect(series.thisWeek).toEqual({ call: 2, email: 1, meeting: 0, message: 0, note: 1 });
    expect(series.lastWeek.call).toBe(1);
  });

  it("builds the funnel from lifecycle, touches and deals", () => {
    const out = funnel({
      contacts: [
        { id: "a", name: "A", emails: [], phones: [], lifecycle: "lead" },
        { id: "b", name: "B", emails: [], phones: [], lifecycle: "prospect" },
        { id: "c", name: "C", emails: [], phones: [], lifecycle: "customer" },
        { id: "d", name: "D", emails: [], phones: [], lifecycle: "churned" },
      ],
      deals: [{ id: "d1", title: "x", amountMinor: 0, currency: "ZAR", stageId: "won", contactId: "b", accountId: null }],
      touchedContactIds: new Set(["a", "b"]),
      wonStageIds: new Set(["won"]),
      lostStageIds: new Set(["lost"]),
    });
    expect(out).toEqual({ leads: 3, contacted: 2, prospects: 2, withDeal: 1, won: 2 });
  });

  it("one row per lead batch, newest first", () => {
    const out = batchRows({
      contacts: [
        { id: "a", name: "A", emails: [], phones: [], lifecycle: "lead", tags: ["lead-batch-2026-10-30-b", "triage-keep"], nextActionKind: "call", nextActionDueAt: day(-2) },
        { id: "b", name: "B", emails: [], phones: [], lifecycle: "lead", tags: ["lead-batch-2026-10-30-b"] },
        { id: "c", name: "C", emails: [], phones: [], lifecycle: "lead", tags: ["lead-batch-2026-11-02-b"] },
      ],
      deals: [{ id: "d1", title: "x", amountMinor: 0, currency: "ZAR", stageId: "open", contactId: "a", accountId: null }],
      activities: [
        { id: "1", recordType: "contact", recordId: "a", kind: "call", body: "", createdAt: day(-1) },
        { id: "2", recordType: "contact", recordId: "b", kind: "email_received", body: "", createdAt: day(-1) },
      ],
      now: NOW,
      timezone: TZ,
    });
    expect(out).toEqual([
      { tag: "lead-batch-2026-11-02-b", contacts: 1, called: 0, replied: 0, deals: 0, overdue: 0 },
      { tag: "lead-batch-2026-10-30-b", contacts: 2, called: 1, replied: 1, deals: 1, overdue: 1 },
    ]);
  });
});

describe("call and email links", () => {
  it("tel: links keep the country code and turn SA local numbers into +27", () => {
    expect(telHref("+27 82 123 4567")).toBe("tel:+27821234567");
    expect(telHref("082 123 4567")).toBe("tel:+27821234567");
    expect(telHref("(813) 526-2712")).toBe("tel:8135262712");
    expect(telHref("0027821234567")).toBe("tel:+27821234567");
    expect(telHref("none")).toBeNull();
    expect(telHref("")).toBeNull();
    expect(telHref(null)).toBeNull();
  });

  it("the Mailbox compose link carries the address and an optional subject", () => {
    expect(composeHref("ada@acme.test")).toBe("/mailbox?compose=1&to=ada%40acme.test");
    expect(composeHref("ada@acme.test", "Your site")).toBe("/mailbox?compose=1&to=ada%40acme.test&subject=Your+site");
    expect(composeHref("not an email")).toBeNull();
    expect(composeHref("")).toBeNull();
  });
});
