/**
 * The measurement layer, worker part: reads `public.heartbeat_runs` and
 * `public.issues` (core reads the manifest allows) into the numbers
 * `measure-model.ts` turns into scorecards, the weekly retro's data and
 * health alerts (Q8-3, Q8-8, Q9-12, Q1b-14).
 *
 * Every read is one aggregate statement for the company and a time window,
 * never a row fetch with a limit (the old `LIMIT 1000` cut a week short). A
 * read that fails says so (`null` from the caller's side) instead of reporting
 * zeros.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { readConfig } from "@partnersinbiz/pib-plugin-kit";
import { humanWorkSql } from "./closeout-model.js";
import { FAILED_RUN } from "./merge.js";
import type { Env } from "./env.js";
import { message } from "./env.js";
import {
  agentMeasures,
  aggregateFromRow,
  BUDGET_MEANING,
  brief,
  emptyAggregate,
  failRate,
  reviewCoverage,
  round,
  splitAuthorsReviewers,
  type AgentMeasure,
  type DoneIssueReview,
  type LimitFailures,
  type MeasureReport,
  type ProjectMeasure,
  type ReasonRow,
  type ReviewCoverage,
  type RunAggregate,
  type SpendWindows,
  type TreeMeasure,
} from "./measure-model.js";

type Raw = Record<string, unknown>;

const sqlList = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(", ");
const FAILED = sqlList([...FAILED_RUN]);

const text = (value: unknown): string | null => (value == null || value === "" ? null : String(value));
const num = (value: unknown): number => Number(value) || 0;
const iso = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString();
  if (value == null || value === "") return null;
  const t = Date.parse(String(value).includes("T") ? String(value) : String(value).replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const ago = (now: Date, hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();

/** A numeric field of a run's `usage_json`, 0 when missing or not a number (never a cast error). */
const usage = (field: string) => `CASE WHEN r.usage_json ->> '${field}' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (r.usage_json ->> '${field}')::double precision ELSE 0 END`;

/** Runs since a time with the fields every aggregate needs. `$1` company, `$2` since. */
const RUNS = `runs AS (
  SELECT r.agent_id, r.status, r.error_code, r.error, r.retry_of_run_id, r.continuation_attempt, r.started_at,
         r.context_snapshot ->> 'issueId' AS issue_id, r.context_snapshot ->> 'wakeReason' AS wake_reason,
         ${usage("costUsd")} AS usd, ${usage("inputTokens")} AS input_tokens, ${usage("outputTokens")} AS output_tokens, ${usage("cachedInputTokens")} AS cached_tokens,
         CASE WHEN r.finished_at IS NOT NULL AND r.finished_at >= r.started_at THEN EXTRACT(EPOCH FROM (r.finished_at - r.started_at))::double precision END AS secs
    FROM public.heartbeat_runs r
   WHERE r.company_id = $1::uuid AND r.started_at >= $2::timestamptz)`;

/**
 * The failure text that says the plan's usage limit was hit: the adapter's
 * "terminal limit failure" (live: 74 runs) and the CLI's own "usage limit" /
 * "hit your limit" words. A generic "rate limit" is NOT counted: a GitHub or
 * other API throttle in a run's error is not the subscription running out, and
 * five of them in a day would raise a false "bad" check.
 */
const LIMIT_TEXT = `(error ILIKE '%limit failure%' OR error ILIKE '%usage limit%' OR error ILIKE '%hit your limit%')`;

