/**
 * Routine health: did a plugin's managed routine do its job last time it fired?
 *
 * Why it exists. A routine that fails at dispatch leaves nothing to look at:
 * the host deletes the issue it was about to create and marks the routine run
 * `failed`. "Run today's SEO" failed five days in a row that way and nobody
 * was told. The Cockpit's System health issue only knew about plugin jobs.
 *
 * What a plugin may read. `routine_runs` is not in the host's
 * PLUGIN_DATABASE_CORE_READ_TABLES, so the real error text is out of reach.
 * `ctx.routines.managed.get` does return the routine row, and the host's
 * `updateRoutineTouchedState` sets `lastTriggeredAt` on every firing but
 * `lastEnqueuedAt` only when the firing created or joined an issue. A firing
 * newer than the last enqueue therefore means "fired, produced no work". That
 * is the signal here; the reason sits on the routine's own page (Runs).
 *
 * Limits, on purpose: it sees only the latest firing (not how many failed in a
 * row); a firing the host skipped for a paused routine or an activity gate
 * looks the same, so gated routines are left out and a routine edited after
 * its last firing is not judged until it fires again; the host also skips (and
 * stamps) a firing when the routine's PROJECT is paused, which looks the same
 * too, so a failing routine's project is read when the plugin may read
 * projects and a paused one is left out (a plugin without `projects.read` can
 * raise this check for a paused project; the detail says so); routines of
 * plugins that do not publish through `publishCockpitSnapshot` are not covered.
 *
 * The likely cause is read from the issue template the host dispatches from,
 * the one stored on the routine's plugin binding (`managedByPlugin
 * .defaultsJson`, written at reconcile), falling back to the manifest. The
 * contract test (`contract/routines-contract.spec.ts`) checks manifests only,
 * so a stale stored template is what this check catches after a manifest fix.
 *
 * Who may run it again. Reading a routine's runs (`GET /api/routines/{id}/runs`)
 * is open to every agent of the company; running it
 * (`POST /api/routines/{id}/run`) is allowed only for the routine's assignee or
 * the board. The check's fix text says so, so the Operator hands the run to the
 * assignee instead of calling an endpoint that answers 403.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { HealthCheck } from "./cockpit.js";

/** Edits made this long after the last firing mean "judge again after the next firing" (the host touches the row a moment after firing). */
export const ROUTINE_EDIT_GRACE_MS = 120_000;

/**
 * The rule a managed routine's issue template must follow, in the words used
 * by the contract test and by the health check that names the likely cause.
 */
export const ROUTINE_ORIGIN_RULE =
  'A managed routine\'s issueTemplate may set originId only together with surfaceVisibility "plugin_operation". Without it the host creates the issue with originKind routine_execution, whose originId must be the routine\'s own uuid (the heartbeat looks up routine_runs.routine_id = origin_id, a uuid column), so a text originId such as "routine:seo-run-today" makes every dispatch fail with "invalid input syntax for type uuid". Drop issueTemplate.originId (the host then uses the routine id) or add surfaceVisibility: "plugin_operation".';

export interface RoutineIssueTemplate {
  surfaceVisibility?: string | null;
  originId?: string | null;
  billingCode?: string | null;
}

/** The short fix for a health check (the full rule is ROUTINE_ORIGIN_RULE). */
const ORIGIN_FIX = 'Fix the plugin manifest: drop issueTemplate.originId or add surfaceVisibility "plugin_operation".';
const UUID_ERROR = 'which makes the host fail every dispatch with "invalid input syntax for type uuid"';

/** A description of what is wrong with a routine's issue template, or null when it follows ROUTINE_ORIGIN_RULE. */
export function issueTemplateProblem(template: RoutineIssueTemplate | null | undefined): string | null {
  const originId = typeof template?.originId === "string" ? template.originId.trim() : "";
  if (!originId || template?.surfaceVisibility === "plugin_operation") return null;
  return `issueTemplate.originId is "${originId}" but surfaceVisibility is ${template?.surfaceVisibility ? `"${template.surfaceVisibility}"` : "not set"}`;
}

/** The routine row fields the check reads (dates arrive as Date objects or ISO text). */
export interface RoutineRunState {
  status?: string | null;
  lastTriggeredAt?: Date | string | null;
  lastEnqueuedAt?: Date | string | null;
  updatedAt?: Date | string | null;
  activityGatePolicy?: string | null;
  projectId?: string | null;
  assigneeAgentId?: string | null;
  /** The plugin binding; `defaultsJson.issueTemplate` is what the host dispatches from. */
  managedByPlugin?: { defaultsJson?: { issueTemplate?: RoutineIssueTemplate | null } | null } | null;
}

export type RoutineVerdict =
  | { failed: true; at: string }
  | { failed: false; why: "ok" | "off" | "never-fired" | "gated" | "edited-since" };

