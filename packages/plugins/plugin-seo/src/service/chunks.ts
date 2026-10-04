/**
 * Page groups for site-wide tasks (Q8-6). A task such as "a title and description for every page" or "alt text on every
 * image" is split into child issues of N pages when its issue is opened, or when an agent starts it on a site that is
 * bigger than one run can do well, so no run has to touch hundreds of pages. Groups open one at a time: the next when
 * the one before it closes. The parent task is completed only after every group is finished; the agent is woken on it
 * when the last group closes, to check the site as a whole.
 *
 * Off unless a person switched page groups on for the sprint (service/switches.ts): then nothing is split and the sitemap is
 * never read. A sprint that was running before this version keeps working: a task that already has an issue and no groups
 * is left alone unless its agent starts it (start-task) or calls `split-task`, and only with the switch on. Groups that are
 * already open when the switch goes off are finished as planned.
 */
import { randomUUID } from "node:crypto";
import { wakeIssue } from "@partnersinbiz/pib-plugin-kit";
import { collectSitePages } from "../checks/pages.js";
import { chunkOriginId, ORIGIN } from "../constants.js";
import * as db from "../db.js";
import {
  chunkBlocker,
  chunkProgress,
  groupBlockedItem,
  groupBlockedKey,
  groupDoneComment,
  groupIssueDescription,
  groupIssueTitle,
  groupSizeFor,
  isSiteWideTask,
  MAX_SPLIT_PAGES,
  planGroups,
  splitSection,
  type GroupPlan,
} from "../engine/chunks.js";
import { branchFor, isCodeTask } from "../engine/site-change.js";
import { offMessage } from "../engine/switches.js";
import { decideAssignee, TERMINAL_TASK_STATUSES, type AgentAvailability } from "../engine/sprint.js";
import { addDays } from "../engine/time.js";
import { resolveAgent } from "./agent.js";
import { assignableUser, bool, cockpitPath, companyInfo, errorMessage, num, reqStr, SeoError, strList, urlParam, type Actor, type CompanyInfo, type Env, type Params } from "./common.js";
import { loadSprintContext, sprintCopy } from "./context.js";
import { commentOn, getIssue, openIssue, patchIssue } from "./issues.js";
import { addNeedsYou, resolveNeedsYou } from "./needs-you.js";
import { requireOn } from "./switches.js";
import { siteCopyFor, taskCopy, taskProjectId } from "./tasks.js";

export interface SplitPlan {
  groups: GroupPlan[];
  pages: number;
  size: number;
  source: "sitemap" | "known" | "given" | "none";
  partial: boolean;
  capped: boolean;
}

/** How long a "no split needed" decision holds before the sitemap is read again (days). */
const RECHECK_DAYS = 7;

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/** Pages the sprint already knows about: keyword and content targets and the pages table. */
async function knownPages(env: Env, sprint: db.Sprint): Promise<string[]> {
  const [keywords, content, pages] = await Promise.all([
    db.listKeywords(env.ctx.db, sprint.companyId, sprint.id),
    db.listContent(env.ctx.db, sprint.companyId, sprint.id),
    db.listPages(env.ctx.db, sprint.companyId, sprint.id),
  ]);
  const out: string[] = [];
  for (const raw of [...content.map((c) => c.targetUrl), ...keywords.map((k) => k.targetUrl), ...pages.map((p) => p.url)]) {
    if (!raw) continue;
    try {
      out.push(new URL(raw, sprint.siteUrl).toString());
    } catch {
      // not a URL
    }
  }
  return out;
}

/**
 * Plan the groups for a task: the site's pages (the sitemap, the known pages first) split into groups of its size.
 * `plan` is null when one run can do it all. Never throws (a site that does not answer is "not split").
 */