/** The aggregate columns of `RunAggregate` over a `runs` alias. */
const AGGREGATE = `count(*)::text AS runs,
       count(*) FILTER (WHERE status = 'succeeded')::text AS ok,
       count(*) FILTER (WHERE status IN (${FAILED}))::text AS failed,
       count(*) FILTER (WHERE status = 'cancelled')::text AS cancelled,
       count(*) FILTER (WHERE retry_of_run_id IS NOT NULL)::text AS retries,
       count(*) FILTER (WHERE wake_reason = 'issue_continuation_needed' OR coalesce(continuation_attempt, 0) > 0)::text AS continuations,
       count(*) FILTER (WHERE status IN (${FAILED}) AND ${LIMIT_TEXT})::text AS limit_failures,
       coalesce(sum(usd), 0)::text AS usd,
       coalesce(sum(input_tokens), 0)::text AS input_tokens,
       coalesce(sum(output_tokens), 0)::text AS output_tokens,
       coalesce(sum(cached_tokens), 0)::text AS cached_tokens,
       coalesce(sum(secs), 0)::text AS wall_sec,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY secs)::text AS p50_sec,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY secs)::text AS p90_sec,
       count(DISTINCT issue_id)::text AS issues`;

// ---------------------------------------------------------------------------
// Per agent
// ---------------------------------------------------------------------------

export interface AgentRead {
  aggregates: Map<string, RunAggregate>;
  reasons: ReasonRow[];
  done: Map<string, number>;
}

/** Every agent's runs, why they did not succeed, and the issues each closed, since `since`. */
export async function readAgentRuns(ctx: PluginContext, companyId: string, since: string): Promise<AgentRead> {
  const [rows, reasons, done] = await Promise.all([
    ctx.db.query<Raw>(`WITH ${RUNS} SELECT agent_id::text AS agent_id, ${AGGREGATE} FROM runs GROUP BY agent_id`, [companyId, since]),
    ctx.db.query<Raw>(`WITH ${RUNS} SELECT agent_id::text AS agent_id, status, error_code, count(*)::text AS n FROM runs WHERE status <> 'succeeded' GROUP BY agent_id, status, error_code`, [companyId, since]),
    ctx.db.query<Raw>(
      `SELECT assignee_agent_id::text AS agent_id, count(*)::text AS done FROM public.issues
        WHERE company_id = $1::uuid AND status = 'done' AND hidden_at IS NULL AND completed_at >= $2::timestamptz AND assignee_agent_id IS NOT NULL
        GROUP BY assignee_agent_id`,
      [companyId, since],
    ),
  ]);
  return {
    aggregates: new Map(rows.map((r) => [String(r.agent_id), aggregateFromRow(r)])),
    reasons: reasons.map((r) => ({ agentId: String(r.agent_id), status: String(r.status), errorCode: text(r.error_code), count: num(r.n) })),
    done: new Map(done.map((r) => [String(r.agent_id), num(r.done)])),
  };
}

export async function agentNames(env: Env, companyId: string): Promise<Map<string, string>> {
  try {
    const list = (await env.ctx.agents.list({ companyId, limit: 200 })) as unknown as Raw[];
    return new Map(list.map((a) => [String(a.id), String(a.name ?? "Agent")]));
  } catch (error) {
    env.ctx.logger.info("Cockpit measure: agent list failed", { companyId, error: message(error) });
    return new Map();
  }
}

/**
 * One agent's measures for the Operator's brief and the scorecards: short names,
 * rounded, no raw rows. A field that is zero, empty or unknown is LEFT OUT (the
 * brief carries this for every agent that ran, about 28 of them, so each
 * absent field is tokens the Operator does not read): no `retries` means none,
 * no `failures` means no failed run, no `usdPerDone` means no finished issue.
 */
export interface AgentMeasureBrief {
  windowHours: number;
  /** What the agent's tokens would cost at list price. Not billed: Claude runs on a flat plan, so budgets stay empty. */
  notionalUsd: number;
  tokens: { input: number; output: number; cached: number };
  /** Seconds from start to finish: the typical run and the slowest 10%. */
  runSec: { typical: number | null; slowest: number | null };
  wallHours: number;
  retries?: number;
  continuations?: number;
  limitFailures?: number;
  /** The three most common reasons. */
  cancellations?: Array<{ reason: string; count: number }>;
  failures?: Array<{ reason: string; count: number }>;
  doneIssues: number;
  usdPerDone?: number;
  runsPerDone?: number;
  failRate?: number;
}

