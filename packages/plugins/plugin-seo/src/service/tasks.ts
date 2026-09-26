/**
 * Sprint tasks ↔ Paperclip issues: materialisation, two-way status sync, and
 * the task tools (start, complete, block, skip, add).
 */
import { randomUUID } from "node:crypto";
import { reviewerAgentId, wakeIssue } from "@partnersinbiz/pib-plugin-kit";
import { ORIGIN } from "../constants.js";
import * as db from "../db.js";
import { blockComment, completionComment, taskIssueDescription, taskIssueTitle, type EvidenceArtifact, type SiteCopy, type TaskCopy } from "../engine/copy.js";
import { branchFor, isCodeTask } from "../engine/site-change.js";
import { completionBlocker } from "../engine/guards.js";
import {
  decideAssignee,
  needsSignoff,
  selectDueTasks,
  taskStatusFromIssue,
  TERMINAL_TASK_STATUSES,
  type AgentAvailability,
  type TaskStatus,
} from "../engine/sprint.js";
import { dueDayFor, phaseForWeek } from "../templates/outrank-90.js";
import {
  actorId,
  actorLabel,
  assignableUser,
  bool,
  cockpitPath,
  errorMessage,
  num,
  oneOf,
  reqStr,
  SeoError,
  str,
  strList,
  type Actor,
  type CompanyInfo,
  type Env,
  type Params,
} from "./common.js";
import { assertWritable, loadSprintContext, sprintCopy } from "./context.js";
import { commentOn, getIssue, OPEN_ISSUE_STATUSES, openIssue, patchIssue } from "./issues.js";
import { resolveAgent } from "./agent.js";
import { addNeedsYou } from "./needs-you.js";
import { publishTaskDone } from "./handoff.js";
import { signoffReviewBrief } from "./review.js";
import { linkSiteItem } from "../engine/items.js";

export function taskCopy(task: db.SprintTask): TaskCopy {
  return {
    id: task.id,
    title: task.title,
    week: task.week,
    phase: task.phase,
    focus: task.focus,
    taskType: task.taskType,
    owner: task.owner,
    autopilotEligible: task.autopilotEligible,
    playbookKey: task.playbookKey,
    source: task.source,
    description: task.description,
  };
}

export interface MaterialiseContext {
  info: CompanyInfo;
  sprint: db.Sprint;
  day: number;
  agent: AgentAvailability;
  projectId: string | null;
}

/** Site repo facts for a code task's issue, or null when the task does not change the site. */
export function siteCopyFor(sprint: db.Sprint, task: db.SprintTask): SiteCopy | null {
  if (!isCodeTask(task)) return null;
  return {
    access: sprint.siteAccess,
    repoUrl: sprint.repoUrl,
    defaultBranch: sprint.defaultBranch,
    branch: branchFor(task),
    changePolicy: sprint.changePolicy,
    hosting: sprint.hosting,
  };
}

/** A person's task on a running sprint: one line in the Needs you digest instead of its own issue. */
async function humanTaskToDigest(env: Env, mc: MaterialiseContext, task: db.SprintTask): Promise<void> {
  const text = task.description?.trim();
  await addNeedsYou(env, mc.info, mc.sprint, {
    key: `task:${task.id}`,
    kind: "task",
    title: task.title,
    why: text || "A task only a person can do (added to the sprint by hand).",
    steps: [],
    links: [],
    after: "Marks the task done in the sprint and carries on with the plan.",
    check: "manual",
    taskIds: [task.id],
  });
  await db.updateTask(env.ctx.db, mc.sprint.companyId, task.id, { status: "in_progress", assignee_kind: "needs_you", started_at: task.startedAt ?? new Date().toISOString() });
}

