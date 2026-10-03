/**
 * Plan upgrades for sprints seeded on an older template, done and skipped
 * tasks left alone:
 * - version 3: the old person tasks become agent tasks (issue reassigned to
 *   the SEO Specialist, title and description rewritten, agent woken), code
 *   fixes a person was given go back to the agent, and agent tasks that were
 *   blocked on a person are retried with the new tools;
 * - version 4: the w5/w6 repurpose tasks stop drafting social posts (the
 *   Social agent owns repurposing): they mark the post live and link the
 *   Social drafts, with no sign-off;
 * - version 5: the GEO (AI search) workstream: the plan's eight GEO tasks are
 *   added to every sprint seeded before it, whatever its plan. Nothing that
 *   exists is touched, so a sprint in the middle of its plan keeps working.
 */
import { randomUUID } from "node:crypto";
import * as db from "../db.js";
import { taskIssueDescription, taskIssueTitle } from "../engine/copy.js";
import { isCodeTask } from "../engine/site-change.js";
import { decideAssignee, TERMINAL_TASK_STATUSES, type AgentAvailability } from "../engine/sprint.js";
import { dueDayFor, templateTask, TEMPLATE_V3_CHANGES, TEMPLATE_V4_CHANGES, TEMPLATE_VERSION } from "../templates/outrank-90.js";
import { TEMPLATE_V5_ADDED } from "../templates/geo.js";
import { businessTypeOf, planOf } from "../templates/plans.js";
import { plural } from "../engine/plain.js";
import { assignableUser, cockpitPath, errorMessage, type CompanyInfo, type Env } from "./common.js";
import { sprintCopy } from "./context.js";
import { commentOn, getIssue, OPEN_ISSUE_STATUSES, patchIssue } from "./issues.js";
import { siteCopyFor, taskCopy } from "./tasks.js";

export interface UpgradeResult {
  upgraded: boolean;
  rewritten: number;
  reassigned: number;
  retried: number;
  /** GEO tasks added (version 5). */
  added?: number;
}

