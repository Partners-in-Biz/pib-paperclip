/**
 * The measurement layer, pure part (no node imports): what the runs cost, how
 * long they take, how often they are retried, who reviews the code, and the
 * alerts that follow (Q8-3, Q8-8, Q9-12).
 *
 * Why notional USD. Every Claude run records cost 0 (`subscription_included`),
 * so `cost_cents`, agent budgets and `budget_policies` never move: a budget of
 * $30 can never fill and its 80% alert can never fire. What does move is the
 * token usage each run reports (`heartbeat_runs.usage_json`: `costUsd` is what
 * the same tokens would cost at list price, `inputTokens`, `outputTokens`,
 * `cachedInputTokens`). Hermes runs record it too since the Hermes patch of
 * 2026-10-03. So the Cockpit measures that, calls it notional (nobody is billed
 * for it under a flat plan) and alerts on it (`spendChecks`) without depending
 * on `cost_cents`.
 *
 * `measure.ts` reads the rows; this file turns them into numbers and checks.
 */
import type { HealthCheck } from "@partnersinbiz/pib-plugin-kit/cockpit";

/** Said once wherever a budget is shown, so nobody reads "$0 spent" as "free". */
export const BUDGET_MEANING =
  "Agent budgets count billed cents. Claude runs under the flat subscription record 0 cents, so a Claude agent's budget never fills and its 80% alert cannot fire. Hermes spend is recorded in small real cents. The Cockpit measures notional USD instead (what the same tokens would cost at list price, from each run's usage) and alerts on that.";

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/** The p-th percentile (0..1) of numbers, by linear interpolation; null for none. */
export function percentile(values: number[], p: number): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0]!;
  const rank = Math.min(1, Math.max(0, p)) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (rank - low);
}

export const round = (value: number, digits = 2): number => {
  const k = 10 ** digits;
  return Math.round(value * k) / k;
};

const n = (value: unknown): number => {
  const x = Number(value);
  return Number.isFinite(x) ? x : 0;
};

/** `$12.40` / `$0.35` / `$1,204`: notional dollars for text. */
export function formatUsd(usd: number): string {
  const abs = Math.abs(usd);
  const text = abs >= 1000 ? Math.round(abs).toLocaleString("en-US") : abs >= 10 ? abs.toFixed(0) : abs.toFixed(2);
  return `${usd < 0 ? "-" : ""}$${text}`;
}

/** `1.2M`, `340k`, `812`. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${round(tokens / 1_000_000, 1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(Math.round(tokens));
}

/** `4.2 h`, `38 min`, `45 s`. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "–";
  if (seconds >= 5400) return `${round(seconds / 3600, 1)} h`;
  if (seconds >= 90) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds)} s`;
}

// ---------------------------------------------------------------------------
// Runs per agent and per project
// ---------------------------------------------------------------------------

/** What one GROUP BY row of finished and running runs gives (one agent, one project or one issue tree). */
export interface RunAggregate {
  runs: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  /** Runs started as a retry of an earlier run. */
  retries: number;
  /** Runs woken to carry on unfinished work (`issue_continuation_needed`, or a continuation attempt). */
  continuations: number;
  /** Failures that say the subscription limit was hit. */
  limitFailures: number;
  usd: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Seconds from start to finish, summed. */
  wallSec: number;
  p50Sec: number | null;
  p90Sec: number | null;
  /** Different issues the runs worked on. */
  issues: number;
}

export function emptyAggregate(): RunAggregate {
  return { runs: 0, succeeded: 0, failed: 0, cancelled: 0, retries: 0, continuations: 0, limitFailures: 0, usd: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, wallSec: 0, p50Sec: null, p90Sec: null, issues: 0 };
}

