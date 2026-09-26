import { describe, expect, it } from "vitest";
import { buildMetricSet, classifyOutcome, hypothesisScore, updateScoreboard } from "../src/engine/measure.js";
import {
  compoundStagnation,
  cwvRegression,
  directorySilence,
  healthScore,
  keywordMisalignment,
  lostKeyword,
  pillarOrphan,
  runDetectors,
  stuckPage,
  unindexedPage,
  zeroImpressionContent,
  type DetectorInput,
} from "../src/loop/detectors.js";
import { proposeHypotheses, rankCandidates } from "../src/loop/hypotheses.js";

function base(overrides: Partial<DetectorInput> = {}): DetectorInput {
  return {
    today: "2026-09-26",
    day: 40,
    week: 6,
    phase: 2,
    gscConnected: true,
    keywords: [],
    history: {},
    content: [],
    backlinks: [],
    pageHealth: [],
    snapshots: [],
    ...overrides,
  };
}

const kw = (id: string, extra: Partial<DetectorInput["keywords"][number]> = {}) => ({
  id,
  phrase: `kw ${id}`,
  targetUrl: `https://acme.co.za/${id}`,
  currentPosition: null,
  impressions: null,
  clicks: null,
  ctr: null,
  ...extra,
});

describe("detectors", () => {
  it("stuck_page: last 3 positions in 8–20 with < 2 improvement", () => {
    const input = base({ keywords: [kw("a"), kw("b")], history: {
      a: [{ on: "2026-09-10", position: 14 }, { on: "2026-09-17", position: 13.5 }, { on: "2026-09-24", position: 13 }],
      b: [{ on: "2026-09-10", position: 18 }, { on: "2026-09-17", position: 14 }, { on: "2026-09-24", position: 11 }],
    } });
    expect(stuckPage(input).map((s) => s.subject)).toEqual(["a"]);
    const outOfBand = base({ keywords: [kw("a")], history: { a: [{ on: "1", position: 21 }, { on: "2", position: 21 }, { on: "3", position: 21 }] } });
    expect(stuckPage(outOfBand)).toHaveLength(0);
    expect(stuckPage({ ...input, gscConnected: false })).toHaveLength(0);
  });

  it("lost_keyword: 5+ worse than the position a week earlier", () => {
    const input = base({ keywords: [kw("a"), kw("b")], history: {
      a: [{ on: "2026-09-10", position: 6 }, { on: "2026-09-16", position: 7 }, { on: "2026-09-25", position: 13 }],
      b: [{ on: "2026-09-20", position: 4 }, { on: "2026-09-25", position: 12 }],
    } });
    const signals = lostKeyword(input);
    expect(signals.map((s) => s.subject)).toEqual(["a"]);
    expect(signals[0]!.evidence).toMatchObject({ previousPosition: 7, currentPosition: 13 });
    expect(signals[0]!.severity).toBe("high");
  });

  it("zero_impression_content: live 14+ days with < 5 impressions", () => {
    const content = [
      { id: "c1", title: "Old", type: "post", status: "live", targetUrl: "u1", publishedOn: "2026-09-01", impressions: 2, linksToPillarIds: [] },
      { id: "c2", title: "New", type: "post", status: "live", targetUrl: "u2", publishedOn: "2026-09-20", impressions: 0, linksToPillarIds: [] },
      { id: "c3", title: "Busy", type: "post", status: "live", targetUrl: "u3", publishedOn: "2026-09-01", impressions: 50, linksToPillarIds: [] },
    ];
    expect(zeroImpressionContent(base({ content })).map((s) => s.subject)).toEqual(["c1"]);
    expect(zeroImpressionContent(base({ content, gscConnected: false }))).toHaveLength(0);
  });

  it("unindexed_page: from week 2, target URL with no positions", () => {
    const input = base({ keywords: [kw("a"), kw("b"), kw("c", { targetUrl: null })], history: { b: [{ on: "2026-09-20", position: 30 }] } });
    expect(unindexedPage(input).map((s) => s.subject)).toEqual(["a"]);
    expect(unindexedPage({ ...input, week: 1 })).toHaveLength(0);
  });

  it("directory_silence: submitted more than 30 days ago", () => {
    const backlinks = [
      { id: "b1", source: "g2", domain: "g2.com", status: "submitted", submittedOn: "2026-08-01" },
      { id: "b2", source: "saashub", domain: "saashub.com", status: "submitted", submittedOn: "2026-09-10" },
      { id: "b3", source: "x", domain: "x.com", status: "live", submittedOn: "2026-07-01" },
    ];
    expect(directorySilence(base({ backlinks })).map((s) => s.subject)).toEqual(["b1"]);
  });

  it("cwv_regression: LCP > 2.5 s or CLS > 0.1, high above 4 s / 0.25", () => {
    const signals = cwvRegression(base({ pageHealth: [
      { url: "a", lcpMs: 3000, cls: 0.05, inpMs: null },
      { url: "b", lcpMs: 1800, cls: 0.3, inpMs: null },
      { url: "c", lcpMs: 2000, cls: 0.02, inpMs: null },
    ] }));
    expect(signals.map((s) => [s.subject, s.severity])).toEqual([["a", "medium"], ["b", "high"]]);
  });

  it("keyword_misalignment: > 100 impressions and CTR < 1%", () => {
    const input = base({ keywords: [kw("a", { impressions: 400, ctr: 0.004 }), kw("b", { impressions: 400, ctr: 0.03 }), kw("c", { impressions: 50, ctr: 0 })] });
    expect(keywordMisalignment(input).map((s) => s.subject)).toEqual(["a"]);
  });

  it("pillar_orphan counts only content linking TO the pillar", () => {
    const pillar = { id: "p", title: "Pillar", type: "pillar", status: "live", targetUrl: "p", publishedOn: "2026-09-01", impressions: 10, linksToPillarIds: [] };
    const post = (id: string, links: string[]) => ({ id, title: id, type: "post", status: "live", targetUrl: id, publishedOn: "2026-09-01", impressions: 10, linksToPillarIds: links });
    expect(pillarOrphan(base({ content: [pillar, post("a", ["p"]), post("b", ["p"]), post("c", [])] })).map((s) => s.subject)).toEqual(["p"]);
    expect(pillarOrphan(base({ content: [pillar, post("a", ["p"]), post("b", ["p"]), post("c", ["p"])] }))).toHaveLength(0);
  });

  it("compound_stagnation: phase 4, 5 snapshots, all changes < 5%", () => {
    const flat = [100, 102, 101, 103, 104].map((impressions, i) => ({ day: i * 30, impressions }));
    expect(compoundStagnation(base({ phase: 4, snapshots: flat }))).toHaveLength(1);
    expect(compoundStagnation(base({ phase: 3, snapshots: flat }))).toHaveLength(0);
    const growing = [100, 130, 170, 220, 300].map((impressions, i) => ({ day: i * 30, impressions }));
    expect(compoundStagnation(base({ phase: 4, snapshots: growing }))).toHaveLength(0);
  });

  it("runs all detectors and scores health", () => {
    const signals = runDetectors(base({ pageHealth: [{ url: "a", lcpMs: 5000, cls: 0, inpMs: null }] }));
    expect(signals).toHaveLength(1);
    expect(healthScore(signals)).toBe(85);
    expect(healthScore([])).toBe(100);
  });
});

