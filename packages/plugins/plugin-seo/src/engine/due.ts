/**
 * When a sprint task is due, overdue, stuck or waiting on a person: one
 * definition for the SEO page, the agent tools, the CRM client card and the
 * Cockpit, so their numbers agree. Pure and browser-safe.
 *
 * - **Due**: the plan has reached the task's day (a task without a day is due
 *   at once) and it is not done or skipped. It stays due until it is.
 * - **Overdue**: due, and still open a week (7 days) or more after its day.
 * - **Waiting on you**: blocked on a person (it is on the sprint's Needs you
 *   list), in sign-off, or a person's own task. Not counted as due work.
 * - **Stuck**: due agent work nobody can move: the SEO agent cannot work
 *   (paused, in error, waiting for approval, or no agent linked), or the
 *   task's runs stop before they start because its project's workspace has
 *   no checkout on the server (`workspace_validation_failed`).
 */
import { teamRoleHealth } from "@partnersinbiz/pib-plugin-kit/team";
import { addDays } from "./time.js";

/** A task is overdue this many days after its day. */
export const OVERDUE_AFTER_DAYS = 7;

/** The host's error code when a run stops at the workspace check (no checkout of the project's repo on the server). */
export const WORKSPACE_FAILURE_CODE = "workspace_validation_failed";

/** Why runs stop at the workspace check, in plain words (the page, the Cockpit and `today` use it). */
export const RUNS_TROUBLE = "the site repo has no checkout on the server (the workspace check fails)";

/** The fix for RUNS_TROUBLE, in plain words. */
export const RUNS_FIX =
  "Open the project in Paperclip → Configuration → Codebase and set its local folder to a checkout of the site repo on the server (or give the server access to the private repo), then retry the blocked task issues.";

/** Where RUNS_TROUBLE is fixed: the first failing project's Configuration tab (Codebase), else the SEO page. */
export function projectFixPath(projectIds: string[] | null | undefined): string {
  return projectIds?.[0] ? `/projects/${projectIds[0]}/configuration` : "/seo";
}

/** The words, once: the page's hints, the skill and the tool descriptions use these. */
export const DUE_TERMS = {
  due: "Due: the plan has reached the task's day and it is not done yet.",
  overdue: `Overdue: still open ${OVERDUE_AFTER_DAYS} or more days after its day.`,
  waiting: "Waiting on you: it needs a person (a Needs you item or a sign-off).",
  stuck:
    "Stuck: nobody can move it. Either the SEO agent cannot work (paused, in error or not linked; fix it in Setup → Team), or the task's runs stop before they start because its project has no checkout of the site repo on the server.",
} as const;

export interface TimedTask {
  status: string;
  /** Sprint day the task comes due; null = due at once. */
  dueDay: number | null;
  owner?: string | null;
  issueId?: string | null;
  issueStatus?: string | null;
  /** agent, unassigned, user, reviewer, needs_you or none (see service/tasks.ts). */
  assigneeKind?: string | null;
  /** The latest run on its issue stopped at the workspace check (see WORKSPACE_FAILURE_CODE). */
  runsFailing?: boolean | null;
}

const OPEN_STATUSES = new Set(["not_started", "in_progress", "blocked"]);
/** A person holds the task: the Needs you list, the owner, the Reviewer, or an owner task nobody got. */
const PERSON_ASSIGNEES = new Set(["needs_you", "user", "reviewer", "none"]);

export function isOpenTask(task: Pick<TimedTask, "status">): boolean {
  return OPEN_STATUSES.has(task.status);
}

/**
 * Blocked on a person, in sign-off, or a person's own task. A task whose runs
 * stop at the workspace check is not waiting on anyone's answer: it is stuck
 * (the host marks such an issue blocked, which would otherwise read as
 * "waiting on you").
 */
export function isWaitingTask(task: TimedTask): boolean {
  if (!isOpenTask(task) || task.runsFailing) return false;
  if (task.status === "blocked" || task.issueStatus === "in_review") return true;
  return Boolean(task.assigneeKind && PERSON_ASSIGNEES.has(task.assigneeKind));
}

