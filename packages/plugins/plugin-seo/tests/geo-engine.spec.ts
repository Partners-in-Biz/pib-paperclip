import { describe, expect, it } from "vitest";
import { runGeoAudit } from "../src/checks/geo.js";
import {
  AI_ENGINES,
  blockedSearchBots,
  compactGeo,
  geoChange,
  geoLine,
  geoSnapshot,
  latestSamples,
  MAX_SAMPLES_PER_CALL,
  mentionStats,
  mentionTrend,
  parseMentionSamples,
  queryKey,
  suggestAiQueries,
  type StoredGeoAudit,
  type StoredMention,
} from "../src/engine/geo.js";
import { GOOD_HOME, site } from "./helpers/geo-site.js";

const CTX = { today: "2026-10-03", siteHost: "acme.co.za" };

describe("sampled AI answers: what is accepted", () => {
  const good = { query: "Best accountant in Durban?", engine: "search_tool", mentioned: true, evidence: "…Acme Accounting in Umhlanga is often recommended…", competitors: ["Rival & Co", "Rival & Co", " "], method: "web search tool" };

  it("takes a sample with its evidence, trimmed and de-duplicated, dated today by default", () => {
    const { samples, errors } = parseMentionSamples([good], CTX);
    expect(errors).toEqual([]);
    expect(samples[0]).toMatchObject({ query: "Best accountant in Durban?", engine: "search_tool", sampledOn: "2026-10-03", mentioned: true, cited: false, position: null, competitors: ["Rival & Co"], method: "web search tool" });
  });

  it("refuses a mention or a citation nobody can check", () => {
    const { samples, errors } = parseMentionSamples([
      { query: "best accountant in durban", engine: "chatgpt", mentioned: true },
      { query: "vat returns durban", engine: "perplexity", mentioned: false, cited: true, citedUrls: ["https://other.com/acme"] },
      { query: "vat returns durban", engine: "perplexity", mentioned: false, cited: true, citedUrls: ["https://www.acme.co.za/vat"] },
    ], CTX);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/Sample 1: a mention or citation needs evidence/);
    expect(errors[1]).toMatch(/Sample 2: cited is true but none of citedUrls is a page on acme\.co\.za/);
    // The one with a source on the site is accepted: a citation proves itself.
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ mentioned: false, cited: true, citedUrls: ["https://www.acme.co.za/vat"] });
  });

  it("accepts an answer that did not name the business without evidence", () => {
    const { samples, errors } = parseMentionSamples([{ query: "who does vat in durban", engine: "gemini", mentioned: false, competitors: ["Tax Hub"] }], CTX);
    expect(errors).toEqual([]);
    expect(samples[0]).toMatchObject({ mentioned: false, cited: false, evidence: null, competitors: ["Tax Hub"] });
  });

  it("names every problem with the sample it belongs to", () => {
    const { samples, errors } = parseMentionSamples([
      null,
      { engine: "chatgpt", mentioned: false },
      { query: "ok question", engine: "alexa", mentioned: false },
      { query: "ok question", engine: "chatgpt" },
      { query: "ok question", engine: "chatgpt", mentioned: false, sampledOn: "2026-13-45" },
      { query: "ok question", engine: "chatgpt", mentioned: false, sampledOn: "2026-10-04" },
      { query: "ok question", engine: "chatgpt", mentioned: false, sampledOn: "2026-09-30", position: 3 },
    ], CTX);
    expect(errors).toEqual([
      "Sample 1 is not an object",
      expect.stringContaining("Sample 2: query is required"),
      expect.stringContaining("Sample 3: engine must be one of"),
      expect.stringContaining("Sample 4: mentioned must be true or false"),
      expect.stringContaining("Sample 5: sampledOn must be a date like"),
      "Sample 6: sampledOn is in the future",
    ]);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ sampledOn: "2026-09-30", position: 3 });
    expect(AI_ENGINES).toContain("search_tool");
  });

  it("needs a list, and takes at most one call's worth", () => {
    expect(parseMentionSamples("nope", CTX).errors[0]).toMatch(/at least one sampled answer/);
    expect(parseMentionSamples([], CTX).samples).toEqual([]);
    const many = Array.from({ length: MAX_SAMPLES_PER_CALL + 3 }, (_, i) => ({ query: `question number ${i}`, engine: "claude", mentioned: false }));
    const { samples, errors } = parseMentionSamples(many, CTX);
    expect(samples).toHaveLength(MAX_SAMPLES_PER_CALL);
    expect(errors[0]).toMatch(/At most 40 samples per call \(got 43\)/);
  });

  it("normalises a question so the same one is the same row", () => {
    expect(queryKey("  Best   Accountant IN Durban ")).toBe("best accountant in durban");
  });
});