describe("hypotheses", () => {
  const stuck = { type: "stuck_page" as const, severity: "medium" as const, subject: "k1", evidence: { keywordId: "k1", keyword: "acme crm", url: "https://acme.co.za/crm" } };
  it("proposes tasks without a week (the current week is set on approval)", () => {
    const [proposal] = proposeHypotheses([stuck]);
    expect(proposal!.hypothesisType).toBe("stuck_page:depth-faq");
    expect(proposal!.targetKeywordIds).toEqual(["k1"]);
    expect(proposal!.tasks[0]).toMatchObject({ taskType: "page-rewrite", owner: "agent", playbook: "opt:page-rewrite" });
    expect(proposal!.tasks[0]).not.toHaveProperty("week");
  });
  it("prefers the hypothesis that won before on this site", () => {
    const [proposal] = proposeHypotheses([stuck], {
      "stuck_page:depth-faq": { wins: 0, losses: 2, noChange: 1, inconclusive: 0 },
      "stuck_page:internal-links": { wins: 2, losses: 0, noChange: 0, inconclusive: 0 },
    });
    expect(proposal!.hypothesisType).toBe("stuck_page:internal-links");
  });
  it("tries an untried hypothesis before repeating a winner (UCB)", () => {
    const [proposal] = proposeHypotheses([stuck], {
      "stuck_page:depth-faq": { wins: 3, losses: 0, noChange: 0, inconclusive: 0 },
    });
    expect(proposal!.hypothesisType).toBe("stuck_page:internal-links");
  });
  it("balances record and exploration once both are tried", () => {
    // depth-faq won 6 of 7; internal-links lost twice: exploit the better record.
    expect(proposeHypotheses([stuck], {
      "stuck_page:depth-faq": { wins: 6, losses: 1, noChange: 0, inconclusive: 0 },
      "stuck_page:internal-links": { wins: 0, losses: 2, noChange: 0, inconclusive: 0 },
    })[0]!.hypothesisType).toBe("stuck_page:depth-faq");
    // After many plays of depth-faq, one lightly tried alternative gets another go.
    expect(proposeHypotheses([stuck], {
      "stuck_page:depth-faq": { wins: 12, losses: 8, noChange: 0, inconclusive: 0 },
      "stuck_page:internal-links": { wins: 0, losses: 0, noChange: 1, inconclusive: 0 },
    })[0]!.hypothesisType).toBe("stuck_page:internal-links");
  });
  it("ranks candidates untried first and keeps the candidate order on ties", () => {
    const candidates = [{ hypothesisType: "x:first" }, { hypothesisType: "x:second" }, { hypothesisType: "x:third" }];
    expect(rankCandidates(candidates, null).map((c) => c.hypothesisType)).toEqual(["x:first", "x:second", "x:third"]);
    expect(rankCandidates(candidates, { "x:first": { wins: 1, losses: 0, noChange: 0, inconclusive: 0 } }).map((c) => c.hypothesisType))
      .toEqual(["x:second", "x:third", "x:first"]);
    // Inconclusive results do not count as tries.
    expect(rankCandidates(candidates, { "x:first": { wins: 0, losses: 0, noChange: 0, inconclusive: 4 } })[0]!.hypothesisType).toBe("x:first");
  });
  it("orders high severity first", () => {
    const cwv = { type: "cwv_regression" as const, severity: "high" as const, subject: "u", evidence: { url: "u", lcpMs: 5000, cls: 0 } };
    expect(proposeHypotheses([stuck, cwv]).map((p) => p.signal.type)).toEqual(["cwv_regression", "stuck_page"]);
  });
});

