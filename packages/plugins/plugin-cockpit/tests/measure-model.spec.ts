import { describe, expect, it } from "vitest";
import { compactMeasure, MEASURE_REASONS_SHOWN } from "../src/measure.js";
import {
  agentMeasures,
  aggregateFromRow,
  AUTHOR_AGENT,
  BUDGET_MEANING,
  breakdowns,
  COVERAGE_MIN_DONE,
  emptyAggregate,
  failRate,
  formatDuration,
  formatTokens,
  formatUsd,
  limitFailureChecks,
  percentile,
  reviewCoverage,
  reviewCoverageCheck,
  REVIEW_AGENT,
  SPEND_ANOMALY,
  spendChecks,
  splitAuthorsReviewers,
  type DoneIssueReview,
} from "../src/measure-model.js";

describe("percentiles and formats", () => {
  it("interpolates and ignores junk", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([7], 0.9)).toBe(7);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([10, 20, 30, 40, 50], 0.9)).toBe(46);
    expect(percentile([5, Number.NaN, 1], 0.5)).toBe(3);
    expect(percentile([1, 2, 3], 5)).toBe(3); // clamped
  });

  it("writes money, tokens and durations short", () => {
    expect(formatUsd(0.354)).toBe("$0.35");
    expect(formatUsd(12.4)).toBe("$12");
    expect(formatUsd(1204.3)).toBe("$1,204");
    expect(formatUsd(-3)).toBe("-$3.00");
    expect(formatTokens(812)).toBe("812");
    expect(formatTokens(340_000)).toBe("340k");
    expect(formatTokens(1_250_000)).toBe("1.3M");
    expect(formatDuration(null)).toBe("–");
    expect(formatDuration(45)).toBe("45 s");
    expect(formatDuration(600)).toBe("10 min");
    expect(formatDuration(15_120)).toBe("4.2 h");
  });
});

describe("aggregates", () => {
  it("reads a SQL row and treats missing numbers as 0", () => {
    const a = aggregateFromRow({ runs: "10", ok: "6", failed: "2", cancelled: "2", retries: "1", continuations: "3", limit_failures: "1", usd: "12.5", input_tokens: "100", output_tokens: "50", cached_tokens: "900", wall_sec: "600", p50_sec: "30.5", p90_sec: null, issues: "4" });
    expect(a).toMatchObject({ runs: 10, succeeded: 6, failed: 2, cancelled: 2, retries: 1, continuations: 3, limitFailures: 1, usd: 12.5, inputTokens: 100, outputTokens: 50, cachedInputTokens: 900, wallSec: 600, p50Sec: 30.5, p90Sec: null, issues: 4 });
    expect(aggregateFromRow({})).toEqual({ ...emptyAggregate(), p50Sec: null, p90Sec: null });
  });

  it("a failure rate counts verdicts only: cancelled runs are hand-overs, not failures", () => {
    expect(failRate({ succeeded: 6, failed: 2 })).toBe(0.25);
    expect(failRate({ succeeded: 0, failed: 0 })).toBeNull();
  });

  it("folds why runs did not succeed per agent, most common first", () => {
    const rows = [
      { agentId: "a", status: "cancelled", errorCode: "workspace_busy", count: 61 },
      { agentId: "a", status: "cancelled", errorCode: "issue_reassigned", count: 3 },
      { agentId: "a", status: "cancelled", errorCode: null, count: 2 },
      { agentId: "a", status: "failed", errorCode: "adapter_failed", count: 4 },
      { agentId: "a", status: "timed_out", errorCode: "timeout", count: 2 },
      { agentId: "b", status: "cancelled", errorCode: "workspace_busy", count: 9 },
    ];
    expect(breakdowns(rows, "a")).toEqual({
      cancellations: [{ reason: "workspace_busy", count: 61 }, { reason: "issue_reassigned", count: 3 }, { reason: "cancelled", count: 2 }],
      failures: [{ reason: "adapter_failed", count: 4 }, { reason: "timeout", count: 2 }],
    });
  });

  it("works out cost per done issue and runs per done issue, and leaves them null with nothing done", () => {
    const aggregates = new Map([
      ["dev", { ...emptyAggregate(), runs: 20, succeeded: 15, failed: 5, usd: 100 }],
      ["idle", { ...emptyAggregate(), runs: 3, usd: 2 }],
    ]);
    const list = agentMeasures({ aggregates, reasons: [], done: new Map([["dev", 4]]), names: new Map([["dev", "Developer"]]) });
    expect(list.map((m) => m.agentId)).toEqual(["dev", "idle"]); // costliest first
    expect(list[0]).toMatchObject({ name: "Developer", doneIssues: 4, usdPerDone: 25, runsPerDone: 5, failRate: 0.25 });
    expect(list[1]).toMatchObject({ name: null, doneIssues: 0, usdPerDone: null, runsPerDone: null, failRate: null });
  });
});

