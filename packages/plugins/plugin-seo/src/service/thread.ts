/**
 * Keeps task issue threads small enough to hand an agent (engine/thread.ts explains why).
 *
 * A task whose thread has passed `THREAD_ROLL_BYTES` (or whose agent runs fail with `spawn E2BIG`) is moved to a
 * fresh continuation issue, the way a closed sprint root is replaced (service/sprints.ts ensureRootIssue):
 * - the continuation issue carries the task's own description plus a summary built from the plugin's records
 *   (task state, previews and their review notes, the last few comments), in the same project, under the same
 *   parent, assigned to the same agent, sharing the old issue's checkout/worktree;
 * - the task row and its previews point at the new issue first, then the old issue gets a pointer comment and is
 *   cancelled (the order keeps the issue event from marking the task skipped);
 * - the agent is woken on the new issue.
 * It is idempotent: once the task points at the new issue the old thread is nobody's, and a task moved in the last
 * two hours is left alone unless a person names its issue.
 *
 * Three guards keep a move from repeating or doubling:
 * - a claim: the task's move record (`seo-thread-roll:<taskId>`) is written before anything is opened, so a move that
 *   fails is not retried for an hour (then two, four... up to a day) instead of opening and cancelling an issue every
 *   five minutes, and an interrupted move holds the task for an hour;
 * - a lock in this process, so the 5-minute and the hourly job (one worker, both starting at :05) cannot both move
 *   the same task;
 * - an issue an agent is working on right now (a queued or running run) waits for the next check.
 *
 * The hourly job and the 5-minute job run `guardTaskThreads`; `compact-task-thread` is the same code for a person
 * or the orchestrator, dry run by default.
 */
import { wakeIssue } from "@partnersinbiz/pib-plugin-kit";
import { ORIGIN, taskOriginId } from "../constants.js";
import * as db from "../db.js";
import { taskIssueDescription } from "../engine/copy.js";
import { decideAssignee } from "../engine/sprint.js";
import { continuationStatus, continuationSummary, moveHold, parseRollMark, rollableIssue, rollReason, THREAD_ROLL_BYTES, type RollMark, type RollReason } from "../engine/thread.js";
import { resolveAgent } from "./agent.js";
import { assignableUser, bool, cockpitPath, companyInfo, errorMessage, num, str, type Env, type Params } from "./common.js";
import { sprintCopy } from "./context.js";
import { commentOn, getIssue, openIssue, patchIssue } from "./issues.js";
import { seoCompanies, seoOn } from "./setup-status.js";
import { siteCopyFor, taskCopy } from "./tasks.js";

const AUTO_LIMIT = 5;

export interface RollOutcome {
  taskId: string;
  sprintId: string;
  issueId: string;
  identifier: string | null;
  title: string;
  /** Comment bytes in the thread (null when the host's comments could not be read). */
  bytes: number | null;
  comments: number | null;
  reason: RollReason | null;
  action: "would_roll" | "rolled" | "skipped" | "failed";
  detail?: string;
  newIssueId?: string;
  newIdentifier?: string | null;
}

export interface CompactResult {
  dryRun: boolean;
  thresholdBytes: number;
  /** False when the host's issue comments could not be read: only issues whose runs failed with E2BIG (or the one named) are found. */
  sizesAvailable: boolean;
  checked: number;
  rolled: number;
  items: RollOutcome[];
}

function rollKey(companyId: string, taskId: string) {
  return { scopeKind: "company" as const, scopeId: companyId, namespace: "seo-thread-roll", stateKey: taskId };
}

/** The task's move record. Throws when the host's state cannot be read. */
async function readMark(env: Env, companyId: string, taskId: string): Promise<RollMark | null> {
  return parseRollMark(await env.ctx.state.get(rollKey(companyId, taskId)));
}

async function writeMark(env: Env, companyId: string, taskId: string, state: RollMark["state"], failures: number): Promise<void> {
  const mark: RollMark = { at: env.now().toISOString(), state, failures };
  await env.ctx.state.set(rollKey(companyId, taskId), mark);
}