function ms(value: Date | string | null | undefined): number {
  if (!value) return Number.NaN;
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

/** Did the routine's latest firing fail to create or join an issue? (pure) */
export function routineLastRun(routine: RoutineRunState): RoutineVerdict {
  if (routine.status !== "active") return { failed: false, why: "off" };
  if (routine.activityGatePolicy && routine.activityGatePolicy !== "always") return { failed: false, why: "gated" };
  const fired = ms(routine.lastTriggeredAt);
  if (Number.isNaN(fired)) return { failed: false, why: "never-fired" };
  const enqueued = ms(routine.lastEnqueuedAt);
  if (!Number.isNaN(enqueued) && enqueued >= fired - 1000) return { failed: false, why: "ok" };
  const edited = ms(routine.updatedAt);
  if (!Number.isNaN(edited) && edited > fired + ROUTINE_EDIT_GRACE_MS) return { failed: false, why: "edited-since" };
  return { failed: true, at: new Date(fired).toISOString() };
}

/** `3 Oct 04:30 UTC`, the same wherever the worker runs. */
function when(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

export interface RoutineCheckInput {
  routineKey: string;
  title: string;
  pluginTitle: string;
  routineId: string | null;
  at: string;
  /** The template the host dispatches from (stored on the routine's binding): null when it has none, undefined when the binding is not readable. */
  template?: RoutineIssueTemplate | null;
  /** The template the plugin's manifest declares now. Used when the stored one is not readable. */
  declared?: RoutineIssueTemplate | null;
  /** The routine's assignee: the only agent that may run it by hand. */
  assigneeAgentId?: string | null;
}

/** The likely cause as a sentence, or null when the template follows ROUTINE_ORIGIN_RULE or is not known to break it. */
function likelyCause(input: RoutineCheckInput): string | null {
  const stored = issueTemplateProblem(input.template);
  if (stored) {
    const fixedInManifest = input.declared !== undefined && input.declared !== null && !issueTemplateProblem(input.declared);
    return fixedInManifest
      ? `Likely cause: the routine's stored issue template has this problem (${stored}), ${UUID_ERROR}. The plugin's manifest is already fixed; the plugin re-applies it to the routine by itself, and the next run then clears this check.`
      : `Likely cause: ${stored}, ${UUID_ERROR}. ${ORIGIN_FIX}`;
  }
  const declared = input.template === undefined ? issueTemplateProblem(input.declared) : null;
  return declared ? `Likely cause: ${declared}, ${UUID_ERROR}. ${ORIGIN_FIX}` : null;
}

/** The health check for a routine whose latest firing created no work (pure). */
export function routineFailedCheck(input: RoutineCheckInput): HealthCheck {
  const reason = likelyCause(input) ?? "The reason is in the routine's run history (plugins cannot read it). A paused project makes the host skip the routine's runs too.";
  const id = input.routineId ?? "{id}";
  const assignee = input.assigneeAgentId ? ` It is assigned to agent ${input.assigneeAgentId}.` : "";
  return {
    key: `routine:${input.routineKey}`,
    title: `${input.pluginTitle} routine "${input.title}" failed its last run`,
    status: "bad",
    detail: `The ${input.pluginTitle} plugin's routine fired on ${when(input.at)} but created no issue, so none of its work was done.${assignee} ${reason}`,
    href: input.routineId ? `/routines/${input.routineId}` : "/routines",
    fix: `Read why: GET /api/routines/${id}/runs (any agent may). Fix the cause; a plugin bug goes to the role that owns code, or to the owner if the company has none. To run it once now: only the routine's assignee (or the owner) may POST /api/routines/${id}/run, so open an issue for the assignee: "Run ${input.title} once now and report". Otherwise this clears at its next scheduled run.`,
    since: input.at,
  };
}

/** Is the routine's project paused? Unknown (no capability, no project, a refused call) counts as not paused. */
async function projectPaused(ctx: PluginContext, row: RoutineRunState, companyId: string): Promise<boolean> {
  if (!row.projectId || !ctx.projects?.get) return false;
  try {
    return !!(await ctx.projects.get(row.projectId, companyId))?.pausedAt;
  } catch {
    return false;
  }
}

/**
 * Checks for every routine this plugin declares, in one company. Never throws:
 * a plugin without routines or without the `routines.managed` capability, or a
 * host that cannot answer, gives no checks (logged).
 */
export async function routineHealth(ctx: PluginContext, companyId: string): Promise<HealthCheck[]> {
  const declared = ctx.manifest?.routines ?? [];
  if (declared.length === 0 || !ctx.routines?.managed) return [];
  const pluginTitle = ctx.manifest.displayName || ctx.manifest.id;
  const checks: HealthCheck[] = [];
  for (const routine of declared) {
    try {
      const found = await ctx.routines.managed.get(routine.routineKey, companyId);
      const row = found.routine;
      if (!row) continue;
      const state = row as unknown as RoutineRunState;
      const verdict = routineLastRun(state);
      if (!verdict.failed || (await projectPaused(ctx, state, companyId))) continue;
      checks.push(
        routineFailedCheck({
          routineKey: routine.routineKey,
          title: row.title || routine.title,
          pluginTitle,
          routineId: found.routineId ?? row.id ?? null,
          at: verdict.at,
          template: state.managedByPlugin?.defaultsJson ? (state.managedByPlugin.defaultsJson.issueTemplate ?? null) : undefined,
          declared: routine.issueTemplate ?? null,
          assigneeAgentId: state.assigneeAgentId ?? null,
        }),
      );
    } catch (error) {
      ctx.logger.info("Routine health check skipped", { routineKey: routine.routineKey, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return checks;
}