/** How many reasons a measure lists for cancellations and for failures. */
export const MEASURE_REASONS_SHOWN = 3;

/** Leaves out what is zero, empty or unknown (see `AgentMeasureBrief`). */
export function compactMeasure(m: AgentMeasure, windowHours: number): AgentMeasureBrief {
  const b = brief(m);
  const out: AgentMeasureBrief = {
    windowHours,
    notionalUsd: b.notionalUsd,
    tokens: { input: b.inputTokens, output: b.outputTokens, cached: b.cachedInputTokens },
    runSec: { typical: b.p50Sec, slowest: b.p90Sec },
    wallHours: b.wallHours,
    doneIssues: m.doneIssues,
  };
  if (b.retries) out.retries = b.retries;
  if (b.continuations) out.continuations = b.continuations;
  if (b.limitFailures) out.limitFailures = b.limitFailures;
  if (m.cancellations.length) out.cancellations = m.cancellations.slice(0, MEASURE_REASONS_SHOWN);
  if (m.failures.length) out.failures = m.failures.slice(0, MEASURE_REASONS_SHOWN);
  if (m.usdPerDone !== null) out.usdPerDone = m.usdPerDone;
  if (m.runsPerDone !== null) out.runsPerDone = m.runsPerDone;
  if (m.failRate !== null && m.failRate > 0) out.failRate = round(m.failRate, 3);
  return out;
}

/** Every agent's measures over the window, by agent id. An agent with no runs is not in the map. */
export async function agentMeasureBriefs(env: Env, companyId: string, windowHours: number): Promise<Map<string, AgentMeasureBrief>> {
  const read = await readAgentRuns(env.ctx, companyId, ago(env.now(), windowHours));
  const out = new Map<string, AgentMeasureBrief>();
  for (const a of agentMeasures({ ...read, names: new Map() })) out.set(a.agentId, compactMeasure(a, windowHours));
  return out;
}

export async function measureAgents(env: Env, companyId: string, since: string): Promise<AgentMeasure[]> {
  const [read, names] = await Promise.all([readAgentRuns(env.ctx, companyId, since), agentNames(env, companyId)]);
  return agentMeasures({ ...read, names });
}

// ---------------------------------------------------------------------------
// Per project
// ---------------------------------------------------------------------------

export async function readProjectRuns(ctx: PluginContext, companyId: string, since: string, limit = 25): Promise<ProjectMeasure[]> {
  const [rows, done] = await Promise.all([
    ctx.db.query<Raw>(
      `WITH ${RUNS},
       scoped AS (
         SELECT runs.agent_id, runs.status, runs.error_code, runs.error, runs.retry_of_run_id, runs.continuation_attempt, runs.started_at, runs.issue_id, runs.wake_reason,
                runs.usd, runs.input_tokens, runs.output_tokens, runs.cached_tokens, runs.secs, i.project_id
           FROM runs JOIN public.issues i ON i.id::text = runs.issue_id AND i.company_id = $3::uuid),
       agg AS (
         SELECT project_id::text AS project_id, ${AGGREGATE} FROM scoped GROUP BY project_id ORDER BY sum(usd) DESC, count(*) DESC LIMIT $4)
       SELECT agg.*, p.name AS project_name FROM agg LEFT JOIN public.projects p ON p.id::text = agg.project_id AND p.company_id = $5::uuid
       ORDER BY agg.usd::double precision DESC`,
      [companyId, since, companyId, limit, companyId],
    ),
    ctx.db.query<Raw>(
      `SELECT project_id::text AS project_id, count(*)::text AS done FROM public.issues
        WHERE company_id = $1::uuid AND status = 'done' AND hidden_at IS NULL AND completed_at >= $2::timestamptz AND project_id IS NOT NULL
        GROUP BY project_id`,
      [companyId, since],
    ),
  ]);
  const doneBy = new Map(done.map((r) => [String(r.project_id), num(r.done)]));
  return rows.map((r) => {
    const projectId = text(r.project_id);
    const agg = aggregateFromRow(r);
    const d = projectId ? doneBy.get(projectId) ?? 0 : 0;
    return { ...agg, projectId, name: text(r.project_name), doneIssues: d, usdPerDone: d > 0 ? round(agg.usd / d) : null };
  });
}