/** Tasks being moved by this process right now (the job and the 5-minute guard share one worker). */
const inFlight = new Set<string>();

const unreadable = new Set<string>();

/** The queries take at most a few hundred ids at a time. */
function chunks<T>(list: T[], size = 200): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function sizesOf(env: Env, companyId: string, issueIds: string[]): Promise<Map<string, db.ThreadSize> | null> {
  try {
    const sizes = new Map<string, db.ThreadSize>();
    for (const part of chunks(issueIds)) for (const [id, size] of await db.threadSizes(env.ctx.db, companyId, part)) sizes.set(id, size);
    return sizes;
  } catch (error) {
    // Once per process and company: this runs every 5 minutes.
    if (!unreadable.has(companyId)) {
      unreadable.add(companyId);
      env.ctx.logger.info("SEO thread sizes unavailable (issue_comments not readable yet): only E2BIG failures and named issues are found", { companyId, error: errorMessage(error) });
    }
    return null;
  }
}

/** Each issue's latest run: the E2BIG failures to move, and the runs still working, which are not interrupted. */
async function runsOf(env: Env, companyId: string, issueIds: string[]): Promise<Map<string, db.LatestRun>> {
  const found = new Map<string, db.LatestRun>();
  try {
    for (const part of chunks(issueIds)) for (const [id, run] of await db.latestRuns(env.ctx.db, companyId, part)) found.set(id, run);
  } catch (error) {
    env.ctx.logger.info("SEO run lookup failed", { companyId, error: errorMessage(error) });
  }
  return found;
}

/** Why an issue's agent cannot be woken on it at all (so no wake can fail on it), or null. A read that fails says nothing. */
async function agentGone(env: Env, companyId: string, agentId: string): Promise<string | null> {
  try {
    const agent = await env.ctx.agents.get(agentId, companyId);
    if (!agent) return "its agent no longer exists, so no wake can fail on it";
    if (String(agent.status) === "terminated") return "its agent is terminated, so no wake can fail on it";
  } catch {
    // Unreadable: carry on. A host that rejects the assignee is caught by the claim's backoff.
  }
  return null;
}