export async function planSplit(env: Env, sprint: db.Sprint, task: Pick<db.SprintTask, "taskType">, opts: { size?: number | null; urls?: string[] | null } = {}): Promise<{ plan: SplitPlan | null; pages: number; size: number; reason: string; reliable: boolean }> {
  const size = groupSizeFor(task.taskType, opts.size);
  try {
    let urls: string[];
    let source: SplitPlan["source"];
    let partial = false;
    let capped = false;
    if (opts.urls && opts.urls.length > 0) {
      const host = hostOf(sprint.siteUrl);
      urls = [...new Set(opts.urls)].filter((u) => hostOf(u) === host);
      source = "given";
      capped = urls.length > MAX_SPLIT_PAGES;
    } else {
      const found = await collectSitePages(env.site, sprint.siteUrl, { known: await knownPages(env, sprint), deadlineMs: 15_000 });
      urls = found.urls;
      source = found.source;
      partial = found.partial;
      capped = found.capped;
    }
    const groups = planGroups(urls, size);
    // A list that could not be read in full says nothing about how big the site is: "no split" is not remembered for it.
    const reliable = !partial;
    if (!groups) return { plan: null, pages: urls.length, size, reliable, reason: `The site has ${urls.length} page${urls.length === 1 ? "" : "s"}, no more than ${size} per group: one run does it, no split.${reliable ? "" : " (The page list could not be read in full: it is asked again next time.)"}` };
    const planned = groups.reduce((n, g) => n + g.urls.length, 0);
    return { plan: { groups, pages: planned, size, source, partial, capped: capped || urls.length > planned }, pages: urls.length, size, reliable, reason: `${planned} of ${urls.length} pages in groups of ${size} or fewer: ${groups.length} groups.` };
  } catch (error) {
    return { plan: null, pages: 0, size, reliable: false, reason: `The site's pages could not be listed (${errorMessage(error)}): not split.` };
  }
}

/** What a task keeps about whether it was split, so a start-task does not read the sitemap again and again. */
async function rememberDecision(env: Env, task: db.SprintTask, now: Date, decision: { pages: number; size: number; groups: number }): Promise<void> {
  await db.updateTask(env.ctx.db, task.companyId, task.id, { evidence: { ...(task.evidence ?? {}), split: { checkedOn: now.toISOString().slice(0, 10), ...decision } } }).catch(() => undefined);
}

function recentlyChecked(task: Pick<db.SprintTask, "evidence">, now: Date): boolean {
  const split = (task.evidence?.split ?? null) as { checkedOn?: unknown; groups?: unknown } | null;
  if (!split || typeof split.checkedOn !== "string") return false;
  return split.checkedOn >= addDays(now.toISOString().slice(0, 10), -RECHECK_DAYS);
}

/**
 * For a task issue about to be opened: the plan when this task is site-wide and the site is bigger than one group.
 * Best effort: any failure means "no split" and the issue opens as before. The caller opens the issue (without waking
 * the agent when there is a plan) and then calls `openGroups`.
 */
export async function planForNewIssue(env: Env, sprint: db.Sprint, task: db.SprintTask, assignedToAgent: boolean): Promise<SplitPlan | null> {
  // Off unless a person switched page groups on for this sprint: the issue opens whole and the sitemap is not read.
  if (!sprint.chunksEnabled || !assignedToAgent || !isSiteWideTask(task) || task.owner !== "agent") return null;
  try {
    const existing = await db.listChunks(env.ctx.db, task.companyId, task.id);
    if (existing.some((c) => c.status === "queued" || c.status === "open")) return null;
    const { plan, pages, size, reliable } = await planSplit(env, sprint, task);
    if (plan || reliable) await rememberDecision(env, task, env.now(), { pages, size, groups: plan?.groups.length ?? 0 });
    return plan;
  } catch (error) {
    env.ctx.logger.info("SEO page-group plan skipped", { taskId: task.id, error: errorMessage(error) });
    return null;
  }
}

/** The extra sections the parent issue's description gets when it is split. */
export function parentSplitSection(plan: SplitPlan): string[] {
  return splitSection({ groups: plan.groups.length, pages: plan.pages, size: plan.size, capped: plan.capped });
}

interface GroupContext {
  info: CompanyInfo;
  agent: AgentAvailability;
}

/** Create the group rows under a parent issue and open the first one. Returns the first group's issue id. */
export async function openGroups(env: Env, task: db.SprintTask, parentIssueId: string, plan: SplitPlan): Promise<string | null> {
  await db.insertChunks(
    env.ctx.db,
    plan.groups.map((g) => ({ id: randomUUID(), companyId: task.companyId, sprintId: task.sprintId, taskId: task.id, parentIssueId, seq: g.seq, total: g.total, label: g.label, urls: g.urls })),
  );
  return (await openNextGroup(env, task.companyId, task.id))?.issueId ?? null;
}