describe("review coverage (Q8-8)", () => {
  const row = (id: string, extra: Partial<DoneIssueReview> = {}): DoneIssueReview => ({ id, identifier: id.toUpperCase(), completedAt: "2026-10-01T10:00:00.000Z", policyApproved: false, reviewIssueId: null, reviewCreatedAt: null, reviewCompletedAt: null, ...extra });

  it("sorts agents into authors and reviewers by name or title, and always counts the Cockpit's own Reviewer", () => {
    expect(AUTHOR_AGENT.test("Senior Developer")).toBe(true);
    expect(AUTHOR_AGENT.test("Developer")).toBe(true);
    expect(AUTHOR_AGENT.test("Mac Builder")).toBe(false);
    expect(REVIEW_AGENT.test("Code Reviewer")).toBe(true);
    const split = splitAuthorsReviewers(
      [
        { id: "d1", name: "Developer" },
        { id: "d2", name: "Senior Developer" },
        { id: "r1", name: "Code Reviewer" },
        { id: "r2", name: "Quality", title: "Reviewer" },
        { id: "p", name: "Planner" },
        { id: "x", name: "Developer Reviewer" }, // both words: reviewing wins, it cannot mark its own work
      ],
      ["ops-reviewer"],
    );
    expect(split.authors).toEqual(["d1", "d2"]);
    expect(split.reviewers.sort()).toEqual(["ops-reviewer", "r1", "r2", "x"]);
  });

  it("counts reviewed by the issue's own review stage or a linked review, never twice", () => {
    const c = reviewCoverage([
      row("a", { policyApproved: true, reviewIssueId: "r1", reviewCreatedAt: "2026-10-01T10:00:00.000Z", reviewCompletedAt: "2026-10-01T12:00:00.000Z" }),
      row("b", { reviewIssueId: "r2", reviewCreatedAt: "2026-10-01T10:00:00.000Z", reviewCompletedAt: "2026-10-01T16:00:00.000Z" }),
      row("c"),
      row("d", { completedAt: "2026-10-02T10:00:00.000Z" }),
    ]);
    expect(c).toMatchObject({ done: 4, reviewed: 2, byPolicy: 1, byIssue: 1, coverage: 0.5 });
    expect(c.latencySamples).toBe(2);
    expect(c.latencyP50Hours).toBe(4);
    expect(c.latencyP90Hours).toBe(5.6);
    expect(c.unreviewed.map((u) => u.identifier)).toEqual(["D", "C"]); // newest first
    expect(c.rule).toContain("Coverage = reviewed / done");
  });

  it("has no coverage with nothing done, and an open review adds no latency", () => {
    expect(reviewCoverage([]).coverage).toBeNull();
    const c = reviewCoverage([row("a", { reviewIssueId: "r", reviewCreatedAt: "2026-10-01T10:00:00.000Z", reviewCompletedAt: null })]);
    expect(c.reviewed).toBe(1);
    expect(c.latencySamples).toBe(0);
    expect(c.latencyP50Hours).toBeNull();
  });

  it("warns below 70% over enough work, names the rule, and says nothing about a thin sample", () => {
    const many = (reviewed: number, total: number) => reviewCoverage(Array.from({ length: total }, (_, i) => row(`i${i}`, i < reviewed ? { policyApproved: true } : {})));
    const check = reviewCoverageCheck(many(3, 12))!;
    expect(check).toMatchObject({ key: "review:coverage", status: "warn" });
    expect(check.title).toBe("Only 25% of finished code work was reviewed");
    expect(check.detail).toContain("3 of 12");
    expect(check.fix).toContain("Coverage = reviewed / done");
    expect(reviewCoverageCheck(many(9, 12))).toBeNull();
    expect(reviewCoverageCheck(many(0, COVERAGE_MIN_DONE - 1))).toBeNull();
  });
});