/** Move one task to a continuation issue. The caller has already decided it should move. */
async function rollTask(env: Env, companyId: string, listed: db.SprintTask, old: NonNullable<Awaited<ReturnType<typeof getIssue>>>, facts: { bytes: number | null; comments: number | null; reason: RollReason }): Promise<Pick<RollOutcome, "action" | "detail" | "newIssueId" | "newIdentifier">> {
  // The job and the 5-minute guard can overlap: work from the task as it is now.
  const task = await db.getTask(env.ctx.db, companyId, listed.id);
  if (!task || task.issueId !== old.id) return { action: "skipped", detail: "the task already moved to another issue" };
  const sprint = await db.getSprint(env.ctx.db, companyId, task.sprintId);
  if (!sprint) return { action: "failed", detail: "the sprint is gone" };
  const info = await companyInfo(env, companyId);
  const agent = await resolveAgent(env, companyId);
  const [previews, last] = await Promise.all([
    db.previewsForTask(env.ctx.db, companyId, task.id).catch(() => [] as db.TaskPreviewRow[]),
    db.lastComments(env.ctx.db, companyId, old.id, 3).catch(() => []),
  ]);
  const assignment = decideAssignee({ owner: task.owner, autopilotEligible: task.autopilotEligible, mode: sprint.autopilotMode, agent, ownerUserId: assignableUser(sprint.ownerUserId) });
  const taskDescription = taskIssueDescription(taskCopy(task), sprintCopy(sprint), { assignment, context: task.context, cockpitPath: cockpitPath(info, sprint), site: siteCopyFor(sprint, task) });
  const evidence = (task.evidence ?? {}) as { summary?: unknown };
  const summary = continuationSummary({
    oldIdentifier: old.identifier ?? task.issueIdentifier,
    bytes: facts.bytes,
    comments: facts.comments,
    reason: facts.reason === "e2big" ? "the agent's runs were failing with spawn E2BIG" : facts.reason === "requested" ? "moved on request" : "it passed the size the plugin allows",
    task: { title: task.title, status: task.status, blockerReason: task.blockerReason, humanAsk: task.humanAsk, startedAt: task.startedAt, evidenceSummary: typeof evidence.summary === "string" ? evidence.summary : null },
    previews: previews.map((p) => ({ pageUrl: p.pageUrl, title: p.title, status: p.status, reviewStatus: p.reviewStatus, reviewNote: p.reviewNote, previewId: p.id })),
    lastComments: last,
    sprintId: sprint.id,
  });

  const status = continuationStatus(String(old.status));
  const created = await openIssue(env, {
    companyId,
    title: old.title,
    description: `${summary}\n\n---\n\n${taskDescription}`.slice(0, 30_000),
    originKind: ORIGIN.task,
    originId: taskOriginId(task.id),
    projectId: old.projectId ?? task.issueProjectId ?? sprint.projectId,
    parentId: old.parentId ?? sprint.rootIssueId,
    assigneeAgentId: old.assigneeAgentId,
    priority: old.priority,
    wake: false,
    inheritWorkspaceFromIssueId: old.id,
  });
  if (created.assigned !== "agent") {
    // The host would not assign it: do not leave a second, unowned issue behind.
    await patchIssue(env, companyId, created.id, { status: "cancelled" });
    return { action: "failed", detail: "the continuation issue could not be assigned to the agent, so nothing was moved" };
  }
  const fresh = await getIssue(env, companyId, created.id);
  const newIdentifier = fresh?.identifier ?? null;
  if (status === "blocked") await patchIssue(env, companyId, created.id, { status: "blocked" });

  // The task and its previews follow the new issue before the old one closes, so that close is not read as the task being skipped.
  try {
    await db.updateTask(env.ctx.db, companyId, task.id, { issue_id: created.id, issue_identifier: newIdentifier, issue_status: status });
  } catch (error) {
    // The task still points at the old issue: do not leave a second live issue for the same task behind.
    await patchIssue(env, companyId, created.id, { status: "cancelled" });
    throw error;
  }
  await db.repointPreviews(env.ctx.db, companyId, old.id, created.id);

  const size = facts.bytes != null ? `${Math.round(facts.bytes / 1000)} KB` : "very long";
  await commentOn(env, companyId, old.id, `Moved to ${newIdentifier ?? created.id}: this thread was ${size}, too long to hand an agent. The work continues there; this issue is closed.`);
  let detail: string | undefined;
  if (!(await patchIssue(env, companyId, old.id, { status: "cancelled" }))) {
    // Still assigned, the host would keep waking it and failing: take the agent off.
    await patchIssue(env, companyId, old.id, { assigneeAgentId: null });
    detail = "the old issue could not be closed, so its agent was taken off it";
  }
  if (status === "todo") await wakeIssue(env.ctx, created.id, companyId, `Continuation of ${old.identifier ?? "a long task thread"}: carry on`);
  env.ctx.logger.info("SEO task thread moved to a continuation issue", { taskId: task.id, from: old.identifier, to: newIdentifier, bytes: facts.bytes, reason: facts.reason });
  return { action: "rolled", newIssueId: created.id, newIdentifier, ...(detail ? { detail } : {}) };
}

/**
 * Claim the task, move it, record how it ended. The claim is in this process (so two jobs cannot both move it) and in
 * the task's move record, written before anything is opened (so a move that fails, or dies, is not repeated at once).
 * An unreadable or unwritable record stops the automatic guard: without it a failing move could repeat every run.
 */