/** Open the first queued group of the task's current parent issue when none is open. Returns the new issue, or null. */
export async function openNextGroup(env: Env, companyId: string, taskId: string, ctx?: Partial<GroupContext>): Promise<{ issueId: string; identifier: string | null; seq: number } | null> {
  const task = await db.getTask(env.ctx.db, companyId, taskId);
  if (!task || !task.issueId || (TERMINAL_TASK_STATUSES as string[]).includes(task.status)) return null;
  const chunks = (await db.listChunks(env.ctx.db, companyId, taskId)).filter((c) => c.parentIssueId === task.issueId);
  if (chunks.some((c) => c.status === "open")) return null;
  const next = chunks.find((c) => c.status === "queued");
  if (!next) return null;
  if (!(await db.claimChunk(env.ctx.db, companyId, next.id))) return null;
  try {
    const { sprint, info } = await loadSprintContext(env, companyId, task.sprintId, ctx?.info);
    const agent = ctx?.agent !== undefined ? ctx.agent : await resolveAgent(env, companyId);
    const assignment = decideAssignee({ owner: "agent", autopilotEligible: task.autopilotEligible, mode: sprint.autopilotMode, agent, ownerUserId: assignableUser(sprint.ownerUserId) });
    const parent = await getIssue(env, companyId, task.issueId);
    const base = siteCopyFor(sprint, task);
    const site = base ? { ...base, branch: `${branchFor(task)}-g${next.seq}` } : null;
    const group: GroupPlan = { seq: next.seq, total: next.total, urls: next.urls, label: next.label };
    const description = groupIssueDescription({
      task: taskCopy(task),
      sprint: sprintCopy(sprint),
      group,
      taskId: task.id,
      chunkId: next.id,
      parentIdentifier: parent?.identifier ?? task.issueIdentifier ?? null,
      site,
      cockpitPath: cockpitPath(info, sprint),
    }).join("\n");
    const created = await openIssue(env, {
      companyId,
      title: groupIssueTitle(task, sprint, group),
      description,
      originKind: ORIGIN.chunk,
      originId: chunkOriginId(next.id),
      projectId: task.issueProjectId ?? taskProjectId(sprint, isCodeTask(task), sprint.projectId),
      parentId: task.issueId,
      assigneeAgentId: assignment.kind === "agent" ? assignment.agentId : null,
      wake: assignment.kind === "agent" ? assignment.wake : false,
      wakeReason: `SEO page group ${next.seq} of ${next.total}: ${task.title}`,
    });
    const issue = await getIssue(env, companyId, created.id);
    await db.updateChunk(env.ctx.db, companyId, next.id, { issue_id: created.id, issue_identifier: issue?.identifier ?? null });
    return { issueId: created.id, identifier: issue?.identifier ?? null, seq: next.seq };
  } catch (error) {
    await db.releaseChunk(env.ctx.db, companyId, next.id).catch(() => undefined);
    env.ctx.logger.info("SEO page group not opened", { taskId, seq: next.seq, error: errorMessage(error) });
    return null;
  }
}

/** A group's issue changed. true when the issue is a page group (the caller stops there). */
export async function onChunkIssueUpdated(env: Env, companyId: string, issueId: string): Promise<boolean> {
  const chunk = await db.getChunkByIssue(env.ctx.db, companyId, issueId);
  if (!chunk) return false;
  const issue = await getIssue(env, companyId, issueId);
  if (!issue) return true;
  await syncChunk(env, chunk, String(issue.status), issue.identifier ?? chunk.issueIdentifier);
  return true;
}