// ---------------------------------------------------------------------------
// Per issue tree
// ---------------------------------------------------------------------------

/** The costliest issue trees (an epic and everything under it) in the window, with who worked on each. */
export async function readTreeRuns(ctx: PluginContext, companyId: string, since: string, limit = 10): Promise<TreeMeasure[]> {
  const rows = await ctx.db.query<Raw>(
    `WITH RECURSIVE ${RUNS},
     run_issue AS (
       SELECT issue_id, agent_id, count(*) AS runs,
              count(*) FILTER (WHERE status = 'succeeded') AS ok,
              count(*) FILTER (WHERE status IN (${FAILED})) AS failed,
              count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
              count(*) FILTER (WHERE retry_of_run_id IS NOT NULL) AS retries,
              count(*) FILTER (WHERE wake_reason = 'issue_continuation_needed' OR coalesce(continuation_attempt, 0) > 0) AS continuations,
              count(*) FILTER (WHERE status IN (${FAILED}) AND ${LIMIT_TEXT}) AS limit_failures,
              sum(usd) AS usd, sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens, sum(cached_tokens) AS cached_tokens, sum(secs) AS wall_sec
         FROM runs WHERE issue_id IS NOT NULL GROUP BY issue_id, agent_id),
     up AS (
       SELECT i.id AS issue_id, i.id AS cur_id, i.parent_id AS next_id, 0 AS depth
         FROM public.issues i WHERE i.company_id = $3::uuid AND i.id::text IN (SELECT issue_id FROM run_issue)
       UNION ALL
       SELECT up.issue_id, p.id, p.parent_id, up.depth + 1
         FROM up JOIN public.issues p ON p.id = up.next_id AND p.company_id = $4::uuid WHERE up.depth < 20),
     roots AS (SELECT issue_id::text AS issue_id, cur_id AS root_id FROM up WHERE next_id IS NULL OR depth = 20),
     per AS (
       SELECT ro.root_id, ri.agent_id, sum(ri.runs) AS runs, sum(ri.ok) AS ok, sum(ri.failed) AS failed, sum(ri.cancelled) AS cancelled, sum(ri.retries) AS retries,
              sum(ri.continuations) AS continuations, sum(ri.limit_failures) AS limit_failures, sum(ri.usd) AS usd, sum(ri.input_tokens) AS input_tokens,
              sum(ri.output_tokens) AS output_tokens, sum(ri.cached_tokens) AS cached_tokens, sum(ri.wall_sec) AS wall_sec, count(DISTINCT ri.issue_id) AS issues
         FROM run_issue ri JOIN roots ro ON ro.issue_id = ri.issue_id GROUP BY ro.root_id, ri.agent_id),
     top AS (SELECT root_id FROM per GROUP BY root_id ORDER BY sum(usd) DESC LIMIT $5)
     SELECT per.root_id::text AS root_id, per.agent_id::text AS agent_id, per.runs::text AS runs, per.ok::text AS ok, per.failed::text AS failed, per.cancelled::text AS cancelled,
            per.retries::text AS retries, per.continuations::text AS continuations, per.limit_failures::text AS limit_failures, per.usd::text AS usd,
            per.input_tokens::text AS input_tokens, per.output_tokens::text AS output_tokens, per.cached_tokens::text AS cached_tokens, per.wall_sec::text AS wall_sec,
            per.issues::text AS issues, root.identifier, root.title
       FROM per JOIN top ON top.root_id = per.root_id JOIN public.issues root ON root.id = per.root_id AND root.company_id = $6::uuid`,
    [companyId, since, companyId, companyId, limit, companyId],
  );
  const trees = new Map<string, TreeMeasure>();
  for (const r of rows) {
    const rootId = String(r.root_id);
    const tree = trees.get(rootId) ?? { ...emptyAggregate(), rootId, identifier: text(r.identifier), title: text(r.title), agents: [] };
    const agg = aggregateFromRow(r);
    tree.runs += agg.runs;
    tree.succeeded += agg.succeeded;
    tree.failed += agg.failed;
    tree.cancelled += agg.cancelled;
    tree.retries += agg.retries;
    tree.continuations += agg.continuations;
    tree.limitFailures += agg.limitFailures;
    tree.usd += agg.usd;
    tree.inputTokens += agg.inputTokens;
    tree.outputTokens += agg.outputTokens;
    tree.cachedInputTokens += agg.cachedInputTokens;
    tree.wallSec += agg.wallSec;
    tree.issues += agg.issues;
    tree.agents.push({ agentId: String(r.agent_id), usd: round(agg.usd), runs: agg.runs });
    trees.set(rootId, tree);
  }
  return [...trees.values()].map((t) => ({ ...t, agents: t.agents.sort((a, b) => b.usd - a.usd || b.runs - a.runs) })).sort((a, b) => b.usd - a.usd);
}

