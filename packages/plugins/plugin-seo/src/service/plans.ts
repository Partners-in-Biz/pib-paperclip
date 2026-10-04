/**
 * `change-plan`: move a running sprint to the 90-day plan that fits the
 * business (local service, professional services, online shop or software).
 *
 * Nothing done or in progress is lost:
 * - tasks of the new plan the sprint lacks are added (the daily run opens the
 *   due ones; this call opens them at once when it can);
 * - a task both plans share and nobody started takes the new plan's wording;
 * - a template task the new plan does not have becomes "not needed" (`na`)
 *   when nobody started it (its open issue is cancelled with a note); started
 *   or blocked ones stay for the agent to finish or skip;
 * - seeded directories the new plan does not use are marked rejected (not
 *   relevant) while still not started, and the new plan's sources are added.
 */
import { randomUUID } from "node:crypto";
import * as db from "../db.js";
import { BUSINESS_TYPES, businessTypeOf, planFor, type BusinessType, type PlanVariant } from "../templates/plans.js";
import { dueDayFor, TEMPLATE_VERSION } from "../templates/outrank-90.js";
import { isGeoTemplateKey } from "../templates/geo.js";
import { actorId, actorLabel, companyInfo, errorMessage, oneOf, reqStr, SeoError, str, type Actor, type Env, type Params } from "./common.js";
import { assertWritable, clockFor, requireSprint } from "./context.js";
import { commentOn, patchIssue } from "./issues.js";
import { resolveAgent } from "./agent.js";
import { materialiseDueTasks } from "./tasks.js";
import { lowerFirst, plural } from "../engine/plain.js";

export interface PlanChange {
  /** New tasks of the target plan. */
  add: db.NewTask[];
  /** Shared tasks nobody started: take the new plan's title, type and sign-off rule. */
  retitle: Array<{ task: db.SprintTask; title: string; taskType: string; autopilotEligible: boolean; focus: string; playbookKey: string }>;
  /** Template tasks the new plan does not have and nobody started: not needed any more. */
  drop: db.SprintTask[];
  /** Template tasks the new plan does not have but someone started: left for the agent. */
  keep: db.SprintTask[];
  /** Seeded sources of the new plan the sprint lacks. */
  addSources: db.NewBacklink[];
  /** Seeded sources the new plan does not use, still not started: marked not relevant. */
  rejectSources: db.Backlink[];
}

/** What moving a sprint to `plan` changes. Pure: `changePlan` applies it. */
export function planChange(input: { sprint: Pick<db.Sprint, "id" | "companyId">; plan: PlanVariant; tasks: db.SprintTask[]; backlinks: db.Backlink[] }): PlanChange {
  const { sprint, plan } = input;
  const byKey = new Map(input.tasks.filter((t) => t.templateKey).map((t) => [t.templateKey!, t]));
  const planKeys = new Map(plan.tasks.map((t) => [t.templateKey, t]));
  const add: db.NewTask[] = plan.tasks
    .filter((t) => !byKey.has(t.templateKey))
    .map((t) => ({
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
    }));
  const retitle: PlanChange["retitle"] = [];
  const drop: db.SprintTask[] = [];
  const keep: db.SprintTask[] = [];
  for (const task of input.tasks) {
    if (task.source !== "template" || !task.templateKey) continue;
    // The AI-search tasks belong to no plan (a person switched them on for this sprint): changing the plan never retires them.
    if (isGeoTemplateKey(task.templateKey)) continue;
    const target = planKeys.get(task.templateKey);
    const untouched = task.status === "not_started" && !task.issueId;
    if (target) {
      if (untouched && (task.title !== target.title || task.taskType !== target.taskType || task.autopilotEligible !== target.autopilotEligible)) {
        retitle.push({ task, title: target.title, taskType: target.taskType, autopilotEligible: target.autopilotEligible, focus: target.focus, playbookKey: target.playbook });
      }
      continue;
    }
    if (task.status === "not_started") drop.push(task);
    else if (task.status === "in_progress" || task.status === "blocked") keep.push(task);
  }
  const domains = new Set(input.backlinks.map((b) => b.domain.toLowerCase()));
  const planDomains = new Set(plan.sources.map((s) => s.domain.toLowerCase()));
  const addSources: db.NewBacklink[] = plan.sources
    .filter((s) => !domains.has(s.domain.toLowerCase()))
    .map((s) => ({
      id: randomUUID(),
      companyId: sprint.companyId,
      sprintId: sprint.id,
      source: s.source,
      domain: s.domain,
      url: null,
      submitUrl: null,
      type: s.type ?? "directory",
      dr: s.dr,
      status: "not_started",
      notes: null,
      discoveredVia: "template",
    }));
  const rejectSources = input.backlinks.filter((b) => b.discoveredVia === "template" && b.status === "not_started" && !planDomains.has(b.domain.toLowerCase()));
  return { add, retitle, drop, keep, addSources, rejectSources };
}

