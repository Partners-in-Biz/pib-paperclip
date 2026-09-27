/**
 * Is the weekly routine really on? The worker can read a managed routine's
 * status (`ctx.routines.managed.get`) but not its triggers, and an active
 * routine with its trigger off never runs. The Social page runs as the
 * signed-in board user, who can read the routine's triggers from the host
 * (`GET /api/routines/:id`), so the page reports them here and the setup
 * checklist uses the latest report.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { SocialError } from "./domain.js";

export interface RoutineTriggerReport {
  id: string;
  kind: string;
  enabled: boolean;
  archived: boolean;
}

export interface RoutineReport {
  routineId: string;
  /** The routine's status when the page read it (`active`, `paused`, `archived`). */
  status: string | null;
  /** True when it has a schedule trigger and every live schedule trigger is on. */
  triggersOn: boolean;
  checkedAt: string;
}

function stateKey(companyId: string, routineKey: string) {
  return { scopeKind: "company" as const, scopeId: companyId, namespace: "social-routines", stateKey: `report:${routineKey}` };
}

/** Schedule triggers that are not archived: all on, and at least one. Pure. */
export function scheduleTriggersOn(triggers: Array<Pick<RoutineTriggerReport, "kind" | "enabled" | "archived">>): boolean {
  const live = triggers.filter((t) => t.kind === "schedule" && !t.archived);
  return live.length > 0 && live.every((t) => t.enabled);
}

/** The page's report, checked field by field. Throws on a malformed one. */
export function parseRoutineReport(params: Record<string, unknown>, now = new Date()): RoutineReport {
  const routineId = typeof params.routineId === "string" && params.routineId.trim() ? params.routineId.trim() : null;
  if (!routineId) throw new SocialError("routineId is required");
  if (!Array.isArray(params.triggers)) throw new SocialError("triggers must be a list");
  const triggers = params.triggers
    .filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === "object")
    .map((t) => ({ id: String(t.id ?? ""), kind: String(t.kind ?? ""), enabled: t.enabled === true, archived: t.archived === true }));
  const status = typeof params.status === "string" ? params.status : null;
  return { routineId, status, triggersOn: scheduleTriggersOn(triggers), checkedAt: now.toISOString() };
}

/** Store the page's report for `routineKey` when it is about the routine the plugin manages. */
export async function saveRoutineReport(ctx: PluginContext, companyId: string, routineKey: string, params: Record<string, unknown>): Promise<RoutineReport> {
  const report = parseRoutineReport(params);
  const managed = await ctx.routines.managed.get(routineKey, companyId);
  if (!managed.routineId || managed.routineId !== report.routineId) throw new SocialError("That is not the Social plugin's routine");
  await ctx.state.set(stateKey(companyId, routineKey), report);
  return report;
}

/** The latest report for the routine, or null (never reported, or about an older routine). */
export async function routineReport(ctx: PluginContext, companyId: string, routineKey: string, routineId: string | null): Promise<RoutineReport | null> {
  if (!routineId) return null;
  try {
    const value = (await ctx.state.get(stateKey(companyId, routineKey))) as RoutineReport | null;
    return value && value.routineId === routineId && typeof value.triggersOn === "boolean" ? value : null;
  } catch {
    return null;
  }
}