/** A SQL row (text numbers) as a `RunAggregate`. */
export function aggregateFromRow(row: Record<string, unknown>): RunAggregate {
  const dur = (value: unknown) => (value == null || value === "" ? null : n(value));
  return {
    runs: n(row.runs),
    succeeded: n(row.ok),
    failed: n(row.failed),
    cancelled: n(row.cancelled),
    retries: n(row.retries),
    continuations: n(row.continuations),
    limitFailures: n(row.limit_failures),
    usd: n(row.usd),
    inputTokens: n(row.input_tokens),
    outputTokens: n(row.output_tokens),
    cachedInputTokens: n(row.cached_tokens),
    wallSec: n(row.wall_sec),
    p50Sec: dur(row.p50_sec),
    p90Sec: dur(row.p90_sec),
    issues: n(row.issues),
  };
}

/** The share of verdict runs (succeeded + failed) that failed; null with no verdicts. Cancelled runs are handovers or workspace waits, not failures. */
export function failRate(a: Pick<RunAggregate, "succeeded" | "failed">): number | null {
  const verdicts = a.succeeded + a.failed;
  return verdicts === 0 ? null : a.failed / verdicts;
}

export interface Breakdown {
  reason: string;
  count: number;
}

export interface AgentMeasure extends RunAggregate {
  agentId: string;
  name: string | null;
  doneIssues: number;
  usdPerDone: number | null;
  runsPerDone: number | null;
  failRate: number | null;
  /** Why runs were cancelled (`workspace_busy`, `issue_reassigned`...), most common first. */
  cancellations: Breakdown[];
  /** Error codes of failed runs, most common first. */
  failures: Breakdown[];
}

/** Counts of `status/error_code` rows folded into cancellation and failure breakdowns for one agent. */
export interface ReasonRow {
  agentId: string;
  status: string;
  errorCode: string | null;
  count: number;
}

const CANCELLED = new Set(["cancelled"]);
const FAILED = new Set(["failed", "error", "timed_out", "timeout", "cancelled_error", "interrupted"]);

export function breakdowns(rows: ReasonRow[], agentId: string): { cancellations: Breakdown[]; failures: Breakdown[] } {
  const fold = (statuses: Set<string>) => {
    const map = new Map<string, number>();
    for (const row of rows) {
      if (row.agentId !== agentId || !statuses.has(row.status)) continue;
      const key = row.errorCode ?? row.status;
      map.set(key, (map.get(key) ?? 0) + row.count);
    }
    return [...map.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)).slice(0, 5);
  };
  return { cancellations: fold(CANCELLED), failures: fold(FAILED) };
}

export function agentMeasures(input: { aggregates: Map<string, RunAggregate>; reasons: ReasonRow[]; done: Map<string, number>; names: Map<string, string> }): AgentMeasure[] {
  const out: AgentMeasure[] = [];
  for (const [agentId, agg] of input.aggregates) {
    const done = input.done.get(agentId) ?? 0;
    out.push({
      ...agg,
      agentId,
      name: input.names.get(agentId) ?? null,
      doneIssues: done,
      usdPerDone: done > 0 ? round(agg.usd / done) : null,
      runsPerDone: done > 0 ? round(agg.runs / done, 1) : null,
      failRate: failRate(agg),
      ...breakdowns(input.reasons, agentId),
    });
  }
  return out.sort((a, b) => b.usd - a.usd || b.runs - a.runs);
}

export interface ProjectMeasure extends RunAggregate {
  projectId: string | null;
  name: string | null;
  doneIssues: number;
  usdPerDone: number | null;
}

export interface TreeMeasure extends RunAggregate {
  rootId: string;
  identifier: string | null;
  title: string | null;
  /** Agents that worked on the tree, with the notional USD each used, biggest first. */
  agents: Array<{ agentId: string; usd: number; runs: number }>;
}

/** What the measure report prints for one aggregate: short names, rounded. */
export interface RunBrief {
  runs: number;
  failed: number;
  cancelled: number;
  retries: number;
  continuations: number;
  limitFailures: number;
  notionalUsd: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  wallHours: number;
  p50Sec: number | null;
  p90Sec: number | null;
}