/** The GEO tasks of the sprint's plan that the sprint does not have yet (version 5). */
export async function addGeoTasks(env: Env, sprint: db.Sprint): Promise<number> {
  const plan = planOf(sprint.templateId);
  const have = new Set((await db.listTasks(env.ctx.db, sprint.companyId, sprint.id)).map((t) => t.templateKey).filter(Boolean));
  const wanted = plan.tasks.filter((t) => TEMPLATE_V5_ADDED.includes(t.templateKey) && !have.has(t.templateKey));
  if (wanted.length === 0) return 0;
  return db.insertTasks(
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
}

const CHANGED = new Set<string>(TEMPLATE_V3_CHANGES);
const CHANGED_V4 = new Set<string>(TEMPLATE_V4_CHANGES);

type Target = { owner: "agent"; autopilotEligible: boolean; title: string; playbookKey: string | null; reason: string };

/** What a task becomes in version 4, or null when it stays as it is. */
export function v4Target(task: db.SprintTask): Target | null {
  if ((TERMINAL_TASK_STATUSES as string[]).includes(task.status)) return null;
  if (!task.templateKey || !CHANGED_V4.has(task.templateKey)) return null;
  const tpl = templateTask(task.templateKey);
  if (!tpl) return null;
  return { owner: "agent", autopilotEligible: tpl.autopilotEligible, title: tpl.title, playbookKey: tpl.playbook, reason: "The Social agent now owns repurposing: this task marks the post live and links the Social drafts to it (no sign-off needed)." };
}

/** What a task becomes when its sprint is on `fromVersion`, or null. */
export function upgradeTarget(task: db.SprintTask, fromVersion: number): Target | null {
  return (fromVersion < 4 ? v4Target(task) : null) ?? (fromVersion < 3 ? v3Target(task) : null);
}

/** What a task becomes in version 3, or null when it stays as it is. */
export function v3Target(task: db.SprintTask): Target | null {
  if ((TERMINAL_TASK_STATUSES as string[]).includes(task.status)) return null;
  if (task.templateKey && CHANGED.has(task.templateKey)) {
    const tpl = templateTask(task.templateKey);
    if (!tpl) return null;
    return { owner: "agent", autopilotEligible: tpl.autopilotEligible, title: tpl.title, playbookKey: tpl.playbook, reason: "The SEO Specialist now does this itself (service account, site repo and the Search Console / IndexNow / Bing APIs)." };
  }
  if (task.owner === "human" && task.taskType === "gsc-request-index") {
    return { owner: "agent", autopilotEligible: true, title: task.title, playbookKey: task.playbookKey, reason: "Crawling is now requested through the sitemap, IndexNow and URL Inspection APIs." };
  }
  if (task.owner === "human" && isCodeTask(task)) {
    return { owner: "agent", autopilotEligible: task.autopilotEligible, title: task.title, playbookKey: task.playbookKey, reason: "Site code changes are agent work: the SEO Specialist makes them through the site repo." };
  }
  return null;
}

/** An agent task handed to a person as blocked (not a sign-off): retried by the agent. */
function blockedOnPerson(task: db.SprintTask): boolean {
  return task.owner === "agent" && task.status === "blocked" && task.issueStatus === "blocked";
}

function geoUpgradeNote(added: number): string {
  return `Plan v${TEMPLATE_VERSION} adds ${plural(added, "task")} for AI search (GEO): crawler access, llms.txt, organisation data, sampled AI answers, answer blocks and brand consistency. Nothing that was already open changed.`;
}

export async function upgradeSprintPlan(env: Env, info: CompanyInfo, sprint: db.Sprint, agent: AgentAvailability): Promise<UpgradeResult> {
  const result: UpgradeResult = { upgraded: false, rewritten: 0, reassigned: 0, retried: 0 };
  if (!sprint.seededAt || sprint.templateVersion >= TEMPLATE_VERSION) return result;
  // Version 5 adds the GEO tasks to every plan (idempotent on the task key).
  const added = sprint.templateVersion < 5 ? await addGeoTasks(env, sprint) : 0;
  // The v3/v4 rewrites are for the software plan's older tasks; the other plans start on the current version.
  if (businessTypeOf(sprint.templateId) !== "saas") {
    await db.updateSprint(env.ctx.db, sprint.companyId, sprint.id, { template_version: TEMPLATE_VERSION });
    if (added > 0 && sprint.rootIssueId) await commentOn(env, sprint.companyId, sprint.rootIssueId, geoUpgradeNote(added));
    return { ...result, upgraded: true, added };
  }
  const tasks = await db.listTasks(env.ctx.db, sprint.companyId, sprint.id, { status: ["not_started", "in_progress", "blocked"] });
  for (const original of tasks) {
    const target = upgradeTarget(original, sprint.templateVersion);
    const retry = !target && sprint.templateVersion < 3 && blockedOnPerson(original);
    if (!target && !retry) continue;
    const task: db.SprintTask = target
      ? { ...original, owner: target.owner, autopilotEligible: target.autopilotEligible, title: target.title, playbookKey: target.playbookKey }
      : original;
    if (target) {
      await db.updateTask(env.ctx.db, sprint.companyId, task.id, { owner: task.owner, autopilot_eligible: task.autopilotEligible, title: task.title, playbook_key: task.playbookKey });
      result.rewritten += 1;
    }
    if (!task.issueId) continue;
    const issue = await getIssue(env, sprint.companyId, task.issueId);
    // A sign-off already with its reviewer stays there: only v3 moved work between people and agents.
    if (!issue || !OPEN_ISSUE_STATUSES.has(String(issue.status)) || (String(issue.status) === "in_review" && !(target && CHANGED_V4.has(task.templateKey ?? "")))) continue;
    const assignment = decideAssignee({ owner: task.owner, autopilotEligible: task.autopilotEligible, mode: sprint.autopilotMode, agent, ownerUserId: assignableUser(sprint.ownerUserId) });
    const description = taskIssueDescription(taskCopy(task), sprintCopy(sprint), { assignment, context: task.context, cockpitPath: cockpitPath(info, sprint), site: siteCopyFor(sprint, task) });
    const patch = {
      title: taskIssueTitle(task, sprint),
      description,
      status: "todo" as const,
      ...(assignment.kind === "agent" ? { assigneeAgentId: assignment.agentId, assigneeUserId: null } : {}),
    };
    const updated = await patchIssue(env, sprint.companyId, task.issueId, patch);
    if (!updated) continue;
    await db.updateTask(env.ctx.db, sprint.companyId, task.id, {
      status: task.status === "not_started" ? "not_started" : "in_progress",
      blocker_reason: null,
      issue_status: "todo",
      assignee_kind: assignment.kind === "agent" ? "agent" : assignment.kind === "unassigned" ? "unassigned" : task.assigneeKind,
    });
    await commentOn(
      env,
      sprint.companyId,
      task.issueId,
      target
        ? `${target.reason} Reassigned to the SEO Specialist; the steps above are the new playbook. Nothing is needed from a person unless it shows up in the weekly Needs you issue.`
        : "Retrying: the SEO Specialist can now reach the site repo (linked site project) and Search Console (service account). If something is still missing it goes on the weekly Needs you issue instead of this one.",
    );
    if (assignment.kind === "agent") {
      result.reassigned += 1;
      if (assignment.wake) {
        try {
          await env.ctx.issues.requestWakeup(task.issueId, sprint.companyId, { reason: `SEO task moved to the agent (plan v${TEMPLATE_VERSION})`, idempotencyKey: `wake:${task.issueId}:v${TEMPLATE_VERSION}` });
        } catch (error) {
          env.ctx.logger.info("SEO wake skipped", { issueId: task.issueId, error: errorMessage(error) });
        }
      }
    }
    if (retry) result.retried += 1;
  }
  await db.updateSprint(env.ctx.db, sprint.companyId, sprint.id, { template_version: TEMPLATE_VERSION });
  result.upgraded = true;
  result.added = added;
  // One comment, so the sprint's thread grows by one note, not two.
  const notes = [
    result.rewritten > 0 || result.retried > 0
      ? `Plan upgraded to Outrank-90 v${TEMPLATE_VERSION}: ${plural(result.rewritten, "task")} rewritten (${plural(result.reassigned, "open issue")} reassigned to the SEO Specialist), ${plural(result.retried, "blocked task")} retried. Repurposing posts for social is the Social agent's job; the SEO tasks mark posts live and link the drafts. What still needs a person is batched in one weekly **Needs you** issue.`
      : null,
    added > 0 ? geoUpgradeNote(added) : null,
  ].filter(Boolean);
  if (sprint.rootIssueId && notes.length > 0) await commentOn(env, sprint.companyId, sprint.rootIssueId, notes.join(" "));
  return result;
}
