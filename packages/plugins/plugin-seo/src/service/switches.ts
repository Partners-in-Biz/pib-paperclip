/**
 * Switches for the 0.23.0 extras: AI search (GEO), Google Analytics (GA4) and page groups. Each is off, per sprint, until
 * a person turns it on; a company has a default for NEW sprints (also off). Running sprints never follow the default.
 *
 * Who may switch: a signed-in person only. The page's `seo.call` action passes the host's actor, and `set-switch` is a
 * page-only handler (no agent tool); it still checks the actor itself and never reads who changed it from the request.
 * Agents can read the state (`get-switches`) and are refused by every tool of an extra that is off.
 */
import { randomUUID } from "node:crypto";
import * as db from "../db.js";
import { FEATURES, isSwitchFeature, parseSwitches, switchesOf, SWITCH_FEATURES, type SwitchFeature, type Switches } from "../engine/switches.js";
import { OPEN_TASK_STATUSES } from "../engine/sprint.js";
import { plural } from "../engine/plain.js";
import { dueDayFor } from "../templates/outrank-90.js";
import { GEO_TASKS, isGeoTemplateKey } from "../templates/geo.js";
import { actorLabel, companyInfo, reqStr, SeoError, str, type Actor, type CompanyInfo, type Env, type Params } from "./common.js";
import { assertWritable, requireSprint } from "./context.js";
import { commentOn, patchIssue } from "./issues.js";
import { closeNeedsYouItems } from "./needs-you.js";
import { loadServiceAccount } from "./google-access.js";
import { scopeParam } from "./scope.js";

/** The reason a retired GEO task carries, so turning AI search on again can bring exactly those tasks back. */
export const GEO_OFF_NOTE = "AI search (GEO) was switched off for this sprint.";

const GA4_NEEDS_KEY = "Google Analytics needs the Google service account key first (Setup → SEO). Set it, then turn this on.";

/** The signed-in person behind a request, or a refusal. The id comes only from the host's actor, never from the request. */
export function signedInPerson(actor: Actor): string {
  if (actor.kind !== "user" || !actor.userId || !actor.userId.trim()) {
    throw new SeoError("Only a signed-in person can turn these extras on or off. They decide what is done on a client's site and with a client's data, so an agent cannot.");
  }
  return actor.userId;
}

/** An agent tool's guard: the extra must be on for this sprint. */
export function requireOn(sprint: Pick<db.Sprint, "geoEnabled" | "ga4Enabled" | "chunksEnabled">, feature: SwitchFeature, message: string): void {
  if (!switchesOf(sprint)[feature]) throw new SeoError(message);
}

export function isGeoTask(task: Pick<db.SprintTask, "templateKey">): boolean {
  return isGeoTemplateKey(task.templateKey);
}

/**
 * The sprint with its three switches read again. The daily job lists its sprints once and works them one after the other,
 * so a person can switch an extra off while a sprint waits its turn; the rest of that sprint's run follows the switch as it
 * is now (without this, the run could bring back the tasks the switch had just retired). A sprint that cannot be found is
 * returned as it is.
 */
export async function withCurrentSwitches<T extends Pick<db.Sprint, "id" | "companyId" | "geoEnabled" | "ga4Enabled" | "chunksEnabled">>(env: Env, sprint: T): Promise<T> {
  const now = await db.getSprintSwitches(env.ctx.db, sprint.companyId, sprint.id);
  return now ? { ...sprint, geoEnabled: now.geo, ga4Enabled: now.ga4, chunksEnabled: now.chunks } : sprint;
}

// ---------------------------------------------------------------------------
// GEO tasks: added when a person turns AI search on, closed when they turn it off
// ---------------------------------------------------------------------------

/**
 * The AI-search tasks the sprint does not have yet (the daily run opens the due ones within its usual pace), and the ones an
 * earlier "off" retired, brought back. Idempotent on the task key. The caller makes sure the sprint has a plan.
 */