export async function createTaskIssue(env: Env, mc: MaterialiseContext, task: db.SprintTask): Promise<string | null> {
  const { sprint, info } = mc;
  if (task.owner === "human" && sprint.autopilotMode !== "off") {
    await humanTaskToDigest(env, mc, task);
    return null;
  }
  const code = isCodeTask(task) && task.owner === "agent" && sprint.autopilotMode !== "off";
  if (code && sprint.siteAccess === "unlinked") {
    // Waits for the site repo link; the digest asks for it once for all such tasks.
    await addNeedsYou(env, info, sprint, linkSiteItem(info, sprint, [task.id]));
    return null;
  }
  const projectId = code && sprint.siteAccess === "repo" && sprint.siteProjectId ? sprint.siteProjectId : mc.projectId ?? sprint.projectId;
  if (!(await db.claimTaskForIssue(env.ctx.db, sprint.companyId, task.id))) return null;
  try {
    const assignment = decideAssignee({
      owner: task.owner,
      autopilotEligible: task.autopilotEligible,
      mode: sprint.autopilotMode,
      agent: mc.agent,
      ownerUserId: assignableUser(sprint.ownerUserId),
    });
    const description = taskIssueDescription(taskCopy(task), sprintCopy(sprint), {
      assignment,
      context: task.context,
      cockpitPath: cockpitPath(info, sprint),
      site: siteCopyFor(sprint, task),
    });
    const created = await openIssue(env, {
      companyId: sprint.companyId,
      title: taskIssueTitle(task, sprint),
      description,
      originKind: ORIGIN.task,
      originId: task.id,
      projectId,
      parentId: sprint.rootIssueId,
      assigneeAgentId: assignment.kind === "agent" ? assignment.agentId : null,
      assigneeUserId: assignment.kind === "user" ? assignment.userId : null,
      wake: assignment.kind === "agent" ? assignment.wake : false,
      wakeReason: `SEO task due: ${task.title}`,
    });
    // Agent work that ended up unassigned (agent missing, or the create fell back) is adopted on activation.
    const assigneeKind = created.assigned !== "none" ? created.assigned : assignment.kind === "user" ? "none" : "unassigned";
    await db.updateTask(env.ctx.db, sprint.companyId, task.id, { issue_id: created.id, issue_status: "todo", assignee_kind: assigneeKind, issue_project_id: projectId ?? null });
    return created.id;
  } catch (error) {
    await db.releaseTaskClaim(env.ctx.db, sprint.companyId, task.id);
    throw error;
  }
}

/** Open sub-issues for due tasks that have none yet (idempotent). */
export async function materialiseDueTasks(
  env: Env,
  mc: MaterialiseContext,
  opts: { limit?: number; onlyTaskIds?: string[] } = {},
): Promise<{ created: number; remaining: number; errors: string[] }> {
  if (!mc.sprint.rootIssueId) return { created: 0, remaining: 0, errors: ["Sprint has no root issue yet"] };
  const tasks = await db.listTasks(env.ctx.db, mc.sprint.companyId, mc.sprint.id, { status: ["not_started"] });
  let due = selectDueTasks(tasks, mc.day);
  if (opts.onlyTaskIds) {
    const only = new Set(opts.onlyTaskIds);
    due = due.filter((task) => only.has(task.id));
  }
  const limit = opts.limit ?? 60;
  const errors: string[] = [];
  let created = 0;
  for (const task of due.slice(0, limit)) {
    try {
      if (await createTaskIssue(env, mc, task)) created += 1;
    } catch (error) {
      errors.push(`${task.title}: ${errorMessage(error)}`);
    }
  }
  return { created, remaining: Math.max(0, due.length - limit), errors };
}

// ---------------------------------------------------------------------------
// Issue → task sync (events and the daily heal)
// ---------------------------------------------------------------------------

type IssueLike = { id: string; status: string; identifier?: string | null };

export async function syncTaskFromIssue(env: Env, task: db.SprintTask, issue: IssueLike): Promise<{ changed: boolean; status: TaskStatus }> {
  const patch: Record<string, unknown> = {};
  if (issue.identifier && issue.identifier !== task.issueIdentifier) patch.issue_identifier = issue.identifier;
  let status = task.status;
  const issueStatus = String(issue.status);
  if (issueStatus !== task.issueStatus) {
    patch.issue_status = issueStatus;
    const next = taskStatusFromIssue(issueStatus, task.status);
    if (next) {
      status = next;
      patch.status = next;
      if (next === "done") {
        patch.completed_at = task.completedAt ?? new Date().toISOString();
        patch.completed_by = task.completedBy ?? "issue";
        patch.blocker_reason = null;
      }
      if (next === "in_progress") {
        if (!task.startedAt) patch.started_at = new Date().toISOString();
        if (task.status === "blocked") patch.blocker_reason = null;
        if (task.status === "done") patch.completed_at = null;
      }
      if (next === "blocked" && !task.blockerReason) patch.blocker_reason = "Blocked in Paperclip";
      if (next === "skipped" && !task.blockerReason) patch.blocker_reason = "Issue cancelled";
    }
  } else if ((TERMINAL_TASK_STATUSES as string[]).includes(task.status) && OPEN_ISSUE_STATUSES.has(issueStatus)) {
    // We closed the task but closing the issue failed earlier: retry.
    const target = task.status === "done" ? "done" : "cancelled";
    const updated = await patchIssue(env, task.companyId, issue.id, { status: target });
    if (updated) patch.issue_status = target;
  }
  if (Object.keys(patch).length === 0) return { changed: false, status };
  await db.updateTask(env.ctx.db, task.companyId, task.id, patch);
  return { changed: true, status };
}