async function claimAndRoll(env: Env, companyId: string, listed: db.SprintTask, old: NonNullable<Awaited<ReturnType<typeof getIssue>>>, facts: { bytes: number | null; comments: number | null; reason: RollReason }, named: boolean): Promise<Pick<RollOutcome, "action" | "detail" | "newIssueId" | "newIdentifier">> {
  const flight = `${companyId}:${listed.id}`;
  if (inFlight.has(flight)) return { action: "skipped", detail: "another run is moving this task right now" };
  inFlight.add(flight);
  try {
    let mark: RollMark | null = null;
    try {
      mark = await readMark(env, companyId, listed.id);
    } catch (error) {
      if (!named) return { action: "skipped", detail: `the move record could not be read, so nothing was moved (${errorMessage(error)})` };
    }
    const hold = moveHold(mark, env.now().getTime(), named);
    if (hold) return { action: "skipped", detail: hold };
    const failures = mark?.failures ?? 0;
    try {
      await writeMark(env, companyId, listed.id, "claimed", failures);
    } catch (error) {
      if (!named) return { action: "skipped", detail: `the move could not be recorded, so nothing was moved (${errorMessage(error)})` };
    }
    let outcome: Awaited<ReturnType<typeof rollTask>>;
    try {
      outcome = await rollTask(env, companyId, listed, old, facts);
    } catch (error) {
      await writeMark(env, companyId, listed.id, "failed", failures + 1).catch(() => undefined);
      throw error;
    }
    // A move that found the task already on another issue counts as done: that is a move somebody else made.
    const failed = outcome.action === "failed";
    await writeMark(env, companyId, listed.id, failed ? "failed" : "moved", failed ? failures + 1 : 0).catch(() => undefined);
    if (failed) env.ctx.logger.warn("SEO task thread move failed; retrying later", { taskId: listed.id, issue: old.identifier, failures: failures + 1, detail: outcome.detail });
    return outcome;
  } finally {
    inFlight.delete(flight);
  }
}

export interface CompactOptions {
  /** Only report (default true for the tool; the hourly guard passes false). */
  dryRun: boolean;
  /** One issue, by id or identifier (PAR-528): named issues skip the cooldown and may move on E2BIG or size. */
  issue?: string;
  taskId?: string;
  minBytes?: number;
  /** At most this many moves in one run. */
  limit?: number;
}

