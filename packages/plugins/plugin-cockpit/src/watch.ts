/**
 * The operations watch, worker part: five cheap rules over what the host lets
 * the Cockpit read (`public.heartbeat_runs`, `public.issues`,
 * `public.issue_relations`, and its own asks). Every rule is one aggregate or
 * a few capped rows, never a scan with a row limit, and builds plain health
 * checks (`watch-model.ts`) that `ownSnapshot` adds, so they reach the Cockpit
 * page, the Operator's brief and the System health issue.
 *
 * Times come from `env.now()` and go in as parameters, so the same rule gives
 * the same answer in a test and live. A rule that cannot read its rows says so
 * (`unreadableCheck`) instead of silently checking nothing.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { HealthCheck } from "@partnersinbiz/pib-plugin-kit/cockpit";
import { FAILED_RUN } from "./merge.js";
import { message, type Env } from "./env.js";
import { NAMESPACE } from "./namespace.js";
import {
  blockedCheck,
  FINISHED_RUN,
  retryStormChecks,
  runRateChecks,
  runStreakChecks,
  stalledCheck,
  unreadableCheck,
  WATCH,
  type BlockedIssue,
  type RateRow,
  type StalledIssue,
  type StormRow,
  type StreakRun,
  type WatchAgent,
} from "./watch-model.js";

type Raw = Record<string, unknown>;

/** `'a', 'b'` for a fixed list of status words (constants only: never user text). */
const sqlList = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(", ");
const FINISHED = sqlList(FINISHED_RUN);
const FAILED = sqlList([...FAILED_RUN]);