/** Event handler for `issue.updated`: idempotent, re-reads the issue. */
export async function onIssueUpdated(env: Env, companyId: string, issueId: string): Promise<void> {
  const task = await db.getTaskByIssue(env.ctx.db, companyId, issueId);
  if (!task) return;
  const issue = await getIssue(env, companyId, issueId);
  if (!issue) return;
  const result = await syncTaskFromIssue(env, task, { id: issue.id, status: String(issue.status), identifier: issue.identifier ?? null });
  if (result.changed && result.status === "done" && task.status !== "done") {
    await followUpApprovedPr(env, task);
    await publishTaskDone(env, companyId, task.id);
  }
}

/** GitHub pull request links in a task's sign-off hand-off. */
export function approvedPrLinks(task: Pick<db.SprintTask, "evidence">): string[] {
  const handoff = (task.evidence?.handoff ?? null) as { review?: boolean; links?: unknown } | null;
  if (!handoff?.review || !Array.isArray(handoff.links)) return [];
  return handoff.links.filter((l): l is string => typeof l === "string" && /github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(l));
}

/**
 * A person approved a sign-off task by closing its issue. When the hand-off
 * carried a PR, the agent gets a follow-up task to merge it and re-check
 * production (the person never has to merge).
 */
async function followUpApprovedPr(env: Env, task: db.SprintTask): Promise<void> {
  const prs = approvedPrLinks(task);
  if (prs.length === 0) return;
  try {
    await addTask(env, task.companyId, { kind: "system" }, {
      sprintId: task.sprintId,
      title: `Merge the approved PR: ${task.title}`.slice(0, 240),
      description: `The owner approved "${task.title}" (issue closed). Merge ${prs.join(", ")} once its checks are green (the approval covers the content), wait for the deploy, re-check production and complete this task with the evidence.`,
      taskType: "code-fix",
      owner: "agent",
      autopilotEligible: true,
    });
  } catch (error) {
    env.ctx.logger.info("SEO approved-PR follow-up not created", { taskId: task.id, error: errorMessage(error) });
  }
}

