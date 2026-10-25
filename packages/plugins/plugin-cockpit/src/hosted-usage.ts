/**
 * Hosted usage roll-up (PAR-5301): per hosted company and month, the runs, the
 * notional spend (`usage_json.costUsd`), the issues done and the agents. Counts and
 * cost only: no titles, agent names, comments or any client content.
 *
 * Runs as a job, so there is no "current company". The owner is the known company
 * whose prefix is the owner's (`isOwnerCompany`); with none known the job writes
 * nothing. Every read filters `company_id = $1`, the owner's own row is never
 * written, and a month is recomputed (upsert) until 3 days after it ended.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { isOwnerCompany, knownCompanyIds } from "@partnersinbiz/pib-plugin-kit";
import { throwIfEveryCompanyFailed, message, type Env } from "./env.js";
import { usage } from "./measure.js";
import { NAMESPACE } from "./namespace.js";

/** Africa/Johannesburg is UTC+2 all year (no daylight saving). */
const SAST_HOURS = 2;
const DAY_MS = 86_400_000;
/** A finished month is still recomputed this long after it ended (late runs, late completions). */
export const RECOMPUTE_DAYS = 3;

export interface MonthWindow {
  /** First day of the SAST month, `YYYY-MM-01`. */
  month: string;
  /** Inclusive start and exclusive end, as instants. */
  from: string;
  to: string;
}

/** The SAST month `offset` months from the one `at` falls in. */
export function sastMonth(at: Date, offset = 0): MonthWindow {
  const local = new Date(at.getTime() + SAST_HOURS * 3_600_000);
  const year = local.getUTCFullYear();
  const index = local.getUTCMonth() + offset;
  const start = new Date(Date.UTC(year, index, 1, -SAST_HOURS));
  const end = new Date(Date.UTC(year, index + 1, 1, -SAST_HOURS));
  const first = new Date(Date.UTC(year, index, 1));
  return { month: first.toISOString().slice(0, 10), from: start.toISOString(), to: end.toISOString() };
}

/** The months to recompute at `now`: this one, and the last one until 3 days into this one. */
export function monthsToCompute(now: Date): MonthWindow[] {
  const current = sastMonth(now);
  const months = [current];
  if (now.getTime() < Date.parse(current.from) + RECOMPUTE_DAYS * DAY_MS) months.unshift(sastMonth(now, -1));
  return months;
}

export interface HostedUsageRow {
  runs: number;
  notionalUsd: number;
  doneIssues: number;
  agents: number;
}

/** Runs and done issues of one company in a window, one statement. A bad or missing `costUsd` counts 0. */
export async function readCompanyMonth(ctx: PluginContext, companyId: string, window: MonthWindow): Promise<Omit<HostedUsageRow, "agents">> {
  const [row] = await ctx.db.query<{ runs: unknown; usd: unknown; done: unknown }>(
    `WITH r AS (
       SELECT ${usage("costUsd")} AS usd
         FROM public.heartbeat_runs r
        WHERE r.company_id = $1::uuid AND r.started_at >= $2::timestamptz AND r.started_at < $3::timestamptz)
     SELECT (SELECT count(*) FROM r)::int AS runs,
            ROUND((SELECT COALESCE(sum(usd), 0) FROM r)::numeric, 6)::double precision AS usd,
            (SELECT count(*) FROM public.issues i
              WHERE i.company_id = $1::uuid AND i.status = 'done' AND i.completed_at >= $2::timestamptz AND i.completed_at < $3::timestamptz)::int AS done`,
    [companyId, window.from, window.to],
  );
  return { runs: Number(row?.runs) || 0, notionalUsd: Number(row?.usd) || 0, doneIssues: Number(row?.done) || 0 };
}

/** Agents that are not terminated now (a snapshot, as `checks.ts` lists them). */
export async function countAgents(ctx: PluginContext, companyId: string): Promise<number> {
  const agents = (await ctx.agents.list({ companyId, limit: 200 })) as unknown as Array<Record<string, unknown>>;
  return agents.filter((a) => a.status !== "terminated").length;
}

export type RollupResult = {
  /** False when no known company is the owner: nothing was read or written. */
  owner: boolean;
  companies: number;
  rows: number;
  failed: number;
};

async function upsert(ctx: PluginContext, owner: string, hosted: string, name: string, window: MonthWindow, row: HostedUsageRow, now: Date): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${NAMESPACE}.hosted_usage (owner_company_id, hosted_company_id, company_name, month, runs, notional_usd, done_issues, agents, computed_at)
     VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9::timestamptz)
     ON CONFLICT (owner_company_id, hosted_company_id, month) DO UPDATE
       SET company_name = EXCLUDED.company_name, runs = EXCLUDED.runs, notional_usd = EXCLUDED.notional_usd,
           done_issues = EXCLUDED.done_issues, agents = EXCLUDED.agents, computed_at = EXCLUDED.computed_at`,
    [owner, hosted, name, window.month, row.runs, row.notionalUsd, row.doneIssues, row.agents, now.toISOString()],
  );
}

/** The job: recompute this month (and last, for the first days) for every hosted company. */
export async function hostedUsageRollup(env: Env): Promise<RollupResult> {
  const { ctx } = env;
  const now = env.now();
  const ids = [...new Set(await knownCompanyIds(ctx))];
  let owner: string | null = null;
  for (const id of ids) {
    if (await isOwnerCompany(ctx, id)) {
      owner = id;
      break;
    }
  }
  if (!owner) return { owner: false, companies: 0, rows: 0, failed: 0 };
  const windows = monthsToCompute(now);
  let companies = 0;
  let rows = 0;
  let failed = 0;
  for (const id of ids) {
    if (id === owner) continue;
    try {
      const company = (await ctx.companies.get(id)) as { name?: string | null } | null;
      if (!company || (await isOwnerCompany(ctx, id))) continue;
      companies += 1;
      const agents = await countAgents(ctx, id);
      for (const window of windows) {
        await upsert(ctx, owner, id, String(company.name ?? ""), window, { ...(await readCompanyMonth(ctx, id, window)), agents }, now);
        rows += 1;
      }
    } catch (error) {
      failed += 1;
      ctx.logger.warn("Hosted usage roll-up failed for a company", { companyId: id, error: message(error) });
    }
  }
  throwIfEveryCompanyFailed("Hosted usage roll-up", companies + failed, failed);
  return { owner: true, companies, rows, failed };
}
