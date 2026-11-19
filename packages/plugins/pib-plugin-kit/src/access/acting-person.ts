/**
 * The person an agent's run works for (PAR-12578 plan, 4.4 and section 7).
 *
 * The CRM's run query, moved into the kit so every guarded plugin uses the same
 * one. It is the only query a guarded plugin makes on `heartbeat_runs` (plan,
 * section 9): it selects the run's person and status by run id, filtered by
 * run, company and agent. A run of another agent or another company gives
 * nothing, and a run that has ended is refused.
 *
 * Needs `heartbeat_runs` in the plugin's `database.coreReadTables`.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";

/** Run statuses that are still going (core `HEARTBEAT_RUN_STATUSES`). Any other status has ended. */
export const LIVE_RUN_STATUSES: readonly string[] = Object.freeze(["queued", "scheduled_retry", "running"]);

export type ActingPerson =
  | { ok: true; userId: string; status: string }
  | { ok: false; reason: "not-found" | "ended" | "no-person" | "read-failed"; status?: string };

export interface RunRef {
  companyId: string;
  agentId: string;
  runId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

export const ACTING_PERSON_SQL = `SELECT responsible_user_id, status
  FROM public.heartbeat_runs
 WHERE id = $1 AND company_id = $2 AND agent_id = $3
 LIMIT 1`;

/**
 * Looks the run up. Never throws: a failed read is `read-failed`, which the
 * guard refuses and the cache does not store. Ids that are not UUIDs cannot
 * name a run and give `not-found` without a query.
 */
export async function actingPersonForRun(ctx: Pick<PluginContext, "db">, run: RunRef): Promise<ActingPerson> {
  if (!isUuid(run.runId) || !isUuid(run.companyId) || !isUuid(run.agentId)) return { ok: false, reason: "not-found" };
  let rows: Array<{ responsible_user_id: string | null; status: string | null }>;
  try {
    rows = await ctx.db.query(ACTING_PERSON_SQL, [run.runId, run.companyId, run.agentId]);
  } catch {
    return { ok: false, reason: "read-failed" };
  }
  const row = rows[0];
  if (!row) return { ok: false, reason: "not-found" };
  const status = typeof row.status === "string" ? row.status : "";
  if (!LIVE_RUN_STATUSES.includes(status)) return { ok: false, reason: "ended", status };
  const userId = typeof row.responsible_user_id === "string" ? row.responsible_user_id.trim() : "";
  if (!userId) return { ok: false, reason: "no-person", status };
  return { ok: true, userId, status };
}
