import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { movedTabTarget, tabFromSearch } from "../src/ui/index.js";
import {
  DEFAULT_FILTERS,
  EMPTY_DRAFT,
  NEW_CLIENT,
  actionErrorText,
  addParams,
  attentionCount,
  briefTitle,
  cleanFactText,
  clientResolution,
  compareBrief,
  coverageLines,
  editDraft,
  editParams,
  factActions,
  filtersActive,
  formatLatency,
  installationIdFromUiBase,
  listParams,
  lowCoverage,
  originOf,
  pageCount,
  pageLabel,
  scopeInfo,
  settingsPath,
  shortDate,
  sourcePath,
  textCheck,
  type BriefRow,
  type MemoryFact,
  type MemoryOverview,
  type MemoryReview,
  type MemoryStats,
} from "../src/ui/memory-model.js";
import { AttentionList, BriefDetail, BriefsList, FactsTable, MemoryHeader, PreviewResult } from "../src/ui/memory-parts.js";

const NOW = new Date("2026-09-27T10:00:00.000Z");
const linkFor = (href: string) => ({ href: `/PIB${href}` });
const LIMITS = { factMaxChars: 300, factMinChars: 12, briefMaxFacts: 12, briefMaxTokens: 1500, pinnedMaxPerScope: 5, searchMaxResults: 10, scopeActiveCap: 120 };
const CLIENTS = [{ clientRef: "company:nw1", clientName: "Northwind" }];
const AGENTS = [{ id: "agent-sam", name: "Sam", urlKey: "sam" }, { id: "agent-olive", name: "Olive", urlKey: null }];
const noop = () => undefined;

function fact(id: string, extra: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id,
    companyId: "co",
    clientRef: "company:nw1",
    clientName: "Northwind",
    area: "social",
    kind: "preference",
    text: `Fact ${id}: Northwind wants LinkedIn posts without emojis.`,
    pinned: false,
    status: "active",
    supersedes: null,
    supersededBy: null,
    sourceIssueId: "issue-12",
    sourceIdentifier: "PIB-12",
    sourceCommentId: null,
    origin: "tool",
    createdByAgentId: "agent-sam",
    createdByUserId: null,
    expiresAt: null,
    useCount: 4,
    lastUsedAt: "2026-09-26T10:00:00.000Z",
    helpfulCount: 2,
    noiseCount: 0,
    createdAt: "2026-09-20T10:00:00.000Z",
    updatedAt: "2026-09-25T10:00:00.000Z",
    ...extra,
  } as MemoryFact;
}

function stats(extra: Partial<MemoryStats> = {}): MemoryStats {
  return {
    facts: { active: 42, pinned: 3, superseded: 5, archived: 7, clients: 6 },
    byArea: { social: 20, seo: 22 },
    briefs7d: { total: 20, jev: 15, baseline: 4, empty: 1, avgFacts: 5.3, avgTokens: 620, avgLatencyMs: 1400, issues: 12 },
    feedback30d: { missing: 3, noise: 5, wrong: 0, missingInBaseline: 1, missingNotInBaseline: 2, briefsWithFeedback: 4 },
    added7d: 12,
    harvested7d: 8,
    ...extra,
  } as MemoryStats;
}

function overview(extra: Partial<MemoryOverview> = {}): MemoryOverview {
  return {
    stats: stats(),
    coverage: [{ agentId: "agent-sam", runs: 10, withBrief: 9 }, { agentId: "agent-olive", runs: 8, withBrief: 2 }],
    briefs: [],
    jevConfigured: true,
    clients: CLIENTS,
    areas: ["seo", "social", "general"],
    kinds: ["fact", "preference", "rule", "lesson", "warning"],
    limits: LIMITS,
    ...extra,
  };
}