/** The plan has reached the task's day (no day = due at once), or work on it has started. */
export function isDueTask(task: TimedTask, day: number): boolean {
  if (!isOpenTask(task)) return false;
  return task.status === "in_progress" || task.dueDay == null || task.dueDay <= day;
}

/** Days since the task's day (0 when it is not due yet). A task without a day counts from day 0. */
export function daysLate(task: TimedTask, day: number): number {
  return isDueTask(task, day) ? Math.max(0, day - (task.dueDay ?? 0)) : 0;
}

export function isOverdueTask(task: TimedTask, day: number): boolean {
  return isDueTask(task, day) && !isWaitingTask(task) && daysLate(task, day) >= OVERDUE_AFTER_DAYS;
}

/** Work the SEO agent holds, or gets when the daily run opens its issue. */
export function isAgentWork(task: TimedTask): boolean {
  if (!isOpenTask(task) || isWaitingTask(task)) return false;
  if (task.assigneeKind === "agent" || task.assigneeKind === "unassigned") return true;
  return !task.issueId && (task.owner ?? "agent") === "agent";
}

/** The SEO agent can pick up work: linked, and not paused, in error or waiting for approval. */
export function agentCanWork(agent: { status?: string | null } | null | undefined): boolean {
  const status = agent?.status ?? null;
  return Boolean(status) && teamRoleHealth({ agentStatus: status, hireOpen: false }) === "ok";
}

/** Why the SEO agent cannot work, in plain words: "Sam is in error", "No SEO agent is linked". */
export function agentTrouble(agent: { name?: string | null; status?: string | null } | null | undefined): string {
  const status = agent?.status ?? null;
  if (!status) return "No SEO agent is linked";
  const name = agent?.name || "The SEO agent";
  if (status === "error") return `${name} is in error`;
  if (status === "paused") return `${name} is paused`;
  if (status === "pending_approval") return `${name} waits for approval`;
  if (["terminated", "archived", "deleted"].includes(status)) return `${name} was removed`;
  return `${name} cannot work (${status.replace(/_/g, " ")})`;
}

/**
 * Why due agent work cannot move, or null: the agent cannot work (checked
 * first: nothing runs until it is fixed), or the task's runs stop at the
 * workspace check.
 */
export function stuckCause(task: TimedTask, day: number, canWork: boolean): "agent" | "runs" | null {
  if (!isDueTask(task, day) || !isAgentWork(task)) return null;
  if (!canWork) return "agent";
  return task.runsFailing ? "runs" : null;
}

export function isStuckTask(task: TimedTask, day: number, canWork: boolean): boolean {
  return stuckCause(task, day, canWork) !== null;
}

/**
 * Why due work is stuck, in plain words, from a tally (agent trouble first):
 * "Sam is in error", "the site repo has no checkout on the server, …", or both.
 */
export function stuckText(numbers: Pick<TaskTally, "stuck" | "stuckRuns">, agent: { name?: string | null; status?: string | null } | null | undefined): string {
  const byAgent = numbers.stuck - numbers.stuckRuns > 0;
  const byRuns = numbers.stuckRuns > 0;
  if (byAgent && byRuns) return `${agentTrouble(agent)}, and ${RUNS_TROUBLE}`;
  if (byAgent) return agentTrouble(agent);
  return byRuns ? `${RUNS_TROUBLE[0]!.toUpperCase()}${RUNS_TROUBLE.slice(1)}` : "";
}

export type TaskState = "done" | "skipped" | "waiting" | "stuck" | "overdue" | "in_progress" | "due" | "upcoming";

/** One state per task, most urgent first: waiting on you, stuck, overdue, in progress, due, upcoming. */
export function taskState(task: TimedTask, day: number, canWork = true): TaskState {
  if (task.status === "done") return "done";
  if (!isOpenTask(task)) return "skipped";
  if (isWaitingTask(task)) return "waiting";
  if (!isDueTask(task, day)) return "upcoming";
  if (isStuckTask(task, day, canWork)) return "stuck";
  if (isOverdueTask(task, day)) return "overdue";
  return task.status === "in_progress" ? "in_progress" : "due";
}

