/**
 * Company goals and the weekly business review, worker part (Q10-3).
 * Rules, progress and the review's text are in `goals-model.ts`.
 *
 * - Agents propose goals (`goal-set`); the owner confirms them once, all
 *   together, through one question the Cockpit asks itself (effect
 *   `cockpit.activate-goals`). A goal the owner sets from a board action is
 *   active at once.
 * - Each active goal is read through `MetricReader`, so a goal about "new
 *   leads this week" uses the number the CRM already reports.
 * - Every Monday, before the Weekly retro, one review issue compares the
 *   week's actuals to the targets for the Operator.
 * - Active goals are mirrored to the host's goals (title, status) when the
 *   plugin may write them (`goals.create` / `goals.update`); the host goal
 *   has no target, so targets stay in the plugin table.
 */
import { randomBytes } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { configSaved, createWorkIssue } from "@partnersinbiz/pib-plugin-kit";
import { recordActivity } from "./activity.js";
import { ORIGIN, ORIGIN_ID } from "./constants.js";
import { listRoles } from "./db.js";
import type { Env } from "./env.js";
import { message, throwIfEveryCompanyFailed } from "./env.js";
import {
  businessReviewContent,
  GOALS_MAX_ACTIVE,
  GoalError,
  goalBrief,
  goalProgress,
  parseGoalInput,
  type GoalProgress,
  type GoalRow,
  type GoalStatus,
  type ReviewGoalRow,
} from "./goals-model.js";
import { linkFor } from "./health.js";
import { MetricReader, metricBetter, parseMetricKey } from "./metrics.js";
import { NAMESPACE } from "./namespace.js";
import { currentRoles, routeFromRoles } from "./roles.js";
import { mondayLabel, previousWeekKey, weekKey } from "./week.js";

const T = {
  goals: `${NAMESPACE}.goals`,
  values: `${NAMESPACE}.goal_values`,
  reviews: `${NAMESPACE}.business_reviews`,
};
type Raw = Record<string, unknown>;

const COLUMNS =
  "id, company_id, title, description, metric_key, metric_label, unit, direction, target_value, baseline_value, period, due_on, status, host_goal_id, owner_agent_id, last_value, last_value_at, proposed_by_agent_id, confirmed_by_user_id, confirmed_at, created_at, updated_at";

const iso = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString();
  if (value == null || value === "") return null;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const str = (value: unknown): string | null => (value == null || value === "" ? null : String(value));
const numOrNull = (value: unknown): number | null => (value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));

function rowFrom(r: Raw): GoalRow {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    title: String(r.title ?? ""),
    description: str(r.description),
    metricKey: String(r.metric_key),
    metricLabel: str(r.metric_label),
    unit: str(r.unit),
    direction: String(r.direction) === "lower" ? "lower" : "higher",
    targetValue: Number(r.target_value),
    baselineValue: numOrNull(r.baseline_value),
    period: String(r.period) as GoalRow["period"],
    dueOn: str(r.due_on),
    status: String(r.status) as GoalStatus,
    hostGoalId: str(r.host_goal_id),
    ownerAgentId: str(r.owner_agent_id),
    lastValue: numOrNull(r.last_value),
    lastValueAt: iso(r.last_value_at),
    proposedByAgentId: str(r.proposed_by_agent_id),
    confirmedByUserId: str(r.confirmed_by_user_id),
    confirmedAt: iso(r.confirmed_at),
    createdAt: iso(r.created_at) ?? "",
    updatedAt: iso(r.updated_at) ?? "",
  };
}

const newId = (): string => `goal${randomBytes(6).toString("hex")}`;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export async function getGoal(ctx: PluginContext, companyId: string, id: string): Promise<GoalRow | null> {
  const rows = await ctx.db.query<Raw>(`SELECT ${COLUMNS} FROM ${T.goals} WHERE company_id = $1 AND id = $2`, [companyId, id]);
  return rows[0] ? rowFrom(rows[0]) : null;
}

export async function listGoals(ctx: PluginContext, companyId: string, statuses?: GoalStatus[]): Promise<GoalRow[]> {
  const rows = await ctx.db.query<Raw>(`SELECT ${COLUMNS} FROM ${T.goals} WHERE company_id = $1 ORDER BY created_at, title LIMIT 100`, [companyId]);
  const all = rows.map(rowFrom);
  return statuses ? all.filter((g) => statuses.includes(g.status)) : all;
}

