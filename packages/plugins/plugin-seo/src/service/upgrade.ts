/**
 * Plan upgrade to template version 3 for sprints seeded before it: the old
 * person tasks become agent tasks (issue reassigned to the SEO Specialist,
 * title and description rewritten, agent woken), code fixes a person was
 * given go back to the agent, and agent tasks that were blocked on a person
 * are retried with the new tools. Done and skipped tasks are left alone.
 */
import * as db from "../db.js";
import { taskIssueDescription, taskIssueTitle } from "../engine/copy.js";
import { isCodeTask } from "../engine/site-change.js";
import { decideAssignee, TERMINAL_TASK_STATUSES, type AgentAvailability } from "../engine/sprint.js";
import { templateTask, TEMPLATE_V3_CHANGES, TEMPLATE_VERSION } from "../templates/outrank-90.js";
import { assignableUser, cockpitPath, errorMessage, type CompanyInfo, type Env } from "./common.js";
import { sprintCopy } from "./context.js";
import { commentOn, getIssue, OPEN_ISSUE_STATUSES, patchIssue } from "./issues.js";
import { siteCopyFor, taskCopy } from "./tasks.js";

export interface UpgradeResult {
  upgraded: boolean;
  rewritten: number;
  reassigned: number;
  retried: number;
}

const CHANGED = new Set<string>(TEMPLATE_V3_CHANGES);

/** What a task becomes in version 3, or null when it stays as it is. */
export function v3Target(task: db.SprintTask): { owner: "agent"; autopilotEligible: boolean; title: string; playbookKey: string | null; reason: string } | null {
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

export async function upgradeSprintPlan(env: Env, info: CompanyInfo, sprint: db.Sprint, agent: AgentAvailability): Promise<UpgradeResult> {
  const result: UpgradeResult = { upgraded: false, rewritten: 0, reassigned: 0, retried: 0 };
  if (!sprint.seededAt || sprint.templateVersion >= TEMPLATE_VERSION) return result;
  const tasks = await db.listTasks(env.ctx.db, sprint.companyId, sprint.id, { status: ["not_started", "in_progress", "blocked"] });
  for (const original of tasks) {
    const target = v3Target(original);
    const retry = !target && blockedOnPerson(original);
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
    if (!issue || !OPEN_ISSUE_STATUSES.has(String(issue.status)) || String(issue.status) === "in_review") continue;
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
          await env.ctx.issues.requestWakeup(task.issueId, sprint.companyId, { reason: "SEO task moved to the agent (plan v3)", idempotencyKey: `wake:${task.issueId}:v3` });
        } catch (error) {
          env.ctx.logger.info("SEO wake skipped", { issueId: task.issueId, error: errorMessage(error) });
        }
      }
    }
    if (retry) result.retried += 1;
  }
  await db.updateSprint(env.ctx.db, sprint.companyId, sprint.id, { template_version: TEMPLATE_VERSION });
  result.upgraded = true;
  if (sprint.rootIssueId && (result.rewritten > 0 || result.retried > 0)) {
    await commentOn(
      env,
      sprint.companyId,
      sprint.rootIssueId,
      `Plan upgraded to Outrank-90 v${TEMPLATE_VERSION}: ${result.rewritten} task(s) that waited on a person are now the SEO Specialist's (${result.reassigned} open issue(s) reassigned), ${result.retried} blocked task(s) retried. What still needs a person is batched in one weekly **Needs you** issue.`,
    );
  }
  return result;
}