export function brief(a: RunAggregate): RunBrief {
  return {
    runs: a.runs,
    failed: a.failed,
    cancelled: a.cancelled,
    retries: a.retries,
    continuations: a.continuations,
    limitFailures: a.limitFailures,
    notionalUsd: round(a.usd),
    inputTokens: a.inputTokens,
    outputTokens: a.outputTokens,
    cachedInputTokens: a.cachedInputTokens,
    wallHours: round(a.wallSec / 3600, 1),
    p50Sec: a.p50Sec === null ? null : Math.round(a.p50Sec),
    p90Sec: a.p90Sec === null ? null : Math.round(a.p90Sec),
  };
}

// ---------------------------------------------------------------------------
// Review coverage and latency (Q8-8)
// ---------------------------------------------------------------------------

/**
 * What counts as reviewed, said once so the number means the same every week
 * (it was 7 of 39 to 33 of 44 depending on who counted):
 *
 * - The denominator: issues in DONE, assigned to a Developer or Senior
 *   Developer (an author agent), completed in the window.
 * - Reviewed (policy): the issue's execution policy has a review stage and the
 *   stage's last decision approved it.
 * - Reviewed (issue): an issue assigned to a Reviewer or Code Reviewer is
 *   linked to it: a child of it, in a `blocks` relation with it, or naming its
 *   identifier (PAR-123, whole word) in the title or description.
 * - Latency: the linked review issue's created -> completed time, for those
 *   that are done.
 */
export const REVIEW_COVERAGE_RULE =
  "A done Developer or Senior Developer issue is reviewed when its execution policy has an approved review stage, or an issue assigned to a Reviewer or Code Reviewer is linked to it (a child, a blocks relation, or its identifier in the title or description). Coverage = reviewed / done. Latency = the review issue's created to completed time.";

/** Author agents (Developer, Senior Developer, engineers) and review agents (Reviewer, Code Reviewer), by name or title. */
export const AUTHOR_AGENT = /\b(senior\s+)?(developer|engineer)\b/i;
export const REVIEW_AGENT = /\breviewer\b/i;

export interface AgentKind {
  id: string;
  name: string;
  title?: string | null;
  role?: string | null;
}

export function splitAuthorsReviewers(agents: AgentKind[], extraReviewerIds: Array<string | null | undefined> = []): { authors: string[]; reviewers: string[] } {
  const reviewers = new Set(extraReviewerIds.filter((id): id is string => !!id));
  const authors: string[] = [];
  for (const agent of agents) {
    const label = `${agent.name} ${agent.title ?? ""}`;
    if (REVIEW_AGENT.test(label)) reviewers.add(agent.id);
    else if (AUTHOR_AGENT.test(label)) authors.push(agent.id);
  }
  return { authors, reviewers: [...reviewers] };
}

export interface DoneIssueReview {
  id: string;
  identifier: string | null;
  completedAt: string | null;
  /** The issue's own execution policy has a review stage that approved. */
  policyApproved: boolean;
  /** The first linked review issue. */
  reviewIssueId: string | null;
  reviewCreatedAt: string | null;
  reviewCompletedAt: string | null;
}

export interface ReviewCoverage {
  done: number;
  reviewed: number;
  byPolicy: number;
  byIssue: number;
  /** reviewed / done, 0..1; null with nothing done. */
  coverage: number | null;
  latencyP50Hours: number | null;
  latencyP90Hours: number | null;
  latencySamples: number;
  /** Done issues with no review, newest first (at most 10). */
  unreviewed: Array<{ id: string; identifier: string | null }>;
  rule: string;
}