function brief(extra: Partial<BriefRow> = {}): BriefRow {
  return {
    id: "b123",
    companyId: "co",
    issueId: "issue-23",
    issueIdentifier: "PIB-23",
    agentId: "agent-sam",
    runId: "run-1",
    query: null,
    clientRefs: ["company:nw1"],
    area: "social",
    method: "jev",
    model: "jev-1",
    version: "v1",
    totalFacts: 42,
    candidateCount: 30,
    factIds: ["m1", "m2"],
    baselineIds: ["m2", "m3"],
    scores: { m1: 0.91, m2: 0.4 },
    tokens: 180,
    jevInputTokens: 900,
    latencyMs: 1200,
    factsVersion: "1:1:x",
    body: "Memory brief for PIB-23 (2 of 42 facts, picked by Jev; brief b123):\n- [m1] ...",
    createdAt: "2026-09-27T07:00:00.000Z",
    ...extra,
  };
}

describe("memory page helpers", () => {
  it("reads the message of a failed action (the host rejects with a plain object)", () => {
    expect(actionErrorText({ code: "WORKER_ERROR", message: "This client and area already has 5 pinned rules. Unpin one first." })).toBe("This client and area already has 5 pinned rules. Unpin one first.");
    expect(actionErrorText(new Error("Boom"))).toBe("Boom");
    expect(actionErrorText({ error: "Plugin not found" })).toBe("Plugin not found");
    expect(actionErrorText("plain")).toBe("plain");
    expect(actionErrorText(null)).toBe("Request failed");
  });

  it("builds list params, paging and the row actions", () => {
    expect(listParams(DEFAULT_FILTERS, 0)).toEqual({ status: "active", limit: 25, offset: 0 });
    expect(listParams({ status: "all", client: "own", area: "seo", pinned: true, q: "  tone " }, 2)).toEqual({ status: "all", client: "own", area: "seo", pinned: true, q: "tone", limit: 25, offset: 50 });
    expect(filtersActive(DEFAULT_FILTERS)).toBe(false);
    expect(filtersActive({ ...DEFAULT_FILTERS, q: "x" })).toBe(true);
    expect(pageCount(0)).toBe(1);
    expect(pageCount(51)).toBe(3);
    expect(pageLabel(230, 1)).toBe("26–50 of 230");
    expect(pageLabel(0, 0)).toBe("0 facts");
    expect(factActions({ status: "active", pinned: false, kind: "rule" })).toEqual(["edit", "pin", "archive", "supersede"]);
    expect(factActions({ status: "active", pinned: false, kind: "fact" })).toEqual(["edit", "archive", "supersede"]);
    expect(factActions({ status: "active", pinned: true, kind: "rule" })).toEqual(["edit", "unpin", "archive", "supersede"]);
    expect(factActions({ status: "archived", pinned: false, kind: "fact" })).toEqual(["edit", "restore"]);
    expect(factActions({ status: "superseded", pinned: false, kind: "fact" })).toEqual(["edit", "restore"]);
  });

  it("counts characters the way the Cockpit stores the text", () => {
    expect(cleanFactText("- Northwind\n  wants   short posts ")).toBe("Northwind wants short posts");
    expect(textCheck("too short", LIMITS)).toMatchObject({ ok: false, tone: "neutral" });
    expect(textCheck("x".repeat(301), LIMITS)).toMatchObject({ ok: false, tone: "bad", length: 301 });
    expect(textCheck("x".repeat(280), LIMITS)).toMatchObject({ ok: true, tone: "warn" });
    expect(textCheck("A perfectly normal fact.", LIMITS)).toMatchObject({ ok: true, tone: "neutral" });
  });

  it("builds add params: company-wide, known or new clients, pinning only for rules and warnings", () => {
    expect(addParams({ ...EMPTY_DRAFT, text: "Always CC the account manager." })).toEqual({ params: { text: "Always CC the account manager.", area: "general", kind: "fact", client: "own" } });
    expect(addParams({ ...EMPTY_DRAFT, text: "t", client: "company:nw1", kind: "rule", pinned: true, expires: "2026-12-31" })).toEqual({ params: { text: "t", area: "general", kind: "rule", client: "company:nw1", pinned: true, expiresAt: "2026-12-31" } });
    expect(addParams({ ...EMPTY_DRAFT, text: "t", kind: "fact", pinned: true })).toEqual({ params: { text: "t", area: "general", kind: "fact", client: "own" } });
    expect(addParams({ ...EMPTY_DRAFT, text: "t", client: NEW_CLIENT, newRef: "northwind", newName: "Northwind" })).toHaveProperty("error");
    expect(addParams({ ...EMPTY_DRAFT, text: "t", client: NEW_CLIENT, newRef: "contact:c9", newName: " " })).toHaveProperty("error");
    expect(addParams({ ...EMPTY_DRAFT, text: "t", client: NEW_CLIENT, newRef: " contact:c9 ", newName: "Jo Soap" })).toEqual({ params: { text: "t", area: "general", kind: "fact", client: "contact:c9", clientName: "Jo Soap" } });
  });

  it("sends only what an edit changed, and unpins a fact that stops being a rule", () => {
    const pinned = fact("m1", { kind: "rule", pinned: true, expiresAt: "2026-12-31T00:00:00.000Z" });
    expect(editParams(pinned, editDraft(pinned))).toBeNull();
    expect(editDraft(pinned).expires).toBe("2026-12-31");
    expect(editParams(pinned, { ...editDraft(pinned), kind: "fact" })).toEqual({ id: "m1", kind: "fact", pinned: false });
    expect(editParams(pinned, { ...editDraft(pinned), expires: "" })).toEqual({ id: "m1", expiresAt: null });
    expect(editParams(pinned, { ...editDraft(pinned), text: `  ${pinned.text}  ` })).toBeNull();
    expect(editParams(pinned, { ...editDraft(pinned), text: "New wording for the rule.", area: "seo" })).toEqual({ id: "m1", text: "New wording for the rule.", area: "seo" });
  });

  it("compares a Jev brief with the keyword baseline", () => {
    const cmp = compareBrief(brief(), [fact("m1"), fact("m2"), fact("m3")]);
    expect(cmp.included.map((l) => [l.id, l.score, l.inBaseline])).toEqual([["m1", 0.91, false], ["m2", 0.4, true]]);
    expect(cmp.baselineOnly.map((l) => l.id)).toEqual(["m3"]);
    expect(cmp).toMatchObject({ agreed: 1, same: false });
    expect(compareBrief(brief({ factIds: ["m2", "m1"], baselineIds: ["m1", "m2"] }), []).same).toBe(true);
  });

  it("names agents, clients, scopes, sources and the settings page", () => {
    expect(lowCoverage({ runs: 8, withBrief: 2 })).toBe(true);
    expect(lowCoverage({ runs: 2, withBrief: 0 })).toBe(false);
    expect(coverageLines([{ agentId: "agent-sam", runs: 10, withBrief: 9 }, { agentId: "agent-olive", runs: 8, withBrief: 2 }, { agentId: "agent-x1234567890", runs: 0, withBrief: 0 }], AGENTS))
      .toEqual([
        { agentId: "agent-olive", name: "Olive", href: "/agents/agent-olive", runs: 8, withBrief: 2, low: true },
        { agentId: "agent-sam", name: "Sam", href: "/agents/sam", runs: 10, withBrief: 9, low: false },
      ]);
    expect(scopeInfo("*|seo", CLIENTS)).toEqual({ clientRef: null, area: "seo", label: "Company-wide · SEO" });
    expect(scopeInfo("company:nw1|social", CLIENTS).label).toBe("Northwind · Social");
    expect(clientResolution({ refs: ["company:nw1"], names: ["Northwind"], how: "named" })).toBe("Northwind (named in the task)");
    expect(clientResolution({ refs: [], names: [], how: "none" })).toBe("No client found: company-wide facts only");
    expect(sourcePath(fact("m1", { origin: "harvest", sourceCommentId: "c77" }))).toBe("/issues/PIB-12#comment-c77");
    expect(sourcePath(fact("m1", { sourceIdentifier: null, sourceIssueId: null }))).toBeNull();
    expect(originOf(fact("m1", { origin: undefined as never, createdByAgentId: null, createdByUserId: "u1" }))).toBe("person");
    expect(settingsPath(installationIdFromUiBase("/_plugins/0b8e2f7a-1111-4222-8333-444455556666/ui/"))).toBe("/company/settings/instance/plugins/0b8e2f7a-1111-4222-8333-444455556666");
    expect(settingsPath(null)).toBe("/company/settings/instance/plugins");
    expect(briefTitle({ id: "b1", issueIdentifier: "PIB-23", query: null, method: "jev" })).toBe("Brief for PIB-23");
    expect(briefTitle({ id: "s1", issueIdentifier: null, query: "Northwind hosting", method: "search" })).toBe("Search: “Northwind hosting”");
    expect(formatLatency(850)).toBe("850 ms");
    expect(formatLatency(1400)).toBe("1.4 s");
    expect(formatLatency(0)).toBe("–");
    expect(shortDate("2026-12-31T00:00:00.000Z")).toBe("31 Dec 2026");
  });

  it("opens the Memory tab from ?tab=memory", () => {
    expect(tabFromSearch("?tab=memory")).toBe("memory");
    expect(tabFromSearch("?tab=nope")).toBe("overview");
    expect(tabFromSearch("")).toBe("overview");
  });

  it("sends the old ?tab=team to Setup → Team (the Cockpit has no Team tab)", () => {
    expect(tabFromSearch("?tab=team")).toBe("overview");
    expect(movedTabTarget("?tab=team")).toBe("/setup?section=team");
    expect(movedTabTarget("?tab=memory")).toBeNull();
    expect(movedTabTarget("")).toBeNull();
    expect(movedTabTarget(null)).toBeNull();
  });
});