const iso = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString();
  if (value == null || value === "") return null;
  const t = Date.parse(String(value).includes("T") ? String(value) : String(value).replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const text = (value: unknown): string | null => (value == null || value === "" ? null : String(value));
const num = (value: unknown): number => Number(value) || 0;

const ago = (now: Date, hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();

/** Finished runs in the window, per agent, status and error code (one GROUP BY row each). */
export async function readRateRows(ctx: PluginContext, companyId: string, now: Date): Promise<RateRow[]> {
  const rows = await ctx.db.query<Raw>(
    `SELECT agent_id, status, error_code, count(*)::text AS n
       FROM public.heartbeat_runs
      WHERE company_id = $1 AND started_at >= $2::timestamptz AND status IN (${FINISHED})
      GROUP BY agent_id, status, error_code`,
    [companyId, ago(now, WATCH.windowHours)],
  );
  return rows.map((r) => ({ agentId: String(r.agent_id), status: String(r.status), errorCode: text(r.error_code), count: num(r.n) }));
}

/** Each agent's latest finished runs in the window (newest first, `streakLookback` at most), with the issue each ran on. */
export async function readStreakRuns(ctx: PluginContext, companyId: string, now: Date): Promise<StreakRun[]> {
  const rows = await ctx.db.query<Raw>(
    `SELECT t.agent_id, t.status, t.error_code, t.started_at, t.issue_id, i.identifier
       FROM (SELECT agent_id, status, error_code, started_at, context_snapshot ->> 'issueId' AS issue_id,
                    row_number() OVER (PARTITION BY agent_id ORDER BY started_at DESC) AS rn
               FROM public.heartbeat_runs
              WHERE company_id = $1 AND started_at >= $2::timestamptz AND status IN (${FINISHED})) t
       LEFT JOIN public.issues i ON i.company_id = $3 AND i.id::text = t.issue_id
      WHERE t.rn <= ${WATCH.streakLookback}
      ORDER BY t.agent_id, t.rn`,
    [companyId, ago(now, WATCH.windowHours), companyId],
  );
  return rows.map((r) => ({ agentId: String(r.agent_id), status: String(r.status), errorCode: text(r.error_code), startedAt: iso(r.started_at) ?? "", issueId: text(r.issue_id), identifier: text(r.identifier) }));
}

/** Issues with four or more failed runs in the window whose latest finished run also failed, and that are still open. */
export async function readStorms(ctx: PluginContext, companyId: string, now: Date): Promise<StormRow[]> {
  const rows = await ctx.db.query<Raw>(
    `SELECT g.issue_id, g.failed::text AS failed, g.codes::text AS codes, g.error_code, g.agent_id, g.first_failed_at, g.last_error, i.identifier, i.title
       FROM (SELECT context_snapshot ->> 'issueId' AS issue_id,
                    count(*) FILTER (WHERE status IN (${FAILED})) AS failed,
                    count(DISTINCT error_code) FILTER (WHERE status IN (${FAILED})) AS codes,
                    (array_agg(status ORDER BY started_at DESC))[1] AS last_status,
                    (array_agg(error_code ORDER BY started_at DESC) FILTER (WHERE status IN (${FAILED})))[1] AS error_code,
                    (array_agg(error ORDER BY started_at DESC) FILTER (WHERE status IN (${FAILED})))[1] AS last_error,
                    (array_agg(agent_id ORDER BY started_at DESC))[1]::text AS agent_id,
                    min(started_at) FILTER (WHERE status IN (${FAILED})) AS first_failed_at
               FROM public.heartbeat_runs
              WHERE company_id = $1 AND started_at >= $2::timestamptz AND status IN (${FINISHED}) AND context_snapshot ->> 'issueId' IS NOT NULL
              GROUP BY context_snapshot ->> 'issueId'
             HAVING count(*) FILTER (WHERE status IN (${FAILED})) >= ${WATCH.stormMin}) g
       LEFT JOIN public.issues i ON i.company_id = $3 AND i.id::text = g.issue_id
      WHERE g.last_status IN (${FAILED}) AND (i.status IS NULL OR i.status NOT IN ('done', 'cancelled'))
      ORDER BY g.failed DESC
      LIMIT ${WATCH.perRule}`,
    [companyId, ago(now, WATCH.windowHours), companyId],
  );
  return rows.map((r) => ({
    issueId: String(r.issue_id),
    identifier: text(r.identifier),
    title: text(r.title),
    failed: num(r.failed),
    errorCode: text(r.error_code),
    codes: num(r.codes),
    agentId: text(r.agent_id),
    firstFailedAt: iso(r.first_failed_at),
    lastError: text(r.last_error),
  }));
}

/**
 * Issues blocked for more than a day with nothing to wake them: no unblock
 * descriptor, no open blocker issue, no open question to the owner, and not
 * held by a person. The oldest `named` come back with the full count.
 */
export async function readBlocked(ctx: PluginContext, companyId: string, now: Date): Promise<{ total: number; items: BlockedIssue[] }> {
  const rows = await ctx.db.query<Raw>(
    `SELECT i.id, i.identifier, i.title, coalesce(i.blocked_transition_at, i.updated_at) AS since, count(*) OVER () AS total
       FROM public.issues i
      WHERE i.company_id = $1 AND i.status = 'blocked' AND i.hidden_at IS NULL AND i.assignee_user_id IS NULL
        AND jsonb_typeof(i.unblock_descriptor) IS DISTINCT FROM 'object'
        AND coalesce(i.blocked_transition_at, i.updated_at) < $2::timestamptz
        AND NOT EXISTS (SELECT 1 FROM public.issue_relations r JOIN public.issues b ON b.id = r.issue_id
                         WHERE r.company_id = i.company_id AND r.related_issue_id = i.id AND r.type = 'blocks' AND b.status NOT IN ('done', 'cancelled'))
        AND NOT EXISTS (SELECT 1 FROM ${NAMESPACE}.asks a WHERE a.company_id = i.company_id::text AND a.issue_id = i.id::text AND a.status = 'open')
      ORDER BY coalesce(i.blocked_transition_at, i.updated_at), i.id
      LIMIT ${WATCH.named}`,
    [companyId, ago(now, WATCH.blockedHours)],
  );
  return {
    total: rows.length ? num(rows[0]!.total) : 0,
    items: rows.map((r) => ({ id: String(r.id), identifier: text(r.identifier), title: String(r.title ?? ""), since: iso(r.since) ?? now.toISOString() })),
  };
}

/**
 * Issues in progress whose agent assignee has no run queued or running and
 * none started for 12 hours (the assignee's own status is checked by the
 * caller). The longest-waiting `named` come back with the full count.
 */
export async function readStalled(ctx: PluginContext, companyId: string, now: Date): Promise<{ total: number; items: StalledIssue[] }> {
  const rows = await ctx.db.query<Raw>(
    `SELECT i.id, i.identifier, i.title, i.assignee_agent_id, i.updated_at, lr.at AS last_run_at, count(*) OVER () AS total
       FROM public.issues i
       LEFT JOIN (SELECT agent_id, max(started_at) AS at FROM public.heartbeat_runs WHERE company_id = $1 GROUP BY agent_id) lr ON lr.agent_id = i.assignee_agent_id
      WHERE i.company_id = $2 AND i.status = 'in_progress' AND i.hidden_at IS NULL AND i.assignee_agent_id IS NOT NULL
        AND i.updated_at < $3::timestamptz
        AND (lr.at IS NULL OR lr.at < $4::timestamptz)
        AND NOT EXISTS (SELECT 1 FROM public.heartbeat_runs q WHERE q.company_id = i.company_id AND q.agent_id = i.assignee_agent_id AND q.status IN ('queued', 'running', 'scheduled_retry'))
      ORDER BY i.updated_at, i.id
      LIMIT 200`,
    [companyId, companyId, ago(now, 1), ago(now, WATCH.stalledHours)],
  );
  return {
    total: rows.length ? num(rows[0]!.total) : 0,
    items: rows.map((r) => ({ id: String(r.id), identifier: text(r.identifier), title: String(r.title ?? ""), assigneeAgentId: String(r.assignee_agent_id), updatedAt: iso(r.updated_at) ?? now.toISOString(), lastRunAt: iso(r.last_run_at) })),
  };
}

/** Agents by id: name, status and link key. A failed lookup gives an empty map (names fall back to "An agent"). */
async function watchAgents(env: Env, companyId: string): Promise<Map<string, WatchAgent>> {
  try {
    const list = (await env.ctx.agents.list({ companyId, limit: 200 })) as unknown as Raw[];
    return new Map(list.map((a) => [String(a.id), { id: String(a.id), name: String(a.name ?? "Agent"), status: text(a.status), urlKey: text(a.urlKey) }]));
  } catch (error) {
    env.ctx.logger.info("Cockpit watch agent list failed", { companyId, error: message(error) });
    return new Map();
  }
}

/** Assignees that count as "idle": paused, errored and unapproved agents have their own health entries. */
const IDLE_STATUSES = new Set(["idle", "active"]);
/** Agents that are gone: runs they made before they were removed say nothing about the company now. */
const GONE_STATUSES = new Set(["terminated", "archived", "deleted"]);

/**
 * Every rule's checks for one company, worst first within a rule. Each rule
 * is read on its own, so one failing read costs only that rule.
 */
export async function watchChecks(env: Env, companyId: string): Promise<HealthCheck[]> {
  const now = env.now();
  const agents = await watchAgents(env, companyId);
  const checks: HealthCheck[] = [];
  const rule = async (name: string, what: string, run: () => Promise<HealthCheck[]>) => {
    try {
      checks.push(...(await run()));
    } catch (error) {
      env.ctx.logger.info("Cockpit watch rule failed", { companyId, rule: name, error: message(error) });
      checks.push(unreadableCheck(name, what, message(error)));
    }
  };
  const here = (agentId: string) => !GONE_STATUSES.has(agents.get(agentId)?.status ?? "");
  await rule("run-rate", "how often runs fail", async () => runRateChecks((await readRateRows(env.ctx, companyId, now)).filter((r) => here(r.agentId)), agents));
  await rule("run-streak", "repeated run errors", async () => runStreakChecks((await readStreakRuns(env.ctx, companyId, now)).filter((r) => here(r.agentId)), agents));
  await rule("retry-storm", "issues that keep failing", async () => retryStormChecks(await readStorms(env.ctx, companyId, now), agents));
  await rule("blocked", "blocked issues", async () => {
    const { total, items } = await readBlocked(env.ctx, companyId, now);
    const check = blockedCheck(items, total, now);
    return check ? [check] : [];
  });
  await rule("stalled", "issues in progress", async () => {
    const { total, items } = await readStalled(env.ctx, companyId, now);
    // Only assignees we know to be idle; when the agent list failed, nobody is vouched for and nothing is flagged.
    const idle = items.filter((i) => IDLE_STATUSES.has(agents.get(i.assigneeAgentId)?.status ?? ""));
    const check = stalledCheck(idle, total - (items.length - idle.length), agents, now);
    return check ? [check] : [];
  });
  return checks;
}