export function reviewCoverage(rows: DoneIssueReview[]): ReviewCoverage {
  let byPolicy = 0;
  let byIssue = 0;
  const hours: number[] = [];
  const unreviewed: DoneIssueReview[] = [];
  for (const row of rows) {
    if (row.policyApproved) byPolicy += 1;
    else if (row.reviewIssueId) byIssue += 1;
    else unreviewed.push(row);
    if (row.reviewIssueId && row.reviewCreatedAt && row.reviewCompletedAt) {
      const h = (Date.parse(row.reviewCompletedAt) - Date.parse(row.reviewCreatedAt)) / 3_600_000;
      if (Number.isFinite(h) && h >= 0) hours.push(h);
    }
  }
  const reviewed = byPolicy + byIssue;
  const p50 = percentile(hours, 0.5);
  const p90 = percentile(hours, 0.9);
  return {
    done: rows.length,
    reviewed,
    byPolicy,
    byIssue,
    coverage: rows.length === 0 ? null : reviewed / rows.length,
    latencyP50Hours: p50 === null ? null : round(p50, 1),
    latencyP90Hours: p90 === null ? null : round(p90, 1),
    latencySamples: hours.length,
    unreviewed: unreviewed.sort((a, b) => Date.parse(b.completedAt ?? "") - Date.parse(a.completedAt ?? "")).slice(0, 10).map((r) => ({ id: r.id, identifier: r.identifier })),
    rule: REVIEW_COVERAGE_RULE,
  };
}

/** Review coverage below this share is a health warning (over `COVERAGE_MIN_DONE` or more done issues). */
export const COVERAGE_WARN = 0.7;
export const COVERAGE_MIN_DONE = 8;

export function reviewCoverageCheck(c: ReviewCoverage): HealthCheck | null {
  if (c.coverage === null || c.done < COVERAGE_MIN_DONE || c.coverage >= COVERAGE_WARN) return null;
  const list = c.unreviewed.slice(0, 5).map((u) => u.identifier ?? u.id).join(", ");
  return {
    key: "review:coverage",
    title: `Only ${Math.round(c.coverage * 100)}% of finished code work was reviewed`,
    status: "warn",
    detail: `${c.reviewed} of ${c.done} issues the Developers closed in the last 30 days have a review (${c.byPolicy} by the issue's review stage, ${c.byIssue} by a linked Reviewer issue). Not reviewed: ${list}${c.unreviewed.length > 5 ? ", ..." : ""}.`,
    href: "/cockpit",
    fix: "Ask the Reviewer to review the listed work, and set a review stage on code issues so each close waits for one. Count rule: " + REVIEW_COVERAGE_RULE,
  };
}

// ---------------------------------------------------------------------------
// Notional spend alerts (Q9-12)
// ---------------------------------------------------------------------------

export interface SpendWindows {
  /** Notional USD in the last 24 hours. */
  usd24h: number;
  /** In the last 7 days. */
  usd7d: number;
  /** In the 7 days before the last 24 hours (the usual level the last day is compared to). */
  usdBaseline7d: number;
  /** Different days with any run in the last 14 days (how much history there is). */
  daysWithData: number;
}

/** The last day is flagged when it is over this multiple of the usual daily spend, over `minUsd`, with at least `minDays` of history. */
export const SPEND_ANOMALY = { ratio: 2, minUsd: 25, minDays: 4 } as const;