export async function addGeoTasks(env: Env, sprint: Pick<db.Sprint, "id" | "companyId">): Promise<{ added: number; revived: number }> {
  const existing = await db.listTasks(env.ctx.db, sprint.companyId, sprint.id);
  const byKey = new Map(existing.filter((t) => t.templateKey).map((t) => [t.templateKey!, t]));
  let revived = 0;
  for (const task of GEO_TASKS) {
    const have = byKey.get(task.templateKey);
    if (have && have.status === "na" && have.blockerReason === GEO_OFF_NOTE) {
      await db.updateTask(env.ctx.db, sprint.companyId, have.id, {
        status: "not_started",
        blocker_reason: null,
        completed_at: null,
        completed_by: null,
        issue_id: null,
        issue_identifier: null,
        issue_status: null,
        assignee_kind: null,
      });
      revived += 1;
    }
  }
  const wanted = GEO_TASKS.filter((t) => !byKey.has(t.templateKey));
  const added = await db.insertTasks(
    env.ctx.db,
    wanted.map((t) => ({
      id: randomUUID(),
      companyId: sprint.companyId,
      sprintId: sprint.id,
      templateKey: t.templateKey,
      week: t.week,
      phase: t.phase,
      dueDay: dueDayFor(t.week, t.dueDay),
      focus: t.focus,
      title: t.title,
      description: null,
      taskType: t.taskType,
      owner: t.owner,
      autopilotEligible: t.autopilotEligible,
      playbookKey: t.playbook,
      source: "template" as const,
      parentOptimizationId: null,
      context: null,
    })),
  );
  return { added, revived };
}

/** The AI-search tasks that are not finished become "not needed"; their open issues are cancelled with a note. */
export async function retireGeoTasks(env: Env, sprint: db.Sprint, by: string): Promise<{ closed: number; issuesCancelled: number }> {
  const open = (await db.listTasks(env.ctx.db, sprint.companyId, sprint.id, { status: OPEN_TASK_STATUSES })).filter(isGeoTask);
  const now = new Date().toISOString();
  let issuesCancelled = 0;
  for (const task of open) {
    await db.updateTask(env.ctx.db, sprint.companyId, task.id, { status: "na", blocker_reason: GEO_OFF_NOTE, completed_at: now, completed_by: by });
    if (!task.issueId) continue;
    await commentOn(env, sprint.companyId, task.issueId, `${GEO_OFF_NOTE} This task is not needed any more: closed by ${by}.`);
    if (await patchIssue(env, sprint.companyId, task.issueId, { status: "cancelled" })) {
      await db.updateTask(env.ctx.db, sprint.companyId, task.id, { issue_status: "cancelled" });
      issuesCancelled += 1;
    }
  }
  return { closed: open.length, issuesCancelled };
}

// ---------------------------------------------------------------------------
// The views (the page and the get-switches tool)
// ---------------------------------------------------------------------------

export interface SwitchView {
  key: SwitchFeature;
  label: string;
  adds: string;
  detail: string;
  needs: string | null;
  off: string;
  enabled: boolean;
  /** Who made the latest change and when (null: never changed, so it is still off). */
  changedBy: string | null;
  changedAt: string | null;
  effect: Record<string, unknown> | null;
}

function viewOf(state: Switches, log: db.SwitchLogRow[]): SwitchView[] {
  return SWITCH_FEATURES.map((key) => {
    const last = log.find((row) => row.feature === key) ?? null;
    return { ...FEATURES[key], enabled: state[key], changedBy: last?.changedBy ?? null, changedAt: last?.createdAt ?? null, effect: last?.effect ?? null };
  });
}

export async function sprintSwitchViews(env: Env, sprint: db.Sprint): Promise<SwitchView[]> {
  return viewOf(switchesOf(sprint), await db.latestSwitchChanges(env.ctx.db, sprint.companyId, sprint.id).catch(() => []));
}

export async function companySwitchViews(env: Env, companyId: string): Promise<{ views: SwitchView[]; defaults: Switches }> {
  const defaults = await db.getCompanySwitches(env.ctx.db, companyId);
  const state: Switches = { geo: defaults.geo, ga4: defaults.ga4, chunks: defaults.chunks };
  return { views: viewOf(state, await db.latestSwitchChanges(env.ctx.db, companyId, null).catch(() => [])), defaults: state };
}