describe("memory tab sections", () => {
  it("shows the header stats, the Learned line, agent coverage and the smart matching note, in plain words", () => {
    const html = renderToStaticMarkup(createElement(MemoryHeader, { overview: overview({ jevConfigured: false }), agents: AGENTS, linkFor, settingsHref: "/company/settings/instance/plugins/abc" }));
    for (const text of ["Company memory", "Memory is what your agents learn", "the facts it needs: at most 12.", "Learned:", "you can do the same on any issue", "Active facts", "42", "3 pinned · 7 archived", "Added this week", "8 from Learned lines", "Clients covered", "Briefs this week", "75% by smart matching", "5.3 facts", "At most 12 per task", "Feedback, 30 days", "3 missing · 5 not helpful", "Smart matching (optional)", "briefs now pick facts by keywords", "Agents asking memory first", "Olive 2/8", "Sam 9/10", "1 agent skips it"]) {
      expect(html, text).toContain(text);
    }
    // No internal names or engineering units on screen.
    for (const jargon of ["Jev", "TypeSafe", "tokens", " ms", "full scope"]) expect(html, jargon).not.toContain(jargon);
    expect(html).toContain('href="/PIB/company/settings/instance/plugins/abc"');
    expect(html).toContain('href="/PIB/agents/sam"');
    expect(html.indexOf("Olive 2/8")).toBeLessThan(html.indexOf("Sam 9/10"));
    expect(renderToStaticMarkup(createElement(MemoryHeader, { overview: overview(), agents: AGENTS, linkFor, settingsHref: "/x" }))).not.toContain("briefs now pick facts by keywords");
  });

  it("lists facts with client, area, kind, pin, use, feedback, source and the right buttons", () => {
    const facts = [
      fact("m1", { kind: "rule", pinned: true, text: "Never post to Northwind's LinkedIn on Sundays." }),
      fact("m2", { kind: "warning", noiseCount: 4, helpfulCount: 1, origin: "harvest", sourceCommentId: "c9" }),
      fact("m3", { status: "superseded", supersededBy: "m1", clientRef: null, clientName: null, origin: "person", createdByAgentId: null, createdByUserId: "u1", sourceIssueId: null, sourceIdentifier: null }),
      fact("m4", { expiresAt: "2026-12-31T00:00:00.000Z" }),
    ];
    const html = renderToStaticMarkup(createElement(FactsTable, { facts, clients: CLIENTS, agents: AGENTS, linkFor, busyId: null, handlers: { onEdit: noop, onPin: noop, onStatus: noop, onSupersede: noop }, now: NOW }));
    for (const text of ["Never post to Northwind&#x27;s LinkedIn on Sundays.", "Northwind", "Company-wide", "Social", "Rule", "Warning", "Pinned", "Used 4×", "2 helpful · 0 not helpful", "1 helpful · 4 not helpful", "Saved from comment", "Agent", "Person", "by Sam", "Replaced by a newer fact", "Expires 31 Dec 2026", "Unpin", "Pin", "Archive", "Restore", "Replaced by…", "Edit"]) {
      expect(html, text).toContain(text);
    }
    // Fact ids are technical: not on the rows (they sit under Details in the edit dialog).
    expect(html).not.toContain("<code");
    expect(html).not.toContain("Superseded by m1");
    expect(html).toContain('href="/PIB/issues/PIB-12"');
    expect(html).toContain('href="/PIB/issues/PIB-12#comment-c9"');
    // Wide tables sit in a horizontal scroller.
    expect(html).toContain("overflow-x:auto");
    expect(html.match(/min-width:\s?\d{4,}px/g)).toEqual(["min-width:1000px"]);
  });

  it("lists recent briefs and explains an empty list", () => {
    expect(renderToStaticMarkup(createElement(BriefsList, { briefs: [], agents: AGENTS, linkFor, onOpen: noop, now: NOW }))).toContain("No briefs yet");
    const html = renderToStaticMarkup(createElement(BriefsList, {
      briefs: [
        { id: "b1", issueId: "issue-23", issueIdentifier: "PIB-23", agentId: "agent-sam", query: null, method: "jev", facts: 5, baseline: 6, totalFacts: 120, tokens: 620, latencyMs: 1200, createdAt: "2026-09-27T07:00:00.000Z" },
        { id: "b2", issueId: null, issueIdentifier: null, agentId: "agent-olive", query: "Northwind hosting", method: "baseline", facts: 0, baseline: 0, totalFacts: 120, tokens: 0, latencyMs: 300, createdAt: "2026-09-27T09:00:00.000Z" },
      ],
      agents: AGENTS,
      linkFor,
      onOpen: noop,
      now: NOW,
    }));
    for (const text of ["PIB-23", "Sam", "Smart matching", "5 of 120", "3h ago", "“Northwind hosting”", "Keywords", "View"]) expect(html, text).toContain(text);
    for (const jargon of ["Jev", "~620", "1.2 s", "300 ms", "Tokens", "Took"]) expect(html, jargon).not.toContain(jargon);
    expect(html).toContain('href="/PIB/issues/PIB-23"');
  });

  it("shows a brief's facts and what the keyword baseline would have picked", () => {
    const html = renderToStaticMarkup(createElement(BriefDetail, { brief: brief(), facts: [fact("m1"), fact("m2"), fact("m3", { status: "archived" })], clients: CLIENTS, agents: AGENTS, linkFor, now: NOW }));
    for (const text of ["In the brief (2)", "91% match", "Smart matching only", "Keywords too", "What keyword matching would have picked", "1 of the smart picks, plus 1 it left out:", "Keywords only", "Archived now", "What the agent read", "Memory brief for PIB-23"]) {
      expect(html, text).toContain(text);
    }
    // The brief's and facts' ids sit under Details.
    expect(html).toMatch(/<summary[^>]*>Details<\/summary><code[^>]*>Brief: b123\nFacts: m1, m2/);
    const same = renderToStaticMarkup(createElement(BriefDetail, { brief: brief({ baselineIds: ["m1", "m2"] }), facts: [fact("m1"), fact("m2")], clients: CLIENTS, agents: AGENTS, linkFor, now: NOW }));
    expect(same).toContain("The same facts.");
  });

  it("shows a preview exactly as the agent gets it", () => {
    const html = renderToStaticMarkup(createElement(PreviewResult, {
      result: {
        briefId: "b9",
        body: "Memory brief for PIB-23 (1 of 42 facts, picked by Jev; brief b9):\n- [m1] (Northwind · social · rule · pinned) Never post on Sundays.",
        method: "jev",
        cached: false,
        issue: { id: "issue-23", identifier: "PIB-23", title: "Write Northwind's October posts" },
        client: { refs: ["company:nw1"], names: ["Northwind"], how: "named" },
        area: "social",
        totalFacts: 42,
        candidateCount: 30,
        tokens: 40,
        facts: [{ id: "m1", text: "Never post on Sundays.", clientName: "Northwind", clientRef: "company:nw1", area: "social", kind: "rule", pinned: true, score: null, inBaseline: true }],
      },
      clients: CLIENTS,
      linkFor,
    }));
    for (const text of ["1 of 42 facts", "Northwind (named in the task)", "Write Northwind&#x27;s October posts", "Never post on Sundays.", "Keywords too", "What the agent reads", "(Northwind · social · rule · pinned) Never post on Sundays."]) expect(html, text).toContain(text);
    for (const jargon of ["~40 tokens", "30 candidates"]) expect(html, jargon).not.toContain(jargon);
  });

  it("lists what needs attention with one-click fixes", () => {
    const review = {
      stats: stats(),
      coverage: [],
      agentsSkippingMemory: [{ agentId: "agent-olive", runs: 8, withBrief: 2 }],
      duplicates: [{ a: "m1", b: "m2", aText: "Northwind wants no emojis.", bText: "No emojis for Northwind.", overlap: 0.86 }],
      noisy: [{ id: "m5", text: "The blog uses WordPress.", noise: 4, helpful: 1 }],
      staleCount: 3,
      staleExamples: [],
      overCap: [{ scope: "*|seo", active: 134 }],
      misfiled: [{ id: "m7", text: "Brightside Dental wants invoices on the 1st.", area: "billing" as const, kind: "fact" as const, clientRef: "company:bs1", clientName: "Brightside Dental", suggestion: "memory-add …" }],
      skillCandidates: [],
      feedbackSignal: { briefs: 20, withFeedback: 4, coverage: 0.2, level: "ok" as const, message: "4 of 20 briefs (20%) got feedback in 30 days: enough to read." },
      verdict: "3 missing-fact reports in 30 days: the keyword baseline would have caught 1, missed 2.",
    } as MemoryReview;
    expect(attentionCount(review)).toBe(5);
    const moved: string[] = [];
    const handlers = { onKeep: noop, onArchive: noop, onShowScope: noop, onMove: (fact: { id: string }) => void moved.push(fact.id) };
    const html = renderToStaticMarkup(createElement(AttentionList, { review, clients: CLIENTS, agents: AGENTS, linkFor, limits: LIMITS, busyKey: null, handlers }));
    for (const text of ["the keyword baseline would have caught 1, missed 2.", "3 active facts have not been used in 120 days.", "Likely duplicates (1)", "86% same words", "Keep A", "Keep B", "Facts that do not help (1)", "4 times no help", "Archive", "Agents skipping memory (1)", "Olive", "2 of 8 runs started with a brief", "Too many facts for one client and area (1)", "Company-wide · SEO", "134 of 120", "Show these facts", "Company-wide facts that name a client (1)", "Brightside Dental wants invoices on the 1st.", "Move to Brightside Dental"]) {
      expect(html, text).toContain(text);
    }
    expect(html).not.toContain("Full scopes");
    const clean = renderToStaticMarkup(createElement(AttentionList, { review: { ...review, agentsSkippingMemory: [], duplicates: [], noisy: [], overCap: [], misfiled: [], staleCount: 0 }, clients: CLIENTS, agents: AGENTS, linkFor, limits: LIMITS, busyKey: null, handlers }));
    expect(clean).toContain("Nothing to clean up");
    // A review from an older worker (no misfiled list) still renders.
    const { misfiled: _misfiled, ...older } = review;
    expect(attentionCount(older as MemoryReview)).toBe(4);
  });
});
