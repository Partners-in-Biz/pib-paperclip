/**
 * The Cockpit's own stages in the company graph (kit `FLOWS`, onboarding),
 * reported in its snapshot like every plugin reports its stages:
 * - `onboarding.open`: open onboarding issues (one per new client, opened on a
 *   first win); stuck when open for more than 7 days.
 * - `onboarding.grants`: open questions to the owner of kind `grant` (a login,
 *   a key, a DNS record: asked once, with links); stuck when asked more than
 *   3 days ago, the same age the stale-question health check uses.
 */
import { cleanFlowReports, type FlowStageReport } from "@partnersinbiz/pib-plugin-kit";
import { ASK_STALE_DAYS, staleAsks } from "./ask-model.js";
import { listOpenAsks } from "./asks.js";
import { ORIGIN, PLUGIN_KEY } from "./constants.js";
import { message, type Env } from "./env.js";

export const ONBOARDING_STUCK_DAYS = 7;
const DAY_MS = 86_400_000;

/** Milliseconds from a Date or a core-read text timestamp (`2026-09-25 17:09:53.8+02`). */
function timeOf(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== "string" || !value) return Number.NaN;
  return Date.parse(value.includes("T") ? value : value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
}

/** Open onboarding issues (not done or cancelled), oldest first (core read of public.issues). */
export async function openOnboardingIssues(env: Env, companyId: string): Promise<Array<{ id: string; createdAt: number }>> {
  const rows = await env.ctx.db.query<Record<string, unknown>>(
    `SELECT id, created_at FROM public.issues
      WHERE company_id = $1 AND origin_kind = $2 AND hidden_at IS NULL AND status IN ('backlog', 'todo', 'in_progress', 'in_review', 'blocked')
      ORDER BY created_at LIMIT 500`,
    [companyId, ORIGIN.onboarding],
  );
  return rows.map((row) => ({ id: String(row.id), createdAt: timeOf(row.created_at) }));
}

function ageDays(times: number[], now: number): number[] {
  return times.map((t) => (now - t) / DAY_MS).filter((days) => Number.isFinite(days));
}

function oldest(days: number[]): number | null {
  return days.length ? Math.max(0, Math.floor(Math.max(...days))) : null;
}

/** The numbers for the Cockpit's own stages. A part that cannot be read reports nothing. */
export async function cockpitFlowReports(env: Env, companyId: string): Promise<FlowStageReport[]> {
  const now = env.now();
  const reports: FlowStageReport[] = [];
  try {
    const open = await openOnboardingIssues(env, companyId);
    const days = ageDays(open.map((issue) => issue.createdAt), now.getTime());
    const stuck = days.filter((d) => d > ONBOARDING_STUCK_DAYS).length;
    reports.push({
      stage: "onboarding.open",
      count: open.length,
      stuck,
      stuckReason: stuck ? `${stuck} open for more than ${ONBOARDING_STUCK_DAYS} days` : null,
      oldestDays: oldest(days),
    });
  } catch (error) {
    env.ctx.logger.info("Cockpit onboarding count failed", { companyId, error: message(error) });
  }
  try {
    const grants = (await listOpenAsks(env, companyId, 200)).filter((ask) => ask.kind === "grant");
    const stuck = staleAsks(grants, now).length;
    reports.push({
      stage: "onboarding.grants",
      count: grants.length,
      stuck,
      stuckReason: stuck ? `${stuck} asked more than ${ASK_STALE_DAYS} days ago` : null,
      oldestDays: oldest(ageDays(grants.map((ask) => Date.parse(ask.askedAt)), now.getTime())),
    });
  } catch (error) {
    env.ctx.logger.info("Cockpit grant count failed", { companyId, error: message(error) });
  }
  return cleanFlowReports(PLUGIN_KEY, reports);
}
