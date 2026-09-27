/**
 * The SEO routines ("Run today's SEO" daily, "Weekly SEO review" Mondays)
 * ship on: created active with their schedules on when an agent is linked.
 *
 * Two gaps are closed here:
 * - Routines created by older versions were paused with their schedule off.
 *   `activateShippedRoutines` sets a paused routine active when nobody has
 *   touched it since the plugin created it (a person's pause is kept).
 * - The worker can read a routine's status but not its triggers. The SEO page
 *   runs as the signed-in board user, reads the triggers from the host and
 *   reports them (`seo.routine-report`); the setup checklist uses the report.
 *   A trigger left off by an older version is switched on from the page in
 *   one click (`/seo?routines=on`).
 */
import type { SetupItem } from "@partnersinbiz/pib-plugin-kit";
import { ROUTINE_KEYS, ROUTINE_TITLES } from "../constants.js";
import { errorMessage, SeoError, type Env } from "./common.js";

export type RoutineKey = (typeof ROUTINE_KEYS)[number];

export interface RoutineReport {
  routineId: string;
  status: string | null;
  /** It has a schedule trigger and every live schedule trigger is on. */
  triggersOn: boolean;
  checkedAt: string;
}

export interface RoutineView {
  key: RoutineKey;
  title: string;
  id: string | null;
  status: string | null;
  /** From the page's last report; null when never checked. */
  triggersOn: boolean | null;
}

/** Where a person switches the routines on in one click. */
export const ROUTINES_SWITCH_ON_PATH = "/seo?routines=on";

function stateKey(companyId: string, key: RoutineKey) {
  return { scopeKind: "company" as const, scopeId: companyId, namespace: "seo-routines", stateKey: `report:${key}` };
}

/** Schedule triggers that are not archived: all on, and at least one. Pure. */
export function scheduleTriggersOn(triggers: Array<{ kind: string; enabled: boolean; archived: boolean }>): boolean {
  const live = triggers.filter((t) => t.kind === "schedule" && !t.archived);
  return live.length > 0 && live.every((t) => t.enabled);
}

/** Store what the page read about one routine's triggers (only for the plugin's own routines). */
export async function saveRoutineReport(env: Env, companyId: string, params: Record<string, unknown>): Promise<RoutineReport & { key: RoutineKey }> {
  const routineId = typeof params.routineId === "string" && params.routineId.trim() ? params.routineId.trim() : null;
  if (!routineId) throw new SeoError("routineId is required");
  if (!Array.isArray(params.triggers)) throw new SeoError("triggers must be a list");
  const triggers = params.triggers
    .filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === "object")
    .map((t) => ({ kind: String(t.kind ?? ""), enabled: t.enabled === true, archived: t.archived === true }));
  for (const key of ROUTINE_KEYS) {
    const managed = await env.ctx.routines.managed.get(key, companyId);
    if (managed.routineId !== routineId) continue;
    const report: RoutineReport = {
      routineId,
      status: typeof params.status === "string" ? params.status : null,
      triggersOn: scheduleTriggersOn(triggers),
      checkedAt: env.now().toISOString(),
    };
    await env.ctx.state.set(stateKey(companyId, key), report);
    return { ...report, key };
  }
  throw new SeoError("That is not one of the SEO plugin's routines");
}

async function report(env: Env, companyId: string, key: RoutineKey, routineId: string | null): Promise<RoutineReport | null> {
  if (!routineId) return null;
  try {
    const value = (await env.ctx.state.get(stateKey(companyId, key))) as RoutineReport | null;
    return value && value.routineId === routineId && typeof value.triggersOn === "boolean" ? value : null;
  } catch {
    return null;
  }
}