async function previousValue(ctx: PluginContext, companyId: string, goalId: string, week: string): Promise<number | null> {
  const rows = await ctx.db.query<Raw>(`SELECT value FROM ${T.values} WHERE company_id = $1 AND goal_id = $2 AND week_key = $3`, [companyId, goalId, week]);
  return numOrNull(rows[0]?.value);
}

async function saveValue(ctx: PluginContext, companyId: string, goal: GoalRow, week: string, value: number | null, source: string, at: string): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${T.values} (company_id, goal_id, week_key, value, at, source) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (goal_id, week_key) DO UPDATE SET value = EXCLUDED.value, at = EXCLUDED.at, source = EXCLUDED.source`,
    [companyId, goal.id, week, value, at, source],
  );
  if (value !== null) await ctx.db.execute(`UPDATE ${T.goals} SET last_value = $3, last_value_at = $4 WHERE company_id = $1 AND id = $2`, [companyId, goal.id, value, at]);
}

// ---------------------------------------------------------------------------
// The host goal mirror (best effort)
// ---------------------------------------------------------------------------

type HostGoals = { create?: (input: Record<string, unknown>) => Promise<{ id: string }>; update?: (id: string, patch: Record<string, unknown>, companyId: string) => Promise<unknown> };
const hostGoals = (ctx: PluginContext): HostGoals | null => ((ctx as unknown as { goals?: HostGoals }).goals ?? null);

/** Creates the host goal for a newly active goal; null when the plugin may not (the goal still works). */
async function mirrorCreate(env: Env, goal: GoalRow): Promise<string | null> {
  const goals = hostGoals(env.ctx);
  if (!goals?.create) return null;
  try {
    const created = await goals.create({ companyId: goal.companyId, title: goal.title, description: goal.description ?? undefined, level: "company", status: "active", ...(goal.ownerAgentId ? { ownerAgentId: goal.ownerAgentId } : {}) });
    await env.ctx.db.execute(`UPDATE ${T.goals} SET host_goal_id = $3 WHERE company_id = $1 AND id = $2`, [goal.companyId, goal.id, created.id]);
    return created.id;
  } catch (error) {
    env.ctx.logger.info("Goals: the host goal was not created", { companyId: goal.companyId, goalId: goal.id, error: message(error) });
    return null;
  }
}

async function mirrorStatus(env: Env, goal: GoalRow, status: "active" | "achieved" | "cancelled"): Promise<void> {
  const goals = hostGoals(env.ctx);
  if (!goals?.update || !goal.hostGoalId) return;
  try {
    await goals.update(goal.hostGoalId, { status }, goal.companyId);
  } catch (error) {
    env.ctx.logger.info("Goals: the host goal was not updated", { companyId: goal.companyId, goalId: goal.id, error: message(error) });
  }
}

// ---------------------------------------------------------------------------
// goal-set
// ---------------------------------------------------------------------------

export interface GoalActor {
  agentId: string | null;
  userId: string | null;
}

export interface SetGoalResult {
  goal: GoalRow;
  created: boolean;
  /** An active goal whose target changed goes back to proposed so the owner confirms the new number. */
  reproposed: boolean;
  message: string;
}

const todayIso = (env: Env): string => env.now().toISOString();

/**
 * Creates or changes a goal. A new goal from an agent is `proposed`; from a
 * person (a board action) it is `active`. Changing the target, metric or
 * direction of an active goal asks the owner again. `value` records the
 * actual for a metric nothing reads.
 */
export async function setGoal(env: Env, companyId: string, raw: Record<string, unknown>, actor: GoalActor): Promise<SetGoalResult> {
  const input = parseGoalInput(raw);
  const now = todayIso(env);
  const week = weekKey(env.now());

  if (input.id) {
    const goal = await getGoal(env.ctx, companyId, input.id);
    if (!goal) throw new GoalError(`Goal ${input.id} was not found in this company.`);
    if (input.drop) {
      if (goal.status !== "proposed") throw new GoalError("Only a goal that is still a proposal can be dropped here: dropping a confirmed goal is the owner's call (ask-owner).");
      await env.ctx.db.execute(`UPDATE ${T.goals} SET status = 'dropped', updated_at = $3 WHERE company_id = $1 AND id = $2`, [companyId, goal.id, now]);
      return { goal: (await getGoal(env.ctx, companyId, goal.id))!, created: false, reproposed: false, message: `Dropped the proposed goal "${goal.title}".` };
    }
    if (input.value !== null) {
      if (parseMetricKey(goal.metricKey)?.kind !== "manual") throw new GoalError("This goal is read automatically from its metric; record a value only for a goal whose metricKey is manual.");
      await saveValue(env.ctx, companyId, goal, week, input.value, actor.agentId ? `agent:${actor.agentId}` : "person", now);
    }
    const metricKey = input.metricKey ?? goal.metricKey;
    const direction = input.direction ?? goal.direction;
    const target = input.targetValue ?? goal.targetValue;
    const targetChanged = target !== goal.targetValue || metricKey !== goal.metricKey || direction !== goal.direction;
    // A new number for a confirmed (or finished) goal is the owner's to confirm again; a person changing it is the confirmation.
    let status: GoalStatus = goal.status;
    if (targetChanged && (goal.status === "active" || goal.status === "achieved" || goal.status === "missed")) status = actor.userId ? "active" : "proposed";
    const reproposed = status === "proposed" && goal.status !== "proposed";
    await env.ctx.db.execute(
      `UPDATE ${T.goals} SET title = $3, description = $4, metric_key = $5, metric_label = $6, unit = $7, direction = $8, target_value = $9, baseline_value = $10, period = $11, due_on = $12, owner_agent_id = $13, status = $14, updated_at = $15
        WHERE company_id = $1 AND id = $2`,
      [companyId, goal.id, input.title ?? goal.title, input.description ?? goal.description, metricKey, input.metricLabel ?? goal.metricLabel, input.unit ?? goal.unit, direction, target, input.baselineValue ?? goal.baselineValue, input.period ?? goal.period, input.dueOn ?? goal.dueOn, input.ownerAgentId ?? goal.ownerAgentId, status, now],
    );
    const updated = (await getGoal(env.ctx, companyId, goal.id))!;
    if (reproposed) await mirrorStatus(env, updated, "cancelled");
    return { goal: updated, created: false, reproposed, message: reproposed ? `Changed "${updated.title}". Its target moved, so it is a proposal again until the owner confirms it (one question covers every proposal).` : `Updated "${updated.title}".${input.value !== null ? ` Recorded ${input.value} for this week.` : ""}` };
  }

  const active = (await listGoals(env.ctx, companyId, ["proposed", "active"])).length;
  if (active >= GOALS_MAX_ACTIVE) throw new GoalError(`There are already ${active} goals: more than ${GOALS_MAX_ACTIVE} is a wish list, not a plan. Drop or merge one first.`);
  const metricKey = input.metricKey!;
  const parsed = parseMetricKey(metricKey)!;
  const direction = input.direction ?? metricBetter(parsed) ?? "higher";
  let baseline = input.baselineValue;
  let label = input.metricLabel;
  if (parsed.kind !== "manual") {
    const reading = await new MetricReader(env, companyId).read(metricKey);
    label = label ?? reading.label;
    if (baseline === null) baseline = reading.value;
    if (reading.value === null && parsed.kind === "kpi") throw new GoalError(`${reading.note ?? "That number cannot be read"}. Pick a number a module reports (goal-list sources: true), or use "manual" and record it yourself.`);
  } else if (baseline === null && input.value !== null) baseline = input.value;
  const target = input.targetValue!;
  if (baseline !== null && (direction === "higher" ? target <= baseline : target >= baseline)) {
    throw new GoalError(`The target ${target} is already met: the number stands at ${baseline} and ${direction} is better. Set a target ${direction === "higher" ? "above" : "below"} it.`);
  }
  const id = newId();
  const status: GoalStatus = actor.userId ? "active" : "proposed";
  await env.ctx.db.execute(
    `INSERT INTO ${T.goals} (id, company_id, title, description, metric_key, metric_label, unit, direction, target_value, baseline_value, period, due_on, status, owner_agent_id, proposed_by_agent_id, confirmed_by_user_id, confirmed_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
    [id, companyId, input.title, input.description, metricKey, label, input.unit, direction, target, baseline, input.period ?? "week", input.dueOn, status, input.ownerAgentId ?? actor.agentId, actor.agentId, status === "active" ? actor.userId : null, status === "active" ? now : null, now, now],
  );
  let goal = (await getGoal(env.ctx, companyId, id))!;
  if (input.value !== null && parsed.kind === "manual") await saveValue(env.ctx, companyId, goal, week, input.value, actor.agentId ? `agent:${actor.agentId}` : "person", now);
  if (status === "active") {
    await mirrorCreate(env, goal);
    goal = (await getGoal(env.ctx, companyId, id))!;
  }
  return {
    goal,
    created: true,
    reproposed: false,
    message: status === "active" ? `Goal "${goal.title}" is active.` : `Proposed "${goal.title}". The Cockpit asks the owner once for every proposed goal; you do not need to ask. It becomes active when they say yes.`,
  };
}