/** The agent blocked a group's issue: groups open one at a time, so the whole task waits. Put it on the sprint's Needs you list. */
async function raiseBlockedGroup(env: Env, chunk: db.TaskChunk, identifier: string | null): Promise<void> {
  try {
    const task = await db.getTask(env.ctx.db, chunk.companyId, chunk.taskId);
    if (!task || (TERMINAL_TASK_STATUSES as string[]).includes(task.status)) return;
    const sprint = await db.getSprint(env.ctx.db, chunk.companyId, chunk.sprintId);
    if (!sprint) return;
    const info = await companyInfo(env, chunk.companyId);
    await addNeedsYou(env, info, sprint, groupBlockedItem({ chunkId: chunk.id, seq: chunk.seq, total: chunk.total, taskTitle: task.title, issueIdentifier: identifier ?? chunk.issueIdentifier }), { reopen: true });
  } catch (error) {
    env.ctx.logger.info("SEO blocked page group not put on Needs you", { chunkId: chunk.id, error: errorMessage(error) });
  }
}

/** The group is no longer blocked (unblocked, done or cancelled): close its Needs you line. A cheap read first: most updates have none. */
async function clearBlockedGroup(env: Env, chunk: db.TaskChunk, by: string): Promise<void> {
  try {
    const key = groupBlockedKey(chunk.id);
    const waiting = (await db.openNeedsYouDigests(env.ctx.db, chunk.companyId)).some((d) => d.sprintId === chunk.sprintId && d.items.some((i) => i.key === key && i.status === "open"));
    if (!waiting) return;
    const sprint = await db.getSprint(env.ctx.db, chunk.companyId, chunk.sprintId);
    if (!sprint) return;
    await resolveNeedsYou(env, await companyInfo(env, chunk.companyId), sprint, key, by);
  } catch (error) {
    env.ctx.logger.info("SEO blocked page group's Needs you line not closed", { chunkId: chunk.id, error: errorMessage(error) });
  }
}

async function syncChunk(env: Env, chunk: db.TaskChunk, issueStatus: string, identifier: string | null): Promise<void> {
  const finished = issueStatus === "done" ? "done" : issueStatus === "cancelled" ? "cancelled" : null;
  if (!finished) {
    // Reopened after it was closed: it is open work again.
    if (chunk.status === "done" || chunk.status === "cancelled") await db.updateChunk(env.ctx.db, chunk.companyId, chunk.id, { status: "open", done_at: null });
    if (issueStatus === "blocked") await raiseBlockedGroup(env, chunk, identifier);
    else await clearBlockedGroup(env, chunk, "the group's issue was unblocked");
    return;
  }
  await clearBlockedGroup(env, chunk, "the group's issue was closed");
  if (chunk.status === finished) return;
  await db.updateChunk(env.ctx.db, chunk.companyId, chunk.id, { status: finished, done_at: new Date().toISOString(), ...(identifier ? { issue_identifier: identifier } : {}) });
  const task = await db.getTask(env.ctx.db, chunk.companyId, chunk.taskId);
  if (!task || !task.issueId || (TERMINAL_TASK_STATUSES as string[]).includes(task.status)) return;
  const opened = await openNextGroup(env, chunk.companyId, task.id);
  await commentOn(env, chunk.companyId, task.issueId, groupDoneComment({ seq: chunk.seq, total: chunk.total, issueIdentifier: identifier ?? chunk.issueIdentifier, pages: chunk.urls.length, next: opened ? { seq: opened.seq, issueIdentifier: opened.identifier } : null }));
  if (!opened) {
    const all = (await db.listChunks(env.ctx.db, chunk.companyId, task.id)).filter((c) => c.parentIssueId === task.issueId);
    if (!chunkBlocker(all)) await wakeIssue(env.ctx, task.issueId, chunk.companyId, "Every SEO page group is done: check the site and complete the task").catch(() => undefined);
  }
}

/** What a parent task still waits for, or null (no groups, or every one finished). Used by complete-task and the done-check. */
export async function groupBlockerFor(sdb: db.SeoDb, companyId: string, task: Pick<db.SprintTask, "id" | "issueId">): Promise<string | null> {
  if (!task.issueId) return null;
  const chunks = (await db.listChunks(sdb, companyId, task.id)).filter((c) => c.parentIssueId === task.issueId);
  return chunks.length === 0 ? null : chunkBlocker(chunks);
}