/** Both routines as the page and the checklist see them. Host errors become a missing routine. */
export async function routineViews(env: Env, companyId: string): Promise<RoutineView[]> {
  const out: RoutineView[] = [];
  for (const key of ROUTINE_KEYS) {
    try {
      const managed = await env.ctx.routines.managed.get(key, companyId);
      const r = managed.routine;
      out.push({ key, title: ROUTINE_TITLES[key], id: r?.id ?? null, status: r ? String(r.status) : null, triggersOn: r ? (await report(env, companyId, key, r.id))?.triggersOn ?? null : null });
    } catch (error) {
      env.ctx.logger.info("SEO routine lookup skipped", { key, companyId, error: errorMessage(error) });
      out.push({ key, title: ROUTINE_TITLES[key], id: null, status: null, triggersOn: null });
    }
  }
  return out;
}

/** A routine the plugin created and nobody has changed since. */
function untouched(routine: { updatedByUserId?: string | null; updatedByAgentId?: string | null }): boolean {
  return !routine.updatedByUserId && !routine.updatedByAgentId;
}

/**
 * Routines created paused by older versions go active, unless a person or
 * agent has changed them since (then their choice stands). Returns the keys
 * it switched. Never throws.
 */
export async function activateShippedRoutines(env: Env, companyId: string): Promise<RoutineKey[]> {
  const switched: RoutineKey[] = [];
  for (const key of ROUTINE_KEYS) {
    try {
      const managed = await env.ctx.routines.managed.get(key, companyId);
      const r = managed.routine;
      if (!r || r.status !== "paused" || !r.assigneeAgentId || !untouched(r)) continue;
      await env.ctx.routines.managed.update(key, companyId, { status: "active" });
      switched.push(key);
    } catch (error) {
      env.ctx.logger.info("SEO routine activation skipped", { key, companyId, error: errorMessage(error) });
    }
  }
  return switched;
}

/** The setup item: done only when both routines are active and their schedules are on. Pure. */
export function routinesItem(input: { views: RoutineView[]; agentLinked: boolean }): SetupItem {
  const views = input.views;
  const missing = views.filter((v) => !v.id);
  const off = views.filter((v) => v.id && (v.status !== "active" || v.triggersOn === false));
  const unchecked = views.filter((v) => v.id && v.status === "active" && v.triggersOn === null);
  const done = missing.length === 0 && off.length === 0 && unchecked.length === 0;
  const names = (list: RoutineView[]) => list.map((v) => `"${v.title}"`).join(" and ");
  const base = {
    key: "routines",
    title: "Switch on the SEO routines",
    required: true,
    agentNext: "Every morning the agent sweeps every active sprint, and every Monday it reviews the optimization proposals.",
  };
  if (missing.length && !input.agentLinked) {
    return { ...base, status: "blocked", detail: "Created (switched on) when the SEO agent is linked.", href: "/seo", hrefLabel: "Open SEO", blockedBy: ["agent"] };
  }
  if (missing.length) {
    return { ...base, status: "missing", detail: `${names(missing)} ${missing.length === 1 ? "does" : "do"} not exist yet. Re-sync the SEO agent in Setup → Team to create ${missing.length === 1 ? "it" : "them"}.`, href: "/setup?section=team#team-seo-specialist", hrefLabel: "Open Team in Setup" };
  }
  if (off.length) {
    return {
      ...base,
      status: "missing",
      detail: `${names(off)} ${off.length === 1 ? "is" : "are"} paused or ${off.length === 1 ? "has its" : "have their"} schedule off, so the agent does not run on its own.`,
      href: ROUTINES_SWITCH_ON_PATH,
      hrefLabel: "Switch them on",
      steps: ["Open the link and click **Switch on**: it sets both routines active and their schedules on.", "Or open Routines, set each SEO routine active and switch its schedule trigger on."],
    };
  }
  if (unchecked.length) {
    return { ...base, status: "unknown", detail: "Active, but their schedules have not been checked yet. Open the SEO page once: it checks them itself.", href: "/seo", hrefLabel: "Open SEO" };
  }
  return { ...base, status: "done", detail: "On: daily at 06:30 and Mondays at 07:00.", href: "/routines", hrefLabel: "Open Routines" };
}