export interface ScopeMeasure {
  total: RunAggregate;
  agents: Array<{ agentId: string; usd: number; runs: number; failed: number }>;
  /** Runs woken because someone reopened an issue by comment, and runs woken because a blocker resolved (blocked spells that ended). */
  reopenWakes: number;
  unblockWakes: number;
  issues: { total: number; done: number; cancelled: number; blocked: number; blockedDays: number; createdFirst: string | null; completedLast: string | null };
}

/**
 * The issues of one project, or of one issue tree (a root and everything under
 * it), as a CTE named `member(id)`. `$3` is the company, `$4` the project or
 * root id. A project's members are its real work only (`humanWorkSql`), the same
 * set the close-out sweep counts, so the review's numbers match its trigger.
 */
function memberCte(kind: "project" | "tree"): string {
  return kind === "project"
    ? `member AS (SELECT i.id FROM public.issues i WHERE i.company_id = $3::uuid AND i.project_id = $4::uuid AND i.hidden_at IS NULL AND ${humanWorkSql("i")})`
    : `tree AS (SELECT i.id, 0 AS depth FROM public.issues i WHERE i.company_id = $3::uuid AND i.id = $4::uuid
                UNION ALL SELECT c.id, tree.depth + 1 FROM public.issues c JOIN tree ON c.parent_id = tree.id AND c.company_id = $5::uuid WHERE tree.depth < 20),
        member AS (SELECT id FROM tree)`;
}

/**
 * What a project or an issue tree cost and how it went since `since` (null: ever):
 * the numbers a close-out review starts from (Q2-1).
 */