/** Cancel a task's unfinished groups (its task was skipped or closed another way). */
export async function cancelGroups(env: Env, companyId: string, taskId: string, note: string): Promise<number> {
  const chunks = (await db.listChunks(env.ctx.db, companyId, taskId)).filter((c) => c.status === "queued" || c.status === "open");
  for (const chunk of chunks) {
    await db.updateChunk(env.ctx.db, companyId, chunk.id, { status: "cancelled", done_at: new Date().toISOString() });
    if (chunk.issueId) {
      await commentOn(env, companyId, chunk.issueId, note);
      await patchIssue(env, companyId, chunk.issueId, { status: "cancelled" });
    }
  }
  return chunks.length;
}

/**
 * The daily heal, and a safety net for missed events: re-read open groups' issues, open the next group of a task that has
 * none open, free a group whose issue was never created, and cancel the groups of a task that is already finished.
 */
export async function healChunks(env: Env, companyId: string): Promise<{ synced: number; opened: number; released: number; cancelled: number }> {
  const out = { synced: 0, opened: 0, released: 0, cancelled: 0 };
  for (const chunk of await db.openChunks(env.ctx.db, companyId)) {
    const task = await db.getTask(env.ctx.db, companyId, chunk.taskId);
    if (task && (TERMINAL_TASK_STATUSES as string[]).includes(task.status)) {
      out.cancelled += await cancelGroups(env, companyId, task.id, "The task this group belonged to is finished: group closed.");
      continue;
    }
    if (!chunk.issueId) {
      if (chunk.openedAt && Date.now() - Date.parse(chunk.openedAt) > 10 * 60_000) {
        await db.releaseChunk(env.ctx.db, companyId, chunk.id);
        out.released += 1;
      }
      continue;
    }
    const issue = await getIssue(env, companyId, chunk.issueId);
    if (!issue) continue;
    const before = chunk.status;
    await syncChunk(env, chunk, String(issue.status), issue.identifier ?? null);
    if (String(issue.status) === "done" || String(issue.status) === "cancelled" || before !== chunk.status) out.synced += 1;
  }
  out.opened = await openIdleGroups(env, companyId);
  return out;
}

/** Open the next group of every task that has one queued and none open (a close that was missed, or a group the host refused to create). */
export async function openIdleGroups(env: Env, companyId: string): Promise<number> {
  let opened = 0;
  for (const taskId of await db.tasksWithIdleChunks(env.ctx.db, companyId)) {
    if (await openNextGroup(env, companyId, taskId)) opened += 1;
  }
  return opened;
}

export interface GroupView {
  taskId: string;
  total: number;
  done: number;
  open: number;
  queued: number;
  cancelled: number;
  openIssue: { issueId: string | null; identifier: string | null; seq: number } | null;
}