/** Daily heal for missed events: re-read open tasks' issues. Bounded. */
export async function healTasks(env: Env, sprint: db.Sprint, limit = 80): Promise<number> {
  const tasks = await db.listTasks(env.ctx.db, sprint.companyId, sprint.id, { status: ["not_started", "in_progress", "blocked", "done", "skipped"] });
  const candidates = tasks
    .filter((task) => task.issueId && task.issueStatus !== "creating")
    .filter((task) => !(TERMINAL_TASK_STATUSES as string[]).includes(task.status) || (task.issueStatus && OPEN_ISSUE_STATUSES.has(task.issueStatus)) || !task.issueIdentifier)
    .slice(0, limit);
  let changed = 0;
  for (const task of candidates) {
    const issue = await getIssue(env, sprint.companyId, task.issueId!);
    if (!issue) continue;
    const result = await syncTaskFromIssue(env, task, { id: issue.id, status: String(issue.status), identifier: issue.identifier ?? null });
    if (result.changed) changed += 1;
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Task tools
// ---------------------------------------------------------------------------

async function requireTask(env: Env, companyId: string, params: Params): Promise<db.SprintTask> {
  const id = reqStr(params, "taskId");
  const task = await db.getTask(env.ctx.db, companyId, id);
  if (!task) throw new SeoError(`Task ${id} was not found`);
  return task;
}

function taskView(task: db.SprintTask) {
  return {
    taskId: task.id,
    sprintId: task.sprintId,
    title: task.title,
    week: task.week,
    phase: task.phase,
    focus: task.focus,
    taskType: task.taskType,
    owner: task.owner,
    autopilotEligible: task.autopilotEligible,
    status: task.status,
    source: task.source,
    issueId: task.issueId,
    issueIdentifier: task.issueIdentifier,
    blockerReason: task.blockerReason,
    humanAsk: task.humanAsk,
    dueDay: task.dueDay,
    completedAt: task.completedAt,
  };
}

export async function listTasksTool(env: Env, companyId: string, params: Params) {
  const sprintId = reqStr(params, "sprintId");
  const statusParam = strList(params, "status");
  const tasks = await db.listTasks(env.ctx.db, companyId, sprintId, {
    status: statusParam.length > 0 ? statusParam : undefined,
    week: num(params, "week", { integer: true, min: 0, max: 200 }),
    owner: oneOf(params, "owner", ["agent", "human"] as const),
    source: oneOf(params, "source", ["template", "manual", "optimization"] as const),
  });
  const { clock } = await loadSprintContext(env, companyId, sprintId);
  const dueOnly = bool(params, "dueOnly") ?? false;
  const list = dueOnly ? tasks.filter((t) => t.dueDay == null || t.dueDay <= clock.day) : tasks;
  return { sprintId, day: clock.day, week: clock.week, count: list.length, tasks: list.map(taskView) };
}

export async function startTask(env: Env, companyId: string, actor: Actor, params: Params) {
  const task = await requireTask(env, companyId, params);
  if (task.status === "done") throw new SeoError("This task is already done");
  const patch: Record<string, unknown> = { status: "in_progress", blocker_reason: null };
  if (!task.startedAt) patch.started_at = new Date().toISOString();
  await db.updateTask(env.ctx.db, companyId, task.id, patch);
  const note = str(params, "note", { max: 2000 });
  if (note && task.issueId) await commentOn(env, companyId, task.issueId, `Started by ${actorLabel(actor)}: ${note}`);
  return { ...taskView({ ...task, status: "in_progress" }) };
}

function parseEvidence(params: Params): { summary: string; links: string[]; artifacts: EvidenceArtifact[] } {
  const summary = reqStr(params, "summary", { max: 8000 });
  const links = strList(params, "links", { max: 30, itemMax: 1000 });
  const raw = params.artifacts;
  const artifacts: EvidenceArtifact[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw.slice(0, 30)) {
      if (!item || typeof item !== "object") continue;
      const a = item as Record<string, unknown>;
      const label = typeof a.label === "string" && a.label.trim() ? a.label.trim().slice(0, 200) : "artifact";
      artifacts.push({
        label,
        url: typeof a.url === "string" ? a.url.slice(0, 1000) : null,
        value: typeof a.value === "string" ? a.value.slice(0, 4000) : a.value != null ? JSON.stringify(a.value).slice(0, 4000) : null,
      });
    }
  }
  return { summary, links, artifacts };
}

export async function completeTask(env: Env, companyId: string, actor: Actor, params: Params) {
  const task = await requireTask(env, companyId, params);
  if (task.status === "done") return { ...taskView(task), alreadyDone: true };
  const { sprint } = await loadSprintContext(env, companyId, task.sprintId);
  assertWritable(sprint);
  const evidence = parseEvidence(params);
  if (actor.kind === "agent") {
    if (sprint.autopilotMode === "safe" && needsSignoff(task, sprint.autopilotMode)) {
      throw new SeoError(
        "This task needs the owner's sign-off in safe mode. Call block-task with review: true, a clear humanAsk and your links; the owner completes it by marking the issue done.",
      );
    }
    const blocker = completionBlocker(task.taskType, await db.completionFacts(env.ctx.db, sprint.id));
    if (blocker) throw new SeoError(blocker);
  }
  const now = new Date().toISOString();
  const record = { ...evidence, by: actorId(actor), byKind: actor.kind, at: now, previous: task.evidence ?? undefined };
  await db.updateTask(env.ctx.db, companyId, task.id, {
    status: "done",
    completed_at: now,
    completed_by: actorId(actor),
    evidence: record,
    blocker_reason: null,
  });
  let issueClosed = false;
  if (task.issueId) {
    await commentOn(env, companyId, task.issueId, completionComment({ ...evidence, by: actorLabel(actor) }));
    const updated = await patchIssue(env, companyId, task.issueId, { status: "done" });
    if (updated) {
      issueClosed = true;
      await db.updateTask(env.ctx.db, companyId, task.id, { issue_status: "done" });
    }
  }
  await publishTaskDone(env, companyId, task.id);
  return { ...taskView({ ...task, status: "done", completedAt: now }), issueClosed };
}

export async function blockTask(env: Env, companyId: string, actor: Actor, params: Params) {
  const task = await requireTask(env, companyId, params);
  if ((TERMINAL_TASK_STATUSES as string[]).includes(task.status)) throw new SeoError(`This task is already ${task.status}`);
  const { sprint, info } = await loadSprintContext(env, companyId, task.sprintId);
  const reason = reqStr(params, "reason", { max: 4000 });
  const humanAsk = reqStr(params, "humanAsk", { max: 4000 });
  const review = bool(params, "review") ?? false;
  const links = strList(params, "links", { max: 20, itemMax: 1000 });
  const status: TaskStatus = review ? "in_progress" : "blocked";
  const handoff = { reason, humanAsk, review, links, by: actorId(actor), at: new Date().toISOString() };
  await db.updateTask(env.ctx.db, companyId, task.id, {
    status,
    blocker_reason: review ? null : reason,
    human_ask: humanAsk,
    evidence: { ...(task.evidence ?? {}), handoff },
  });
  // Every hand-off is one line in this week's Needs you digest.
  const digest = await addNeedsYou(env, info, sprint, {
    key: `${review ? "review" : "task"}:${task.id}`,
    kind: review ? "review" : "task",
    title: review ? `Sign off: ${task.title}` : task.title,
    why: reason,
    steps: [humanAsk],
    links: links.map((url) => ({ label: url.replace(/^https?:\/\//, "").slice(0, 60), url })),
    after: review ? "Publishes / sends it and closes the task." : "Picks the task up again (its issue goes back to the SEO Specialist).",
    check: review ? "task_done" : "manual",
    taskIds: [task.id],
  }, { reopen: true }).catch((error: unknown) => {
    env.ctx.logger.info("SEO needs-you add failed", { taskId: task.id, error: errorMessage(error) });
    return null;
  });
  let reassigned = false;
  let reviewed = false;
  if (task.issueId) {
    await commentOn(env, companyId, task.issueId, blockComment({ reason, humanAsk, review, links }));
    // Sign-off goes to the owner's review queue; a blocked task stays with the agent until the digest item is done.
    // With a Cockpit Reviewer, the Reviewer checks it first and hands it to the owner.
    const owner = review ? assignableUser(sprint.ownerUserId) : null;
    const reviewer = review ? await reviewerAgentId(env.ctx, companyId) : null;
    const issueStatus = review ? "in_review" : "blocked";
    const patch = reviewer
      ? { status: issueStatus, assigneeAgentId: reviewer, assigneeUserId: null }
      : owner
        ? { status: issueStatus, assigneeAgentId: null, assigneeUserId: owner }
        : { status: issueStatus };
    const updated = await patchIssue(env, companyId, task.issueId, patch as Parameters<typeof patchIssue>[3]);
    if (updated) {
      reassigned = Boolean(owner || reviewer);
      reviewed = Boolean(reviewer);
      await db.updateTask(env.ctx.db, companyId, task.id, { issue_status: issueStatus, assignee_kind: reviewer ? "reviewer" : owner ? "user" : task.assigneeKind });
      if (reviewer) {
        await commentOn(env, companyId, task.issueId, signoffReviewBrief(task.title, owner));
        await wakeIssue(env.ctx, task.issueId, companyId, "SEO sign-off needs a review");
      }
    }
  }
  return {
    ...taskView({ ...task, status, blockerReason: review ? null : reason, humanAsk }),
    handedTo: review
      ? reviewed
        ? "the Reviewer, then the sprint owner"
        : reassigned
          ? "sprint owner"
          : "nobody (the sprint has no owner; the issue keeps its assignee)"
      : "the Needs you digest",
    needsYouIssueId: digest?.issueId ?? null,
  };
}

export async function skipTask(env: Env, companyId: string, actor: Actor, params: Params) {
  const task = await requireTask(env, companyId, params);
  if (task.status === "skipped") return { ...taskView(task), alreadySkipped: true };
  if (task.status === "done") throw new SeoError("This task is already done");
  const reason = reqStr(params, "reason", { max: 2000 });
  await db.updateTask(env.ctx.db, companyId, task.id, {
    status: "skipped",
    blocker_reason: reason,
    completed_at: new Date().toISOString(),
    completed_by: actorId(actor),
  });
  if (task.issueId) {
    await commentOn(env, companyId, task.issueId, `Skipped by ${actorLabel(actor)}: ${reason}`);
    const updated = await patchIssue(env, companyId, task.issueId, { status: "cancelled" });
    if (updated) await db.updateTask(env.ctx.db, companyId, task.id, { issue_status: "cancelled" });
  }
  return { ...taskView({ ...task, status: "skipped", blockerReason: reason }) };
}

export async function addTask(env: Env, companyId: string, actor: Actor, params: Params) {
  const sprintId = reqStr(params, "sprintId");
  const ctx = await loadSprintContext(env, companyId, sprintId);
  assertWritable(ctx.sprint);
  const week = num(params, "week", { integer: true, min: 0, max: 200 }) ?? ctx.clock.week;
  const title = reqStr(params, "title", { max: 240 });
  const taskType = str(params, "taskType", { max: 60 }) ?? "custom";
  const requestedOwner = oneOf(params, "owner", ["agent", "human"] as const) ?? "agent";
  // Site changes are agent work: the agent makes them through the site repo.
  const codeWork = isCodeTask({ taskType, title, source: "manual" });
  const owner = requestedOwner === "human" && codeWork ? "agent" : requestedOwner;
  const id = randomUUID();
  const dueNow = week <= ctx.clock.week;
  await db.insertTasks(env.ctx.db, [{
    id,
    companyId,
    sprintId,
    templateKey: null,
    week,
    phase: phaseForWeek(week),
    dueDay: dueNow ? (ctx.clock.day <= 0 ? null : ctx.clock.day) : dueDayFor(week),
    focus: str(params, "focus", { max: 80 }) ?? "Manual",
    title,
    description: str(params, "description", { max: 8000 }) ?? null,
    taskType,
    owner,
    autopilotEligible: bool(params, "autopilotEligible") ?? true,
    playbookKey: str(params, "playbook", { max: 60 }) ?? "custom",
    source: "manual",
    parentOptimizationId: null,
    context: actor.kind === "agent" ? `Added by the SEO Specialist.` : null,
  }]);
  let issueId: string | null = null;
  const createIssue = bool(params, "createIssue") ?? true;
  if (createIssue && dueNow && ctx.sprint.rootIssueId && ctx.sprint.status !== "paused") {
    const task = await db.getTask(env.ctx.db, companyId, id);
    if (task) {
      issueId = await createTaskIssue(env, {
        info: ctx.info,
        sprint: ctx.sprint,
        day: ctx.clock.day,
        agent: await resolveAgent(env, companyId),
        projectId: ctx.sprint.projectId,
      }, task);
    }
  }
  return {
    taskId: id,
    sprintId,
    week,
    owner,
    issueId,
    due: dueNow,
    ...(owner !== requestedOwner ? { note: "Code and content changes are agent work: the SEO Specialist makes them through the site repo, so this task is the agent's." } : {}),
    ...(owner === "human" ? { note: "Tasks for a person go on the sprint's weekly Needs you issue instead of an issue of their own." } : {}),
  };
}

/**
 * After the site repo is linked: open code tasks whose issue sits outside the
 * site project move there (the old issue is cancelled with a pointer), so the
 * agent runs them in the repo workspace. Work in progress stays put.
 */
export async function relocateCodeTasks(env: Env, mc: MaterialiseContext): Promise<{ moved: number; opened: number }> {
  const { sprint } = mc;
  if (sprint.siteAccess === "unlinked") return { moved: 0, opened: 0 };
  let moved = 0;
  if (sprint.siteAccess === "repo" && sprint.siteProjectId) {
    const tasks = await db.listTasks(env.ctx.db, sprint.companyId, sprint.id, { status: ["not_started", "in_progress", "blocked"] });
    for (const task of tasks) {
      if (task.owner !== "agent" || !isCodeTask(task) || !task.issueId) continue;
      if (task.issueProjectId === sprint.siteProjectId) continue;
      const issue = await getIssue(env, sprint.companyId, task.issueId);
      if (!issue || !["todo", "backlog", "blocked"].includes(String(issue.status))) continue;
      const oldIssueId = task.issueId;
      await db.updateTask(env.ctx.db, sprint.companyId, task.id, { issue_id: null, issue_status: null, issue_identifier: null, issue_project_id: null, status: "not_started", blocker_reason: null });
      await commentOn(env, sprint.companyId, oldIssueId, "Moved to the site's repo project so the SEO Specialist works it in the repo workspace. A new issue replaces this one.");
      await patchIssue(env, sprint.companyId, oldIssueId, { status: "cancelled" });
      moved += 1;
    }
  }
  // Code tasks that waited for the link open now (in the site project, or the SEO project without a repo).
  const opened = await materialiseDueTasks(env, mc);
  return { moved, opened: opened.created };
}
