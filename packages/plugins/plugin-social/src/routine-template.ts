/**
 * The weekly routine's issue template, as the host stores it.
 *
 * The host reads a managed routine's `issueTemplate` from the binding row it
 * wrote when the routine was reconciled (`plugin_managed_resources.defaults_json`),
 * not from the manifest. Releases before 0.7.2 declared
 * `issueTemplate.originId = "routine:plan-next-week"` without
 * `surfaceVisibility: "plugin_operation"`; for such a template the host opens the
 * run's issue as `routine_execution` with that string as origin id, then looks
 * the run up with it in a uuid column and fails the dispatch (every Monday).
 * Dropping the template from the manifest does not change an existing binding:
 * the host rewrites the binding only on `routines.managed.reconcile`, which is
 * what `healPlanRoutine` calls once per process for each company it serves.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { PLAN_ROUTINE_KEY } from "./platforms.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * True when a binding's stored defaults carry a template the host cannot
 * dispatch: an `originId` that is not the routine's own id, on issues that are
 * not `plugin_operation` ones. Pure.
 */
export function staleRoutineTemplate(defaults: unknown, routineId: string | null): boolean {
  const template = defaults && typeof defaults === "object" ? (defaults as Record<string, unknown>).issueTemplate : null;
  if (!template || typeof template !== "object") return false;
  const t = template as Record<string, unknown>;
  const originId = typeof t.originId === "string" ? t.originId.trim() : "";
  if (!originId || originId === routineId) return false;
  return t.surfaceVisibility !== "plugin_operation";
}

export type HealOutcome = "none" | "current" | "healed" | "stale";

/**
 * Make the live binding of the weekly routine match the manifest: when it still
 * holds a template the host cannot dispatch, reconcile it (the host then rewrites
 * the binding from the manifest and touches nothing else: not the routine's
 * status, assignee, project or triggers) and read it back. Never creates the
 * routine and never throws.
 *
 * - `none`: the company has no such routine (nothing to heal);
 * - `current`: the binding was already fine;
 * - `healed`: it held the old template and now matches the manifest;
 * - `stale`: it still holds the old template (the host has not loaded this
 *   release's manifest yet, or the reconcile failed); tried again later.
 */
export async function healPlanRoutine(ctx: PluginContext, companyId: string): Promise<HealOutcome> {
  try {
    const before = await ctx.routines.managed.get(PLAN_ROUTINE_KEY, companyId);
    const routine = before.routine;
    if (!routine) return "none";
    if (!staleRoutineTemplate(routine.managedByPlugin?.defaultsJson, routine.id)) return "current";
    await ctx.routines.managed.reconcile(PLAN_ROUTINE_KEY, companyId);
    const after = (await ctx.routines.managed.get(PLAN_ROUTINE_KEY, companyId)).routine;
    if (after && staleRoutineTemplate(after.managedByPlugin?.defaultsJson, after.id)) {
      ctx.logger.info("Social weekly routine still holds the old issue template", { companyId, routineId: routine.id });
      return "stale";
    }
    ctx.logger.info("Social weekly routine issue template repaired", { companyId, routineId: routine.id });
    return "healed";
  } catch (error) {
    // Settings not saved for the company (the host refuses its calls), or a host hiccup: the hourly job tries again.
    ctx.logger.info("Social weekly routine check skipped", { companyId, error: errorMessage(error) });
    return "stale";
  }
}