describe("notional spend alerts (Q9-12)", () => {
  const quiet = { usd24h: 10, usd7d: 70, usdBaseline7d: 70, daysWithData: 8 };

  it("is quiet at the usual level and with no caps", () => {
    expect(spendChecks(quiet)).toEqual([]);
  });

  it("alerts at the daily and weekly caps from the settings, and turns red at one and a half times", () => {
    const daily = spendChecks({ ...quiet, usd24h: 120 }, { dailyUsd: 100 });
    expect(daily.map((c) => [c.key, c.status])).toContainEqual(["spend:daily-cap", "warn"]);
    expect(daily.find((c) => c.key === "spend:daily-cap")!.detail).toContain(BUDGET_MEANING);
    expect(spendChecks({ ...quiet, usd24h: 160 }, { dailyUsd: 100 }).find((c) => c.key === "spend:daily-cap")!.status).toBe("bad");
    expect(spendChecks({ ...quiet, usd7d: 600 }, { weeklyUsd: 500 }).map((c) => c.key)).toContain("spend:weekly-cap");
    expect(spendChecks({ ...quiet, usd24h: 99 }, { dailyUsd: 100 }).map((c) => c.key)).not.toContain("spend:daily-cap");
    expect(spendChecks({ ...quiet, usd24h: 5000 }, { dailyUsd: 0, weeklyUsd: null }).map((c) => c.key)).not.toContain("spend:daily-cap");
  });

  it("flags a day at more than twice the usual, but only with history and a real amount", () => {
    const burst = { usd24h: 200, usd7d: 270, usdBaseline7d: 70, daysWithData: 8 }; // usual 10 a day
    expect(spendChecks(burst).map((c) => c.key)).toEqual(["spend:anomaly"]);
    expect(spendChecks(burst)[0]!.title).toBe("Notional AI spend is 20 times the usual");
    expect(spendChecks({ ...burst, daysWithData: SPEND_ANOMALY.minDays - 1 })).toEqual([]); // not enough history to know what usual is
    expect(spendChecks({ ...burst, usd24h: 20 })).toEqual([]); // under the amount that matters
    expect(spendChecks({ ...burst, usd24h: 24 })).toEqual([]); // 2.4 times, but under the 25 dollar floor
    expect(spendChecks({ ...burst, usd24h: 25 }).map((c) => c.key)).toEqual(["spend:anomaly"]);
  });

  it("does not divide by an empty baseline", () => {
    expect(spendChecks({ usd24h: 400, usd7d: 400, usdBaseline7d: 0, daysWithData: 8 })).toEqual([]);
  });
});

describe("limit failures", () => {
  const names = new Map([["a", "SEO Specialist"]]);

  it("says nothing for a few, and goes red for a burst: the subscription limit takes every agent down", () => {
    expect(limitFailureChecks({ total: 4, byAgent: [{ agentId: "a", count: 4 }], since: null }, names, 24)).toEqual([]);
    const [check] = limitFailureChecks({ total: 69, byAgent: [{ agentId: "a", count: 60 }, { agentId: "z", count: 9 }], since: "2026-09-28T07:00:00.000Z" }, names, 24);
    expect(check).toMatchObject({ key: "limit-failures", status: "bad", since: "2026-09-28T07:00:00.000Z" });
    expect(check!.title).toBe("69 runs failed on the subscription limit in 24 hours");
    expect(check!.detail).toContain("SEO Specialist (60), an agent (9)");
    expect(check!.fix).toContain("Do not retry");
  });
});

describe("the compact measures the brief carries for every agent that ran", () => {
  const base = () => ({ ...emptyAggregate(), agentId: "a1", name: null, doneIssues: 0, usdPerDone: null, runsPerDone: null, failRate: null, cancellations: [], failures: [] });

  it("leaves out what is zero, empty or unknown, so 28 agents do not cost the Operator thousands of tokens of nothing", () => {
    const quiet = compactMeasure({ ...base(), runs: 3, succeeded: 3, usd: 1.234, inputTokens: 1000, outputTokens: 50, cachedInputTokens: 9000, wallSec: 720, p50Sec: 100, p90Sec: 200 }, 24);
    expect(quiet).toEqual({ windowHours: 24, notionalUsd: 1.23, tokens: { input: 1000, output: 50, cached: 9000 }, runSec: { typical: 100, slowest: 200 }, wallHours: 0.2, doneIssues: 0 });
    for (const field of ["retries", "continuations", "limitFailures", "cancellations", "failures", "usdPerDone", "runsPerDone", "failRate"]) expect(quiet).not.toHaveProperty(field);
  });

  it("keeps what is there, and lists three reasons at most", () => {
    const reasons = ["a", "b", "c", "d", "e"].map((reason, i) => ({ reason, count: 5 - i }));
    const busy = compactMeasure({ ...base(), runs: 10, failed: 5, retries: 2, continuations: 1, limitFailures: 1, usd: 9, doneIssues: 2, usdPerDone: 4.5, runsPerDone: 5, failRate: 0.5, cancellations: reasons, failures: reasons }, 168);
    expect(busy).toMatchObject({ windowHours: 168, retries: 2, continuations: 1, limitFailures: 1, usdPerDone: 4.5, runsPerDone: 5, failRate: 0.5, doneIssues: 2 });
    expect(busy.failures).toEqual(reasons.slice(0, MEASURE_REASONS_SHOWN));
    expect(busy.cancellations).toHaveLength(3);
  });
});