/** Per task: how far its page groups are (only tasks with unfinished groups), for `today` and the page. */
export async function groupViews(env: Env, companyId: string, sprintId: string): Promise<Map<string, GroupView>> {
  const unfinished = await db.unfinishedChunks(env.ctx.db, companyId, sprintId);
  const out = new Map<string, GroupView>();
  for (const taskId of new Set(unfinished.map((c) => c.taskId))) {
    const task = await db.getTask(env.ctx.db, companyId, taskId);
    const all = (await db.listChunks(env.ctx.db, companyId, taskId)).filter((c) => !task?.issueId || c.parentIssueId === task.issueId);
    const open = all.find((c) => c.status === "open");
    out.set(taskId, { taskId, ...chunkProgress(all), openIssue: open ? { issueId: open.issueId, identifier: open.issueIdentifier, seq: open.seq } : null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// split-task
// ---------------------------------------------------------------------------

/**
 * Split an open site-wide task into page groups now: the agent's call from the task's issue (it is told to end its run), or a
 * person's. Existing sprints keep working: nothing is split unless this runs or the task is started on a big site.
 */
export async function splitTaskTool(env: Env, companyId: string, actor: Actor, params: Params) {
  const task = await db.getTask(env.ctx.db, companyId, reqStr(params, "taskId"));
  if (!task) throw new SeoError("Task not found");
  if ((TERMINAL_TASK_STATUSES as string[]).includes(task.status)) throw new SeoError(`This task is already ${task.status}.`);
  if (!task.issueId) throw new SeoError("This task has no issue yet. It is split automatically when its issue opens.");
  const dryRun = bool(params, "dryRun") ?? false;
  const existing = (await db.listChunks(env.ctx.db, companyId, task.id)).filter((c) => c.parentIssueId === task.issueId && c.status !== "cancelled");
  if (existing.length > 0) {
    return { taskId: task.id, split: true, alreadySplit: true, progress: chunkProgress(existing), next: chunkBlocker(existing) ?? "Every group is finished: check the site as a whole and complete the task." };
  }
  const { sprint } = await loadSprintContext(env, companyId, task.sprintId);
  requireOn(sprint, "chunks", offMessage("chunks"));
  const urls = strList(params, "urls", { max: MAX_SPLIT_PAGES, itemMax: 1000 }).map((u) => urlParam(u, sprint.siteUrl));
  const size = num(params, "size", { integer: true, min: 5, max: 50 });
  const { plan, pages, reason, reliable } = await planSplit(env, sprint, task, { size, urls });
  if (!plan) {
    if (reliable && !dryRun) await rememberDecision(env, task, env.now(), { pages, size: groupSizeFor(task.taskType, size), groups: 0 });
    return { taskId: task.id, split: false, pages, reason, next: reliable ? "Work the whole task in this run." : "The site's page list could not be read in full, so nothing was decided: work the task in this run, or call split-task again later (or pass urls)." };
  }
  const view = { groups: plan.groups.length, pages: plan.pages, perGroup: plan.size, source: plan.source, partial: plan.partial, capped: plan.capped, sample: plan.groups.slice(0, 3).map((g) => ({ seq: g.seq, label: g.label, firstUrl: g.urls[0] })) };
  if (dryRun) return { taskId: task.id, split: false, dryRun: true, plan: view, next: "Call split-task again without dryRun to open the groups." };
  await rememberDecision(env, task, env.now(), { pages, size: plan.size, groups: plan.groups.length });
  await commentOn(env, companyId, task.issueId, `Split into ${plan.groups.length} page groups by ${actor.kind === "agent" ? "the SEO Specialist" : "a person"}: ${plan.pages} pages, ${plan.size} or fewer each, opened one at a time. Work the group issues; this issue is completed after the last one.`);
  const first = await openGroups(env, task, task.issueId, plan);
  return {
    taskId: task.id,
    split: true,
    plan: view,
    firstGroupIssueId: first,
    next: "End your run on this issue now: the pages are the group issues' work, one at a time. You are woken here when the last group is done, then check the site as a whole and complete-task.",
  };
}

/**
 * start-task on a site-wide task that has no groups yet: split it when the site is bigger than one group (the task's own
 * record remembers a "no split needed" answer for a week). Never throws; null when nothing changed.
 */
export async function splitOnStart(env: Env, task: db.SprintTask): Promise<{ groups: number; pages: number; firstGroupIssueId: string | null } | null> {
  if (!isSiteWideTask(task) || task.owner !== "agent" || !task.issueId || (TERMINAL_TASK_STATUSES as string[]).includes(task.status)) return null;
  try {
    // Off unless a person switched page groups on for this sprint: a task that is started is worked whole, and the sitemap is not read.
    const sprint = await db.getSprint(env.ctx.db, task.companyId, task.sprintId);
    if (!sprint?.chunksEnabled) return null;
    if (recentlyChecked(task, env.now())) return null;
    const existing = (await db.listChunks(env.ctx.db, task.companyId, task.id)).filter((c) => c.parentIssueId === task.issueId);
    if (existing.length > 0) return null;
    const { plan, pages, size, reliable } = await planSplit(env, sprint, task);
    if (plan || reliable) await rememberDecision(env, task, env.now(), { pages, size, groups: plan?.groups.length ?? 0 });
    if (!plan) return null;
    await commentOn(env, task.companyId, task.issueId, `Split into ${plan.groups.length} page groups: ${plan.pages} pages, ${plan.size} or fewer each, opened one at a time. Work the group issues; this issue is completed after the last one.`);
    const first = await openGroups(env, task, task.issueId, plan);
    return { groups: plan.groups.length, pages: plan.pages, firstGroupIssueId: first };
  } catch (error) {
    env.ctx.logger.info("SEO split on start skipped", { taskId: task.id, error: errorMessage(error) });
    return null;
  }
}