describe("the rate of being named", () => {
  const row = (query: string, engine: string, sampledOn: string, mentioned: boolean, extra: Partial<StoredMention> = {}): StoredMention => ({ query, engine, sampledOn, mentioned, cited: false, competitors: [], ...extra });

  it("counts the latest answer per question and assistant, so asking again replaces and does not add", () => {
    const rows = [
      row("best accountant", "chatgpt", "2026-09-10", false, { competitors: ["Rival"] }),
      row("best accountant", "chatgpt", "2026-10-01", true),
      row("Best  Accountant", "perplexity", "2026-10-01", false, { competitors: ["Rival", "Tax Hub"] }),
      row("vat returns", "chatgpt", "2026-10-01", false, { cited: true }),
      row("payroll durban", "chatgpt", "2026-10-02", false, { competitors: ["Rival"] }),
    ];
    expect(latestSamples(rows)).toHaveLength(4);
    const stats = mentionStats(rows);
    expect(stats).toMatchObject({ sampled: 4, questions: 3, mentioned: 1, cited: 1, visible: 2, rate: 0.5, lastSampledOn: "2026-10-02" });
    expect(stats.byEngine).toEqual({ chatgpt: { sampled: 3, visible: 2 }, perplexity: { sampled: 1, visible: 0 } });
    // The 10 September answer was replaced by the 1 October one, so only the later answer's competitors count.
    expect(stats.topCompetitors).toEqual([{ name: "Rival", count: 2 }, { name: "Tax Hub", count: 1 }]);
    expect(mentionStats([])).toMatchObject({ sampled: 0, rate: null, lastSampledOn: null });
  });

  it("compares the first sampling day with the latest, and needs three samples on each to say anything", () => {
    const baseline = ["a", "b", "c", "d"].map((q) => row(q, "chatgpt", "2026-09-10", false));
    const later = ["a", "b", "c", "d"].map((q, i) => row(q, "chatgpt", "2026-10-02", i < 2));
    const trend = mentionTrend([...baseline, ...later]);
    expect(trend.baseline).toEqual({ on: "2026-09-10", sampled: 4, rate: 0 });
    expect(trend.latest).toEqual({ on: "2026-10-02", sampled: 4, rate: 0.5 });
    expect(trend.changePoints).toBe(50);
    // One day only: nothing to compare. Two samples on a day: not enough to rate.
    expect(mentionTrend(baseline)).toMatchObject({ latest: null, changePoints: null });
    expect(mentionTrend([...baseline, row("a", "chatgpt", "2026-10-02", true), row("b", "chatgpt", "2026-10-02", true)]).latest).toBeNull();
  });

  it("suggests the sprint's priority keywords first and the business's own name last, never the brand keywords twice", () => {
    const queries = suggestAiQueries({
      siteName: "Acme Accounting",
      keywords: [
        { phrase: "acme accounting login", isPriority: true, intent: "brand" },
        { phrase: "vat returns durban", isPriority: true, intent: "solution" },
        { phrase: "best accountant durban", isPriority: false, intent: "solution" },
        { phrase: "how to register for vat", isPriority: false, intent: "problem" },
        { phrase: "acme accounting reviews", isPriority: false, intent: "brand" },
      ],
    });
    expect(queries.slice(0, 3)).toEqual(["vat returns durban", "best accountant durban", "how to register for vat"]);
    expect(queries).toContain("Acme Accounting reviews");
    expect(queries.filter((q) => /acme accounting login/i.test(q))).toEqual([]);
    expect(queries.length).toBeLessThanOrEqual(10);
  });
});