/** What a new sprint of this company starts with: the company's defaults, and a person's own choice at creation on top. */
export async function startingSwitches(env: Env, companyId: string, actor: Actor, params: Params): Promise<{ switches: Switches; explicit: Partial<Switches> }> {
  const defaults = await db.getCompanySwitches(env.ctx.db, companyId);
  const asked = parseSwitches(params.switches);
  if (asked.errors.length > 0) throw new SeoError(asked.errors.join(" "));
  const explicit = asked.switches;
  if (Object.keys(explicit).length > 0 && actor.kind !== "user") throw new SeoError("Only a person can choose the extras when a sprint is created. They are off unless a person turns them on.");
  // Turning one on needs a signed-in person; choosing "off" for all of them (what the page sends untouched) needs nobody.
  if (Object.values(explicit).some((value) => value === true)) signedInPerson(actor);
  return { switches: { geo: explicit.geo ?? defaults.geo, ga4: explicit.ga4 ?? defaults.ga4, chunks: explicit.chunks ?? defaults.chunks }, explicit };
}

/** A new sprint that starts with an extra on: the trail says by whom (the person who chose it, or the company default). */
export async function logStartingSwitches(env: Env, companyId: string, sprintId: string, start: { switches: Switches; explicit: Partial<Switches> }, actor: Actor): Promise<void> {
  const defaults = await db.getCompanySwitches(env.ctx.db, companyId);
  for (const feature of SWITCH_FEATURES) {
    if (!start.switches[feature]) continue;
    const chosen = start.explicit[feature] === true;
    await db.insertSwitchLog(env.ctx.db, {
      id: randomUUID(),
      companyId,
      sprintId,
      feature,
      scope: "sprint",
      enabled: true,
      changedBy: chosen ? signedInPerson(actor) : `the company default${defaults.updatedBy ? ` (set by ${defaults.updatedBy})` : ""}`,
      effect: { atCreation: true },
    });
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** Agent tool: what is on, per sprint and for new sprints. Read only. */
export async function getSwitchesTool(env: Env, companyId: string, params: Params) {
  const sprintId = str(params, "sprintId");
  const company = await companySwitchViews(env, companyId);
  const base = {
    extras: SWITCH_FEATURES.map((key) => ({ key, label: FEATURES[key].label, adds: FEATURES[key].adds })),
    newSprintsStartWith: company.defaults,
    note: "Every extra is off until a person turns it on for a sprint (SEO page → the sprint → Integrations → Extras). You can read this but never change it, and the tools of an extra that is off refuse and change nothing.",
  };
  if (sprintId) {
    const sprint = await requireSprint(env, companyId, sprintId);
    return { ...base, sprintId: sprint.id, siteName: sprint.siteName, switches: switchesOf(sprint), changes: (await sprintSwitchViews(env, sprint)).map((v) => ({ extra: v.key, enabled: v.enabled, changedBy: v.changedBy, changedAt: v.changedAt })) };
  }
  const sprints = await db.listSprints(env.ctx.db, companyId, { scope: scopeParam(params) });
  return { ...base, sprints: sprints.map((s) => ({ sprintId: s.id, siteName: s.siteName, status: s.status, switches: switchesOf(s) })) };
}

/** Turning Google Analytics on needs the company's Google service account key (nothing can be read without it). */
export async function requireGoogleKeyFor(info: CompanyInfo): Promise<void> {
  const sa = await loadServiceAccount(info);
  if (!sa.key) throw new SeoError(GA4_NEEDS_KEY);
}

/**
 * Page-only: a person turns one extra on or off, for one sprint (`sprintId`) or as the default for the company's new
 * sprints (`scope: "company"`). Always leaves a row in the trail.
 */
export async function setSwitchTool(env: Env, companyId: string, actor: Actor, params: Params) {
  const by = signedInPerson(actor);
  const feature = reqStr(params, "feature");
  if (!isSwitchFeature(feature)) throw new SeoError(`feature must be one of: ${SWITCH_FEATURES.join(", ")}`);
  if (typeof params.enabled !== "boolean") throw new SeoError("enabled must be true or false");
  const enabled = params.enabled;
  const info = await companyInfo(env, companyId);
  if (enabled && feature === "ga4") await requireGoogleKeyFor(info);

  if (str(params, "scope") === "company" && !str(params, "sprintId")) {
    const before = (await db.getCompanySwitches(env.ctx.db, companyId))[feature];
    if (before === enabled) return { scope: "company" as const, feature, enabled, changed: false, note: "Already set." };
    await db.setCompanySwitch(env.ctx.db, companyId, feature, enabled, by);
    await db.insertSwitchLog(env.ctx.db, { id: randomUUID(), companyId, sprintId: null, feature, scope: "company", enabled, changedBy: by, effect: {} });
    return {
      scope: "company" as const,
      feature,
      enabled,
      changed: true,
      note: `${FEATURES[feature].label} will ${enabled ? "start on" : "start off"} for sprints created from now on. Running sprints keep their own setting.`,
    };
  }

  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  assertWritable(sprint);
  const current = switchesOf(sprint)[feature];
  if (current === enabled) return { scope: "sprint" as const, sprintId: sprint.id, feature, enabled, changed: false, note: "Already set." };
  const column = { geo: "geo_enabled", ga4: "ga4_enabled", chunks: "chunks_enabled" }[feature];
  await db.updateSprint(env.ctx.db, companyId, sprint.id, { [column]: enabled });
  const fresh = { ...sprint, geoEnabled: feature === "geo" ? enabled : sprint.geoEnabled, ga4Enabled: feature === "ga4" ? enabled : sprint.ga4Enabled, chunksEnabled: feature === "chunks" ? enabled : sprint.chunksEnabled };
  const effect: Record<string, unknown> = {};
  let note: string;
  if (feature === "geo" && enabled) {
    // A sprint without a 90-day plan gets them when the plan is seeded (seedTemplate reads the switch).
    const result = fresh.seededAt ? await addGeoTasks(env, fresh) : { added: 0, revived: 0 };
    effect.tasksAdded = result.added;
    effect.tasksRevived = result.revived;
    note = fresh.seededAt
      ? `AI search is on: ${plural(result.added + result.revived, "task")} added to this sprint. The daily run opens the ones that are due and checks the site's readiness; nothing else changes.`
      : "AI search is on. The tasks are added when this sprint's 90-day plan starts.";
  } else if (feature === "geo") {
    const result = await retireGeoTasks(env, fresh, by);
    const closedItems = await closeNeedsYouItems(env, info, fresh, ["geo_firewall"], by, "AI search was switched off for this sprint.").catch(() => 0);
    effect.tasksClosed = result.closed;
    effect.issuesCancelled = result.issuesCancelled;
    effect.needsYouClosed = closedItems;
    note = `AI search is off: ${plural(result.closed, "unfinished task")} marked not needed (${plural(result.issuesCancelled, "issue")} cancelled). Nothing is checked or scheduled any more.${
      result.issuesCancelled > 0 ? " A pull request one of those tasks already opened is not closed for you: close it on the repository if you do not want it." : ""
    }`;
  } else if (feature === "ga4" && enabled) {
    await db.ensureIntegration(env.ctx.db, { id: randomUUID(), companyId, sprintId: sprint.id, provider: "ga4", status: "disconnected" });
    note = "Google Analytics is on. The next daily run looks for this site's property (or press Connect on the Integrations tab); it needs the two one-time Google steps listed there.";
  } else if (feature === "ga4") {
    effect.needsYouClosed = await closeNeedsYouItems(env, info, fresh, ["ga4_access", "ga4_api"], by, "Google Analytics was switched off for this sprint.").catch(() => 0);
    note = "Google Analytics is off: nothing is looked up or pulled any more. The numbers already pulled stay.";
  } else {
    note = enabled ? "Page groups are on: big site-wide tasks are split from now on." : "Page groups are off: no new splits. Groups that are already open are finished as planned.";
  }
  await db.insertSwitchLog(env.ctx.db, { id: randomUUID(), companyId, sprintId: sprint.id, feature, scope: "sprint", enabled, changedBy: by, effect });
  if (sprint.rootIssueId) {
    await commentOn(env, companyId, sprint.rootIssueId, `${FEATURES[feature].label} was switched ${enabled ? "on" : "off"} for this sprint by ${actorLabel(actor)}.`).catch(() => undefined);
  }
  return { scope: "sprint" as const, sprintId: sprint.id, feature, enabled, changed: true, effect, note };
}