export async function readScopeRuns(ctx: PluginContext, companyId: string, scope: { kind: "project" | "tree"; id: string }, since: string | null, now: Date): Promise<ScopeMeasure> {
  const from = since ?? "1970-01-01T00:00:00.000Z";
  const params = scope.kind === "project" ? [companyId, from, companyId, scope.id] : [companyId, from, companyId, scope.id, companyId];
  const head = `WITH RECURSIVE ${RUNS}, ${memberCte(scope.kind)}`;
  const mine = `issue_id IN (SELECT id::text FROM member)`;
  const issueParams = [...params, now.toISOString()];
  const [total, agents, issues] = await Promise.all([
    ctx.db.query<Raw>(
      `${head} SELECT ${AGGREGATE},
              count(*) FILTER (WHERE wake_reason ILIKE 'issue_reopened%')::text AS reopen_wakes,
              count(*) FILTER (WHERE wake_reason = 'issue_blockers_resolved')::text AS unblock_wakes
         FROM runs WHERE ${mine}`,
      params,
    ),
    ctx.db.query<Raw>(
      `${head} SELECT agent_id::text AS agent_id, count(*)::text AS runs, count(*) FILTER (WHERE status IN (${FAILED}))::text AS failed, coalesce(sum(usd), 0)::text AS usd
         FROM runs WHERE ${mine} GROUP BY agent_id ORDER BY sum(usd) DESC, count(*) DESC LIMIT 8`,
      params,
    ),
    ctx.db.query<Raw>(
      `${head} SELECT count(*)::text AS total,
              count(*) FILTER (WHERE x.status = 'done')::text AS done,
              count(*) FILTER (WHERE x.status = 'cancelled')::text AS cancelled,
              count(*) FILTER (WHERE x.status = 'blocked')::text AS blocked,
              coalesce(sum(EXTRACT(EPOCH FROM ($${params.length + 1}::timestamptz - coalesce(x.blocked_transition_at, x.updated_at))) / 86400) FILTER (WHERE x.status = 'blocked'), 0)::text AS blocked_days,
              min(x.created_at) AS first_created, max(x.completed_at) AS last_completed
         FROM public.issues x WHERE x.id IN (SELECT id FROM member) AND x.company_id = $${params.length + 2}::uuid`,
      [...issueParams, companyId],
    ),
  ]);
  const t = total[0] ?? {};
  const i = issues[0] ?? {};
  return {
    total: aggregateFromRow(t),
    agents: agents.map((r) => ({ agentId: String(r.agent_id), usd: round(num(r.usd)), runs: num(r.runs), failed: num(r.failed) })),
    reopenWakes: num(t.reopen_wakes),
    unblockWakes: num(t.unblock_wakes),
    issues: { total: num(i.total), done: num(i.done), cancelled: num(i.cancelled), blocked: num(i.blocked), blockedDays: round(num(i.blocked_days), 1), createdFirst: iso(i.first_created), completedLast: iso(i.last_completed) },
  };
}

// ---------------------------------------------------------------------------
// Spend windows and limit failures
// ---------------------------------------------------------------------------

export async function readSpendWindows(ctx: PluginContext, companyId: string, now: Date): Promise<SpendWindows> {
  const rows = await ctx.db.query<Raw>(
    `SELECT coalesce(sum(usd) FILTER (WHERE started_at >= $2::timestamptz), 0)::text AS usd24h,
            coalesce(sum(usd) FILTER (WHERE started_at >= $3::timestamptz), 0)::text AS usd7d,
            coalesce(sum(usd) FILTER (WHERE started_at >= $4::timestamptz AND started_at < $5::timestamptz), 0)::text AS usd_baseline,
            count(DISTINCT date_trunc('day', started_at))::text AS days
       FROM (SELECT r.started_at, ${usage("costUsd")} AS usd FROM public.heartbeat_runs r WHERE r.company_id = $1::uuid AND r.started_at >= $6::timestamptz) x`,
    [companyId, ago(now, 24), ago(now, 24 * 7), ago(now, 24 * 8), ago(now, 24), ago(now, 24 * 14)],
  );
  const r = rows[0] ?? {};
  return { usd24h: num(r.usd24h), usd7d: num(r.usd7d), usdBaseline7d: num(r.usd_baseline), daysWithData: num(r.days) };
}

export async function readLimitFailures(ctx: PluginContext, companyId: string, since: string): Promise<LimitFailures> {
  const rows = await ctx.db.query<Raw>(
    `SELECT agent_id::text AS agent_id, count(*)::text AS n, min(started_at) AS first_at
       FROM public.heartbeat_runs
      WHERE company_id = $1::uuid AND started_at >= $2::timestamptz AND status IN (${FAILED}) AND ${LIMIT_TEXT}
      GROUP BY agent_id ORDER BY count(*) DESC`,
    [companyId, since],
  );
  const firsts = rows.map((r) => iso(r.first_at)).filter((t): t is string => !!t).sort();
  return { total: rows.reduce((sum, r) => sum + num(r.n), 0), byAgent: rows.map((r) => ({ agentId: String(r.agent_id), count: num(r.n) })), since: firsts[0] ?? null };
}

// ---------------------------------------------------------------------------
// Review coverage
// ---------------------------------------------------------------------------