describe("measurement", () => {
  const set = (avgPosition: number | null, impressions: number, clicks = 0) =>
    buildMetricSet({ keywords: avgPosition == null ? [] : [{ id: "k", position: avgPosition, impressions, clicks }], capturedOn: "2026-09-01", siteTotals: avgPosition == null ? { impressions, clicks, position: null } : null });

  it("wins on +2 positions or +20% impressions", () => {
    expect(classifyOutcome(set(14, 200), set(11.5, 200)).result).toBe("win");
    expect(classifyOutcome(set(14, 200), set(14, 260)).result).toBe("win");
  });
  it("loses on the symmetric worsening", () => {
    expect(classifyOutcome(set(10, 200), set(12.5, 200)).result).toBe("loss");
    expect(classifyOutcome(set(10, 200), set(10, 150)).result).toBe("loss");
  });
  it("reports no change for small moves or disagreeing signals", () => {
    expect(classifyOutcome(set(10, 200), set(9, 220)).result).toBe("no_change");
    const mixed = classifyOutcome(set(14, 200), set(11, 120));
    expect(mixed.result).toBe("no_change");
    expect(mixed.reasons.join(" ")).toMatch(/disagree/);
  });
  it("ignores impression swings on tiny volumes and handles empty data", () => {
    expect(classifyOutcome(set(null, 5), set(null, 9)).result).toBe("no_change");
    expect(classifyOutcome(set(null, 0), set(null, 30)).result).toBe("win");
    expect(classifyOutcome(set(null, 0), set(null, 0)).result).toBe("inconclusive");
  });
  it("updates the scoreboard", () => {
    let board = updateScoreboard({}, "stuck_page:depth-faq", "win");
    board = updateScoreboard(board, "stuck_page:depth-faq", "loss");
    board = updateScoreboard(board, "stuck_page:depth-faq", "inconclusive");
    expect(board["stuck_page:depth-faq"]).toEqual({ wins: 1, losses: 1, noChange: 0, inconclusive: 1 });
    expect(hypothesisScore(board["stuck_page:depth-faq"])).toBe(0);
    expect(buildMetricSet({ keywords: [{ id: "a", position: 10, impressions: 5, clicks: 1 }, { id: "b", position: null, impressions: 3, clicks: 0 }], capturedOn: "x" })).toMatchObject({ scope: "keywords", avgPosition: 10, impressions: 8, clicks: 1 });
  });
});