describe("the stored audit", () => {
  it("keeps the evidence behind each section and the blocked search bots", async () => {
    const { fetcher } = site({
      "https://acme.co.za/robots.txt": () => ({ status: 200, url: "", redirects: [], headers: {}, text: "User-agent: PerplexityBot\nDisallow: /\n\nUser-agent: GPTBot\nDisallow: /\n", ms: 1 }),
    });
    const result = await runGeoAudit(fetcher, { siteUrl: "https://acme.co.za", needsAddress: true, brandNames: ["Acme Accounting"] });
    const sections = compactGeo(result);
    expect(sections.crawlers.find((c) => c.token === "PerplexityBot")).toEqual({ token: "PerplexityBot", kind: "search", state: "blocked", via: "own-rule" });
    expect(sections.llms).toMatchObject({ quality: "good" });
    expect(sections.entity).toMatchObject({ found: true, score: 100, missing: [] });
    expect(sections.answers.checked).toBe(3);
    // Training bots blocked is the client's choice; only the search bot counts as blocked.
    expect(blockedSearchBots(sections)).toEqual(["PerplexityBot"]);
    expect(blockedSearchBots(null)).toEqual([]);
    expect(JSON.stringify(sections).length).toBeLessThan(6_000);
  });

  it("keeps the kind of each probed bot, and never names a refused training crawler as blocked AI search", async () => {
    const refusing = (ua: string) => (/PerplexityBot|GPTBot|ClaudeBot/.test(ua) ? { status: 403, url: "", redirects: [], headers: {}, text: "Forbidden", ms: 1 } : { status: 200, url: "https://acme.co.za/", redirects: [], headers: {}, text: GOOD_HOME, ms: 1 });
    const { fetcher } = site({ "https://acme.co.za/": refusing });
    const result = await runGeoAudit(fetcher, { siteUrl: "https://acme.co.za", needsAddress: true, brandNames: ["Acme Accounting"] });
    const sections = compactGeo(result);
    expect(sections.serverProbes.map((p) => [p.token, p.kind, p.blocked]).sort()).toEqual([["Claude-SearchBot", "search", false], ["ClaudeBot", "training", true], ["GPTBot", "training", true], ["OAI-SearchBot", "search", false], ["PerplexityBot", "search", true]]);
    // The red "AI search is blocked" line, the weekly numbers and the change note name the search bot only.
    expect(blockedSearchBots(sections)).toEqual(["PerplexityBot"]);
    const training = { serverProbes: [{ token: "GPTBot", kind: "training" as const, status: 403, blocked: true }, { token: "ClaudeBot", kind: "training" as const, status: 403, blocked: true }] };
    expect(blockedSearchBots(training)).toEqual([]);
    // Rows stored before the kind was kept are looked up by the bot's name; an unknown bot is not AI search.
    expect(blockedSearchBots({ serverProbes: [{ token: "GPTBot", status: 403, blocked: true }, { token: "OAI-SearchBot", status: 403, blocked: true }, { token: "SomeNewBot", status: 403, blocked: true }] as never })).toEqual(["OAI-SearchBot"]);
    const audit = (probes: unknown): Pick<StoredGeoAudit, "score" | "sections"> => ({ score: 70, sections: { serverProbes: probes } as never });
    expect(geoChange(audit([]), audit(training.serverProbes)).newlyBlocked).toEqual([]);
  });

  it("notes what changed since the last audit: the score, a search bot newly blocked, one reopened", () => {
    const audit = (score: number, blocked: string[]): Pick<StoredGeoAudit, "score" | "sections"> => ({ score, sections: { crawlers: blocked.map((token) => ({ token, kind: "search" as const, state: "blocked" as const, via: "own-rule" as const })) } });
    expect(geoChange(audit(70, ["PerplexityBot"]), audit(55, ["PerplexityBot", "OAI-SearchBot"]))).toEqual({ scoreDelta: -15, newlyBlocked: ["OAI-SearchBot"], reopened: [] });
    expect(geoChange(audit(55, ["OAI-SearchBot"]), audit(75, []))).toEqual({ scoreDelta: 20, newlyBlocked: [], reopened: ["OAI-SearchBot"] });
    expect(geoChange(null, audit(60, ["PerplexityBot"]))).toEqual({ scoreDelta: null, newlyBlocked: [], reopened: [] });
  });

  it("summarises for a snapshot and for a person, saying what is not known yet", () => {
    const stats = mentionStats([{ query: "q1", engine: "chatgpt", sampledOn: "2026-10-01", mentioned: true, cited: false, competitors: [] }, { query: "q2", engine: "chatgpt", sampledOn: "2026-10-01", mentioned: false, cited: false, competitors: [] }]);
    const audit: StoredGeoAudit = { id: "g1", auditedOn: "2026-10-02", score: 72, band: "good", complete: true, breakdown: { crawlers: { earned: 30, possible: 30, evaluated: true } } as never, sections: { llms: { quality: "missing", links: 0, problems: [] }, crawlers: [{ token: "PerplexityBot", kind: "search", state: "blocked", via: "own-rule" }] } };
    const snapshot = geoSnapshot(audit, stats);
    expect(snapshot).toMatchObject({ score: 72, band: "good", checkedOn: "2026-10-02", llms: "missing", blockedSearchBots: ["PerplexityBot"], mentions: { sampled: 2, visible: 1, rate: 0.5 } });
    expect(geoLine(snapshot)).toBe("AI-search readiness 72/100 (good); the business appeared in 1 of 2 sampled AI answers; blocked: PerplexityBot");
    const none = geoSnapshot(null, mentionStats([]));
    expect(none).toMatchObject({ score: null, mentions: null, blockedSearchBots: [] });
    expect(geoLine(none)).toBe("AI-search readiness not checked yet");
    expect(geoLine({ ...snapshot, complete: false, mentions: null, blockedSearchBots: [] })).toContain("partly checked");
  });
});