export interface TaskTally {
  total: number;
  done: number;
  /** Skipped or not needed for this site. */
  skipped: number;
  open: number;
  /** Due now and not waiting on a person (includes overdue and stuck). */
  due: number;
  overdue: number;
  stuck: number;
  /** Of `stuck`: stuck because their runs stop at the workspace check (the agent itself can work). */
  stuckRuns: number;
  /** Stuck or overdue, each task once (the Cockpit's Flows view counts these as stuck). */
  attention: number;
  /** The most days any due task is past its day (0 when nothing is due). */
  mostDaysLate: number;
  waiting: number;
  upcoming: number;
}

export function emptyTally(): TaskTally {
  return { total: 0, done: 0, skipped: 0, open: 0, due: 0, overdue: 0, stuck: 0, stuckRuns: 0, attention: 0, mostDaysLate: 0, waiting: 0, upcoming: 0 };
}

export function tallyTasks(tasks: TimedTask[], day: number, canWork = true): TaskTally {
  const tally = emptyTally();
  for (const task of tasks) {
    tally.total += 1;
    if (task.status === "done") {
      tally.done += 1;
      continue;
    }
    if (!isOpenTask(task)) {
      tally.skipped += 1;
      continue;
    }
    tally.open += 1;
    if (isWaitingTask(task)) {
      tally.waiting += 1;
      continue;
    }
    if (!isDueTask(task, day)) {
      tally.upcoming += 1;
      continue;
    }
    tally.due += 1;
    tally.mostDaysLate = Math.max(tally.mostDaysLate, daysLate(task, day));
    const overdue = isOverdueTask(task, day);
    const cause = stuckCause(task, day, canWork);
    if (overdue) tally.overdue += 1;
    if (cause) tally.stuck += 1;
    if (cause === "runs") tally.stuckRuns += 1;
    if (overdue || cause) tally.attention += 1;
  }
  return tally;
}

/** The calendar day a task is due: the sprint start plus its day (no day: the start date). */
export function dueDateOf(startDate: string, dueDay: number | null): string | null {
  try {
    return addDays(startDate, dueDay ?? 0);
  } catch {
    return null;
  }
}

export interface NextTask {
  taskId: string;
  title: string;
  state: TaskState;
  week: number;
  dueDay: number | null;
  /** YYYY-MM-DD */
  dueDate: string | null;
  issueId: string | null;
  issueIdentifier: string | null;
}

const NEXT_ORDER: TaskState[] = ["stuck", "waiting", "overdue", "in_progress", "due", "upcoming"];

/**
 * The next thing due in a sprint: the most urgent open task (stuck, waiting
 * on you, overdue, in progress, due, then upcoming), earliest day first.
 * Tasks come in plan order (week, then when they were added).
 */
export function nextTask<T extends TimedTask & { id: string; title: string; week: number; issueIdentifier?: string | null }>(
  tasks: T[],
  day: number,
  startDate: string,
  canWork = true,
): NextTask | null {
  let best: { task: T; state: TaskState; rank: number; due: number } | null = null;
  for (const task of tasks) {
    const state = taskState(task, day, canWork);
    const rank = NEXT_ORDER.indexOf(state);
    if (rank < 0) continue;
    const due = task.dueDay ?? 0;
    if (!best || rank < best.rank || (rank === best.rank && due < best.due)) best = { task, state, rank, due };
  }
  if (!best) return null;
  return {
    taskId: best.task.id,
    title: best.task.title,
    state: best.state,
    week: best.task.week,
    dueDay: best.task.dueDay,
    dueDate: dueDateOf(startDate, best.task.dueDay),
    issueId: best.task.issueId ?? null,
    issueIdentifier: best.task.issueIdentifier ?? null,
  };
}