export async function changePlan(env: Env, companyId: string, actor: Actor, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  assertWritable(sprint);
  if (!sprint.seededAt) throw new SeoError("This sprint has no 90-day plan yet. Start one first (the SEO page's Start 90-day plan, with the business type).");
  const to = oneOf(params, "businessType", BUSINESS_TYPES) as BusinessType | undefined;
  if (!to) throw new SeoError(`businessType is required: ${BUSINESS_TYPES.join(", ")}`);
  const from = businessTypeOf(sprint.templateId);
  const plan = planFor(to);
  if (from === to) return { sprintId: sprint.id, businessType: to, plan: plan.label, unchanged: true };
  const reason = str(params, "reason", { max: 1000 }) ?? null;
  const [tasks, backlinks] = await Promise.all([db.listTasks(env.ctx.db, companyId, sprint.id), db.listBacklinks(env.ctx.db, companyId, sprint.id)]);
  const change = planChange({ sprint, plan, tasks, backlinks });
  const note = `Not part of the ${lowerFirst(plan.label)} plan (plan changed from ${lowerFirst(planFor(from).label)}).`;
  const now = new Date().toISOString();

  const added = await db.insertTasks(env.ctx.db, change.add);
  for (const r of change.retitle) {
    await db.updateTask(env.ctx.db, companyId, r.task.id, { title: r.title, task_type: r.taskType, autopilot_eligible: r.autopilotEligible, focus: r.focus, playbook_key: r.playbookKey });
  }
  for (const task of change.drop) {
    await db.updateTask(env.ctx.db, companyId, task.id, { status: "na", blocker_reason: note, completed_at: now, completed_by: actorId(actor) });
    if (task.issueId) {
      await commentOn(env, companyId, task.issueId, `${note} Closed by ${actorLabel(actor)}.`);
      const updated = await patchIssue(env, companyId, task.issueId, { status: "cancelled" });
      if (updated) await db.updateTask(env.ctx.db, companyId, task.id, { issue_status: "cancelled" });
    }
  }
  const sourcesAdded = await db.insertBacklinks(env.ctx.db, change.addSources);
  for (const link of change.rejectSources) {
    await db.updateBacklink(env.ctx.db, companyId, link.id, { status: "rejected", notes: link.notes ? `${link.notes}\n${note}` : note });
  }
  await db.updateSprint(env.ctx.db, companyId, sprint.id, { template_id: plan.id, template_version: TEMPLATE_VERSION });

  // Open what is due now, like a new sprint does; the daily run opens the rest.
  let opened = 0;
  const warnings: string[] = [];
  const fresh = await requireSprint(env, companyId, sprint.id);
  if (fresh.rootIssueId && fresh.status !== "paused") {
    try {
      const info = await companyInfo(env, companyId);
      const result = await materialiseDueTasks(env, { info, sprint: fresh, day: clockFor(fresh, info.today).day, agent: await resolveAgent(env, companyId), projectId: fresh.projectId }, { limit: 12 });
      opened = result.created;
      warnings.push(...result.errors);
    } catch (error) {
      warnings.push(`Opening the due tasks: ${errorMessage(error)}; the daily run retries.`);
    }
  }
  const summary = [
    `Plan changed to **${plan.label}** by ${actorLabel(actor)}${reason ? `: ${reason}` : ""}.`,
    `${plural(added, "task")} added, ${plural(change.drop.length, "task")} not needed any more, ${plural(change.retitle.length, "task")} reworded.`,
    change.keep.length ? `${plural(change.keep.length, "task")} already started stay open: finish or skip them.` : null,
    `${plural(sourcesAdded, "directory or citation", "directories or citations")} added; ${plural(change.rejectSources.length, "seeded source")} marked not relevant.`,
  ].filter(Boolean).join(" ");
  if (fresh.rootIssueId) await commentOn(env, companyId, fresh.rootIssueId, summary);
  return {
    sprintId: sprint.id,
    businessType: to,
    plan: plan.label,
    previous: from,
    tasksAdded: added,
    tasksNotNeeded: change.drop.map((t) => t.title),
    tasksReworded: change.retitle.length,
    tasksStillOpen: change.keep.map((t) => ({ taskId: t.id, title: t.title, status: t.status })),
    sourcesAdded,
    sourcesNotRelevant: change.rejectSources.map((b) => b.domain),
    issuesOpened: opened,
    warnings,
    next: change.keep.length
      ? "Finish or skip-task the tasks that are still open from the old plan; the new plan's due tasks are open."
      : "The new plan's due tasks are open; the daily run opens the rest on their days.",
  };
}