/** Find the open task issues whose thread is too long (or whose runs fail with E2BIG) and move them (or say which would move). */
export async function compactTaskThreads(env: Env, companyId: string, opts: CompactOptions): Promise<CompactResult> {
  const minBytes = Math.max(10_000, opts.minBytes ?? THREAD_ROLL_BYTES);
  const named = opts.issue?.trim() || opts.taskId?.trim() || null;
  let tasks = (await db.listTasksWithOpenIssues(env.ctx.db, companyId)).filter((t) => t.issueId);
  if (opts.taskId) tasks = tasks.filter((t) => t.id === opts.taskId);
  if (opts.issue) tasks = tasks.filter((t) => t.issueId === opts.issue || t.issueIdentifier?.toLowerCase() === opts.issue!.toLowerCase());
  const ids = tasks.map((t) => t.issueId!);
  const sizes = await sizesOf(env, companyId, ids);
  const runs = await runsOf(env, companyId, ids);
  const result: CompactResult = { dryRun: opts.dryRun, thresholdBytes: minBytes, sizesAvailable: sizes !== null, checked: tasks.length, rolled: 0, items: [] };
  const limit = Math.max(1, opts.limit ?? 20);

  for (const task of tasks) {
    const issueId = task.issueId!;
    const size = sizes?.get(issueId) ?? null;
    // With readable comments an issue that has none has a size of zero, not an unknown one.
    const bytes = sizes ? size?.bytes ?? 0 : null;
    const run = runs.get(issueId);
    const reason = rollReason({ bytes, e2big: Boolean(run?.error?.includes("E2BIG")), explicit: Boolean(named) }, minBytes);
    const base = { taskId: task.id, sprintId: task.sprintId, issueId, identifier: task.issueIdentifier, title: task.title, bytes, comments: size?.comments ?? (sizes ? 0 : null), reason };
    if (!reason) {
      // A named issue gets an answer even when it is fine.
      if (named) result.items.push({ ...base, action: "skipped", detail: `the thread is ${bytes ?? "an unknown number of"} bytes, under the ${minBytes} that moves a task (pass minBytes to lower it)` });
      continue;
    }
    if (result.items.filter((i) => i.action === "rolled").length >= limit) {
      result.items.push({ ...base, action: "skipped", detail: "over this run's limit; the next run takes it" });
      continue;
    }
    const issue = await getIssue(env, companyId, issueId);
    if (!issue) {
      result.items.push({ ...base, action: "skipped", detail: "the issue could not be read" });
      continue;
    }
    const rollable = rollableIssue({ status: String(issue.status), assigneeAgentId: issue.assigneeAgentId });
    if (!rollable.ok) {
      result.items.push({ ...base, action: "skipped", detail: rollable.reason });
      continue;
    }
    const gone = await agentGone(env, companyId, issue.assigneeAgentId!);
    if (gone) {
      result.items.push({ ...base, action: "skipped", detail: gone });
      continue;
    }
    // Answered before the dry run, so a dry run says what a live run would do.
    let mark: RollMark | null = null;
    try {
      mark = await readMark(env, companyId, task.id);
    } catch {
      // claimAndRoll reads it again and stops an automatic run that cannot.
    }
    const hold = moveHold(mark, env.now().getTime(), Boolean(named));
    if (hold) {
      result.items.push({ ...base, action: "skipped", detail: hold });
      continue;
    }
    // An agent working on the issue right now is not interrupted: a move would start a second run on the same checkout. The next check takes it.
    if (!named && run?.active) {
      result.items.push({ ...base, action: "skipped", detail: "an agent run is working on it; it moves after the run ends (the next check retries)" });
      continue;
    }
    if (opts.dryRun) {
      result.items.push({ ...base, action: "would_roll" });
      continue;
    }
    try {
      const outcome = await claimAndRoll(env, companyId, task, issue, { bytes, comments: base.comments, reason }, Boolean(named));
      if (outcome.action === "rolled") result.rolled += 1;
      result.items.push({ ...base, ...outcome });
    } catch (error) {
      env.ctx.logger.info("SEO task thread move failed", { taskId: task.id, error: errorMessage(error) });
      result.items.push({ ...base, action: "failed", detail: errorMessage(error) });
    }
  }
  return result;
}

/** The tool: dry run unless `dryRun` is false. */
export async function compactTaskThreadTool(env: Env, companyId: string, params: Params) {
  const dryRun = bool(params, "dryRun") ?? true;
  const issue = str(params, "issueId", { max: 100 });
  const taskId = str(params, "taskId", { max: 100 });
  const minBytes = num(params, "minBytes", { integer: true, min: 10_000, max: 120_000 });
  const result = await compactTaskThreads(env, companyId, { dryRun, issue, taskId, minBytes });
  const named = issue ?? taskId;
  return {
    ...result,
    next:
      named && result.checked === 0
        ? "No open sprint task has that issue or task id: it may already have been moved to a continuation issue (check the task with list-tasks), or it is not a sprint task issue."
        : dryRun
          ? result.items.some((i) => i.action === "would_roll")
            ? "Nothing was moved. Run it again with dryRun false to move the issues marked would_roll."
            : "Nothing needs moving."
          : result.rolled > 0
            ? "Each moved task now lives on its new issue; the agent was woken there."
            : "Nothing was moved.",
  };
}

/**
 * The scheduled guard: every SEO company, no more than a few moves per run. Never throws. Returns what it did so
 * the job can log it.
 */
export async function guardTaskThreads(env: Env, companies?: string[]): Promise<{ checked: number; rolled: number }> {
  let checked = 0;
  let rolled = 0;
  for (const companyId of companies ?? (await seoCompanies(env))) {
    try {
      if (!(await seoOn(env, companyId))) continue;
      const result = await compactTaskThreads(env, companyId, { dryRun: false, limit: AUTO_LIMIT });
      checked += result.checked;
      rolled += result.rolled;
    } catch (error) {
      env.ctx.logger.info("SEO thread guard failed", { companyId, error: errorMessage(error) });
    }
  }
  return { checked, rolled };
}