/** Done issues of the author agents, each with the review that covers it (policy stage or a linked Reviewer issue). */
export async function readReviewRows(ctx: PluginContext, companyId: string, since: string, authors: string[], reviewers: string[], limit = 300): Promise<DoneIssueReview[]> {
  if (authors.length === 0) return [];
  const rows = await ctx.db.query<Raw>(
    `SELECT d.id::text AS id, d.identifier, d.completed_at,
            (jsonb_typeof(d.execution_policy -> 'stages') = 'array'
              AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.execution_policy -> 'stages') s WHERE s ->> 'type' = 'review')
              AND d.execution_state ->> 'lastDecisionOutcome' = 'approved') AS policy_approved,
            rv.id::text AS review_issue_id, rv.created_at AS review_created_at, rv.completed_at AS review_completed_at
       FROM public.issues d
       LEFT JOIN LATERAL (
         SELECT r.id, r.created_at, r.completed_at FROM public.issues r
          WHERE r.company_id = $1::uuid AND r.id <> d.id AND r.hidden_at IS NULL
            AND r.assignee_agent_id = ANY(ARRAY(SELECT jsonb_array_elements_text($4::jsonb))::uuid[])
            AND (r.parent_id = d.id
                 OR EXISTS (SELECT 1 FROM public.issue_relations x WHERE x.company_id = $1::uuid AND x.type = 'blocks'
                              AND ((x.issue_id = r.id AND x.related_issue_id = d.id) OR (x.issue_id = d.id AND x.related_issue_id = r.id)))
                 OR (d.identifier IS NOT NULL AND (r.title ~ ('\\m' || d.identifier || '\\M') OR r.description ~ ('\\m' || d.identifier || '\\M'))))
          ORDER BY r.created_at LIMIT 1) rv ON true
      WHERE d.company_id = $1::uuid AND d.status = 'done' AND d.hidden_at IS NULL AND d.completed_at >= $2::timestamptz
        AND d.assignee_agent_id = ANY(ARRAY(SELECT jsonb_array_elements_text($3::jsonb))::uuid[])
      ORDER BY d.completed_at DESC LIMIT $5`,
    [companyId, since, JSON.stringify(authors), JSON.stringify(reviewers.length ? reviewers : ["00000000-0000-0000-0000-000000000000"]), limit],
  );
  return rows.map((r) => ({
    id: String(r.id),
    identifier: text(r.identifier),
    completedAt: iso(r.completed_at),
    policyApproved: r.policy_approved === true || r.policy_approved === "true" || r.policy_approved === "t",
    reviewIssueId: text(r.review_issue_id),
    reviewCreatedAt: iso(r.review_created_at),
    reviewCompletedAt: iso(r.review_completed_at),
  }));
}