// ---------------------------------------------------------------------------
// Confirming
// ---------------------------------------------------------------------------

/** Turns proposed goals into active ones for the owner who said yes. `ids` null = every proposed goal. */
export async function activateGoals(env: Env, companyId: string, ids: string[] | null, userId: string): Promise<GoalRow[]> {
  const now = todayIso(env);
  const proposed = await listGoals(env.ctx, companyId, ["proposed"]);
  const chosen = ids ? proposed.filter((g) => ids.includes(g.id)) : proposed;
  const done: GoalRow[] = [];
  for (const goal of chosen) {
    await env.ctx.db.execute(`UPDATE ${T.goals} SET status = 'active', confirmed_by_user_id = $3, confirmed_at = $4, updated_at = $4 WHERE company_id = $1 AND id = $2 AND status = 'proposed'`, [companyId, goal.id, userId, now]);
    const active = (await getGoal(env.ctx, companyId, goal.id))!;
    if (active.hostGoalId) await mirrorStatus(env, active, "active");
    else await mirrorCreate(env, active);
    await recordActivity(env.ctx, companyId, { key: `goal:${goal.id}:${now.slice(0, 10)}`, kind: "goal", at: now, text: `The owner confirmed the goal "${goal.title}"`, href: "/cockpit", agentId: goal.ownerAgentId }).catch(() => false);
    done.push((await getGoal(env.ctx, companyId, goal.id))!);
  }
  return done;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface GoalView {
  goal: GoalRow;
  progress: GoalProgress;
  note: string | null;
}

/** Every goal with its number now, read through the metric reader, and progress against the last weekly value. */
export async function goalViews(env: Env, companyId: string, statuses: GoalStatus[] = ["active", "proposed"]): Promise<GoalView[]> {
  const reader = new MetricReader(env, companyId);
  const lastWeek = previousWeekKey(env.now());
  const out: GoalView[] = [];
  for (const goal of await listGoals(env.ctx, companyId, statuses)) {
    const parsed = parseMetricKey(goal.metricKey);
    let current: number | null;
    let note: string | null = null;
    if (parsed?.kind === "manual") {
      current = goal.lastValue;
      if (current === null) note = "Nobody has recorded a value yet";
    } else {
      const reading = await reader.read(goal.metricKey);
      current = reading.value;
      note = reading.value === null ? reading.note : null;
    }
    out.push({ goal, progress: goalProgress(goal, current, await previousValue(env.ctx, companyId, goal.id, lastWeek)), note });
  }
  return out;
}

export function goalViewsBrief(views: GoalView[]): Array<Record<string, unknown>> {
  return views.map((v) => ({ ...goalBrief(v.goal, v.progress), ...(v.note ? { note: v.note } : {}) }));
}

/** The Setup checklist numbers: how many goals are confirmed and how many wait for the owner's yes. */
export async function goalCounts(ctx: PluginContext, companyId: string): Promise<{ active: number; proposed: number }> {
  const goals = await listGoals(ctx, companyId, ["proposed", "active", "achieved"]);
  return { active: goals.filter((g) => g.status === "active" || g.status === "achieved").length, proposed: goals.filter((g) => g.status === "proposed").length };
}

// ---------------------------------------------------------------------------
// The weekly business review
// ---------------------------------------------------------------------------

export type ReviewResult = { action: "opened"; issueId: string } | { action: "exists" | "no_goals"; issueId: string | null } | { action: "failed"; reason: string };

/**
 * Records this week's values for every active goal, marks a one-off goal
 * reached or missed, and opens ONE review issue for the Operator. Idempotent
 * for the week.
 */
export async function runBusinessReview(env: Env, companyId: string): Promise<ReviewResult> {
  const now = env.now();
  const week = weekKey(now);
  const goals = await listGoals(env.ctx, companyId, ["active"]);
  if (goals.length === 0) return { action: "no_goals", issueId: null };
  const existing = await env.ctx.db.query<Raw>(`SELECT issue_id FROM ${T.reviews} WHERE company_id = $1 AND week_key = $2`, [companyId, week]);
  if (existing[0]) return { action: "exists", issueId: String(existing[0].issue_id) };

  const views = await goalViews(env, companyId, ["active"]);
  const at = now.toISOString();
  for (const { goal, progress } of views) {
    await saveValue(env.ctx, companyId, goal, week, progress.current, parseMetricKey(goal.metricKey)?.kind === "manual" ? "manual" : "metric", at).catch(() => undefined);
    // A one-off goal (it has a due date) is done once reached, and missed when the date passes first.
    if (goal.dueOn) {
      if (progress.state === "reached") {
        await env.ctx.db.execute(`UPDATE ${T.goals} SET status = 'achieved', updated_at = $3 WHERE company_id = $1 AND id = $2`, [companyId, goal.id, at]);
        await mirrorStatus(env, goal, "achieved");
      } else if (Date.parse(`${goal.dueOn}T23:59:59Z`) < now.getTime()) {
        await env.ctx.db.execute(`UPDATE ${T.goals} SET status = 'missed', updated_at = $3 WHERE company_id = $1 AND id = $2`, [companyId, goal.id, at]);
      }
    }
  }
  const proposedWaiting = (await listGoals(env.ctx, companyId, ["proposed"])).length;
  const company = await env.ctx.companies.get(companyId).catch(() => null);
  const prefix = company?.issuePrefix ?? null;
  const rows: ReviewGoalRow[] = views.map((v) => ({ goal: v.goal, progress: v.progress, note: v.note }));
  const content = businessReviewContent({ weekLabel: mondayLabel(now), rows, proposedWaiting, cockpitHref: linkFor("/cockpit", prefix) });
  const route = routeFromRoles(await currentRoles(env, companyId), ["operator"]);
  try {
    const issue = await createWorkIssue(env.ctx, {
      companyId,
      title: content.title,
      description: content.description,
      priority: rows.some((r) => r.progress.state === "behind") ? "high" : "medium",
      originKind: ORIGIN.businessReview as `plugin:${string}`,
      originId: `${ORIGIN_ID.businessReview}${companyId}:${week}`,
      ...(route.assigneeAgentId ? { assigneeAgentId: route.assigneeAgentId } : route.assigneeUserId ? { assigneeUserId: route.assigneeUserId } : {}),
      wakeReason: "Weekly business review",
    });
    await env.ctx.db.execute(`INSERT INTO ${T.reviews} (company_id, week_key, issue_id, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (company_id, week_key) DO NOTHING`, [companyId, week, issue.id, at]);
    await recordActivity(env.ctx, companyId, { key: `business-review:${week}`, kind: "business_review", at, text: `Opened the weekly business review (${rows.length} goals)`, href: `/issues/${issue.id}`, agentId: route.assigneeAgentId }).catch(() => false);
    return { action: "opened", issueId: issue.id };
  } catch (error) {
    return { action: "failed", reason: message(error) };
  }
}

/** Weekly job: every company with saved Cockpit settings. */
export async function businessReviews(env: Env): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  let tried = 0;
  for (const row of await listRoles(env.ctx)) {
    if (!(await configSaved(env.ctx, row.companyId))) continue;
    tried += 1;
    let key: string;
    try {
      key = (await runBusinessReview(env, row.companyId)).action;
    } catch (error) {
      key = "failed";
      env.ctx.logger.info("Business review failed for a company", { companyId: row.companyId, error: message(error) });
    }
    counts[key] = (counts[key] ?? 0) + 1;
  }
  throwIfEveryCompanyFailed("The weekly business review", tried, counts.failed ?? 0);
  return counts;
}