export function spendChecks(windows: SpendWindows, caps: { dailyUsd?: number | null; weeklyUsd?: number | null } = {}): HealthCheck[] {
  const out: HealthCheck[] = [];
  const daily = caps.dailyUsd && caps.dailyUsd > 0 ? caps.dailyUsd : null;
  const weekly = caps.weeklyUsd && caps.weeklyUsd > 0 ? caps.weeklyUsd : null;
  if (daily && windows.usd24h >= daily) {
    out.push({
      key: "spend:daily-cap",
      title: `Notional AI spend is ${formatUsd(windows.usd24h)} in 24 hours`,
      status: windows.usd24h >= daily * 1.5 ? "bad" : "warn",
      detail: `The daily limit set in the Cockpit settings is ${formatUsd(daily)}. Nobody is billed for this under the flat Claude plan, but it is the measure of how hard the agents are working and how close the plan's limit is. ${BUDGET_MEANING}`,
      href: "/cockpit",
      fix: "Open Agents and the weekly retro's measure report: find the agent or project that used it, and pause low-value routines or narrow the work. Raise the limit in the Cockpit settings only if the work is worth it.",
    });
  }
  if (weekly && windows.usd7d >= weekly) {
    out.push({
      key: "spend:weekly-cap",
      title: `Notional AI spend is ${formatUsd(windows.usd7d)} this week`,
      status: windows.usd7d >= weekly * 1.5 ? "bad" : "warn",
      detail: `The weekly limit set in the Cockpit settings is ${formatUsd(weekly)}. ${BUDGET_MEANING}`,
      href: "/cockpit",
      fix: "Use the weekly measure report to see where it went (agent, project, issue tree), and narrow the work that costs the most for the least done.",
    });
  }
  const usual = windows.usdBaseline7d / 7;
  if (windows.daysWithData >= SPEND_ANOMALY.minDays && windows.usd24h >= SPEND_ANOMALY.minUsd && usual > 0 && windows.usd24h > usual * SPEND_ANOMALY.ratio) {
    out.push({
      key: "spend:anomaly",
      title: `Notional AI spend is ${round(windows.usd24h / usual, 1)} times the usual`,
      status: "warn",
      detail: `The last 24 hours used ${formatUsd(windows.usd24h)} of notional spend; the usual is about ${formatUsd(usual)} a day over the previous week. A retry storm, a looping agent or a limit burst usually looks like this.`,
      href: "/cockpit",
      fix: "Check the run-rate and retry-storm entries above, and the measure report's top agents and issue trees.",
    });
  }
  return out;
}

/** The "Claude limit hit" check: failed runs that say the subscription limit was reached. */
export interface LimitFailures {
  total: number;
  byAgent: Array<{ agentId: string; count: number }>;
  since: string | null;
}

export const LIMIT_WARN = 5;

export function limitFailureChecks(l: LimitFailures, names: Map<string, string>, hours: number): HealthCheck[] {
  if (l.total < LIMIT_WARN) return [];
  const who = l.byAgent.slice(0, 5).map((a) => `${names.get(a.agentId) ?? "an agent"} (${a.count})`).join(", ");
  return [
    {
      key: "limit-failures",
      title: `${l.total} runs failed on the subscription limit in ${hours} hours`,
      status: "bad",
      detail: `The agent reported a terminal limit failure: the plan's usage limit was reached, so every agent on it fails until it resets. Most affected: ${who}.`,
      href: "/cockpit",
      fix: "Do not retry: each retry fails and uses up the wake budget. Pause the lowest-value routines and agents, keep the Operator and Reviewer running, and let the window reset. Pin Sonnet on agents that run on the default model and cap their concurrent runs.",
      since: l.since,
    },
  ];
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface MeasureReport {
  windowHours: number;
  generatedAt: string;
  budgetMeaning: string;
  company: RunBrief & { usdPerDay: number; doneIssues: number; usdPerDone: number | null; failRate: number | null };
  agents: Array<RunBrief & { agentId: string; name: string | null; doneIssues: number; usdPerDone: number | null; runsPerDone: number | null; failRate: number | null; cancellations: Breakdown[]; failures: Breakdown[] }>;
  projects: Array<RunBrief & { projectId: string | null; name: string | null; doneIssues: number; usdPerDone: number | null }>;
  issueTrees: Array<RunBrief & { rootId: string; identifier: string | null; title: string | null; agents: Array<{ agentId: string; usd: number; runs: number }> }>;
  reviewCoverage: ReviewCoverage | null;
  limitFailures: LimitFailures;
  spend: SpendWindows;
}

/** One agent, short, for a scorecard line. */
export function agentMeasureBrief(m: AgentMeasure): Record<string, unknown> {
  return {
    ...brief(m),
    doneIssues: m.doneIssues,
    usdPerDone: m.usdPerDone,
    runsPerDone: m.runsPerDone,
    failRate: m.failRate === null ? null : round(m.failRate, 3),
    cancellations: m.cancellations,
    failures: m.failures,
  };
}