/** Review coverage and latency for the last `days` days: who counts as an author and a reviewer comes from the agent list. */
export async function measureReviewCoverage(env: Env, companyId: string, days = 30, reviewerAgentId?: string | null): Promise<ReviewCoverage | null> {
  try {
    const agents = (await env.ctx.agents.list({ companyId, limit: 200 })) as unknown as Raw[];
    const { authors, reviewers } = splitAuthorsReviewers(
      agents.filter((a) => !["terminated", "archived", "deleted"].includes(String(a.status ?? ""))).map((a) => ({ id: String(a.id), name: String(a.name ?? ""), title: text(a.title), role: text(a.role) })),
      [reviewerAgentId],
    );
    return reviewCoverage(await readReviewRows(env.ctx, companyId, ago(env.now(), days * 24), authors, reviewers));
  } catch (error) {
    env.ctx.logger.info("Cockpit review coverage failed", { companyId, error: message(error) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

const sumAggregates = (list: RunAggregate[]): RunAggregate => {
  const total = emptyAggregate();
  for (const a of list) {
    total.runs += a.runs;
    total.succeeded += a.succeeded;
    total.failed += a.failed;
    total.cancelled += a.cancelled;
    total.retries += a.retries;
    total.continuations += a.continuations;
    total.limitFailures += a.limitFailures;
    total.usd += a.usd;
    total.inputTokens += a.inputTokens;
    total.outputTokens += a.outputTokens;
    total.cachedInputTokens += a.cachedInputTokens;
    total.wallSec += a.wallSec;
    total.issues += a.issues;
  }
  return total;
};

export interface ReportOptions {
  windowHours?: number;
  /** Which parts to read; default all. */
  parts?: Array<"agents" | "projects" | "trees" | "review" | "limits">;
  reviewerAgentId?: string | null;
}

/** The measure report: company totals, per agent, per project, per issue tree, review coverage, limit failures and spend. */
export async function measureReport(env: Env, companyId: string, options: ReportOptions = {}): Promise<MeasureReport> {
  const windowHours = Math.min(Math.max(Math.round(options.windowHours ?? 168), 1), 24 * 60);
  const parts = new Set(options.parts ?? ["agents", "projects", "trees", "review", "limits"]);
  const now = env.now();
  const since = ago(now, windowHours);
  const [agents, projects, trees, review, limits, spend] = await Promise.all([
    parts.has("agents") ? measureAgents(env, companyId, since).catch(() => [] as AgentMeasure[]) : Promise.resolve([] as AgentMeasure[]),
    parts.has("projects") ? readProjectRuns(env.ctx, companyId, since).catch(() => [] as ProjectMeasure[]) : Promise.resolve([] as ProjectMeasure[]),
    parts.has("trees") ? readTreeRuns(env.ctx, companyId, since).catch(() => [] as TreeMeasure[]) : Promise.resolve([] as TreeMeasure[]),
    parts.has("review") ? measureReviewCoverage(env, companyId, 30, options.reviewerAgentId) : Promise.resolve(null),
    parts.has("limits") ? readLimitFailures(env.ctx, companyId, since).catch(() => ({ total: 0, byAgent: [], since: null }) as LimitFailures) : Promise.resolve({ total: 0, byAgent: [], since: null } as LimitFailures),
    readSpendWindows(env.ctx, companyId, now).catch(() => ({ usd24h: 0, usd7d: 0, usdBaseline7d: 0, daysWithData: 0 }) as SpendWindows),
  ]);
  const total = sumAggregates(agents);
  const doneIssues = agents.reduce((sum, a) => sum + a.doneIssues, 0);
  return {
    windowHours,
    generatedAt: now.toISOString(),
    budgetMeaning: BUDGET_MEANING,
    company: { ...brief(total), usdPerDay: round(total.usd / (windowHours / 24)), doneIssues, usdPerDone: doneIssues > 0 ? round(total.usd / doneIssues) : null, failRate: failRate(total) === null ? null : round(failRate(total)!, 3) },
    agents: agents.slice(0, 30).map((a) => ({ ...brief(a), agentId: a.agentId, name: a.name, doneIssues: a.doneIssues, usdPerDone: a.usdPerDone, runsPerDone: a.runsPerDone, failRate: a.failRate === null ? null : round(a.failRate, 3), cancellations: a.cancellations, failures: a.failures })),
    projects: projects.map((p) => ({ ...brief(p), projectId: p.projectId, name: p.name, doneIssues: p.doneIssues, usdPerDone: p.usdPerDone })),
    issueTrees: trees.map((t) => ({ ...brief(t), rootId: t.rootId, identifier: t.identifier, title: t.title, agents: t.agents.slice(0, 5) })),
    reviewCoverage: review,
    limitFailures: limits,
    spend,
  };
}

/** Notional spend caps from the Cockpit settings (blank or 0 = no cap). */
export async function spendCaps(ctx: PluginContext, companyId: string): Promise<{ dailyUsd: number | null; weeklyUsd: number | null }> {
  try {
    const config = await readConfig(ctx, companyId);
    const cap = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);
    return { dailyUsd: cap(config.notionalDailyUsd), weeklyUsd: cap(config.notionalWeeklyUsd) };
  } catch {
    return { dailyUsd: null, weeklyUsd: null };
  }
}
