/**
 * Each sprint's numbers and the next thing due, from one set of rules
 * (engine/due.ts): the SEO page, `list-sprints`, the CRM client card and the
 * Cockpit all read them from here, so their numbers agree.
 */
import * as db from "../db.js";
import { agentCanWork, isOpenTask, nextTask, stuckCause, tallyTasks, WORKSPACE_FAILURE_CODE, type NextTask, type TaskTally } from "../engine/due.js";
import { countOpenNeedsYou } from "../engine/needs-you.js";
import { isRunning, sprintClock } from "../engine/sprint.js";
import { planTask } from "../templates/plans.js";

export interface SprintNumbers extends TaskTally {
  /** Open tasks that have an issue. */
  openIssues: number;
  /** Optimization proposals waiting for a decision. */
  proposals: number;
  /** Open, required Needs you items. */
  needsYou: number;
  /** What waits on a person: Needs you items, plus proposals unless autopilot is full (what the Cockpit lists). */
  waitingOnYou: number;
  /** Projects whose workspace check stops the runs of this sprint's stuck tasks (fix each one's Codebase). */
  runsProjectIds: string[];
}

export interface SprintOverview {
  numbers: SprintNumbers;
  next: NextTask | null;
}

/** An active sprint runs its plan: running (pre-launch, active or compounding) and seeded with a 90-day plan. */
export function isActiveSprint(sprint: Pick<db.Sprint, "status" | "seededAt">): boolean {
  return isRunning(sprint.status) && Boolean(sprint.seededAt);
}

/**
 * The title people read: a template task shows its plan's current title (plain
 * words), so sprints seeded with older wording read the same as new ones.
 */
export function displayTitle(task: Pick<db.SprintTask, "title" | "templateKey" | "source">, templateId: string | null | undefined): string {
  if (task.source !== "template") return task.title;
  return planTask(templateId, task.templateKey)?.title ?? task.title;
}

export function overviewFor(
  sprint: db.Sprint,
  input: { today: string; openTasks: Array<db.SprintTask & { runsFailing?: boolean | null }>; totals?: db.SprintTotals; needsYou?: number; agent: { status?: string | null } | null },
): SprintOverview {
  const day = sprintClock(sprint.startDate, input.today).day;
  // A paused or archived sprint waits on purpose: its work is not stuck.
  const running = isRunning(sprint.status);
  const canWork = running ? agentCanWork(input.agent) : true;
  const openTasks = running ? input.openTasks : input.openTasks.map((task) => ({ ...task, runsFailing: false }));
  const tally = tallyTasks(openTasks, day, canWork);
  const runsProjectIds = [...new Set(openTasks.filter((task) => task.issueProjectId && stuckCause(task, day, canWork) === "runs").map((task) => task.issueProjectId!))];
  const totals = input.totals ?? { total: tally.total, done: 0, skipped: 0, openIssues: 0, proposals: 0 };
  const needsYou = input.needsYou ?? 0;
  const numbers: SprintNumbers = {
    ...tally,
    total: totals.total,
    done: totals.done,
    skipped: totals.skipped,
    openIssues: totals.openIssues,
    proposals: totals.proposals,
    needsYou,
    waitingOnYou: needsYou + (sprint.autopilotMode === "full" ? 0 : totals.proposals),
    runsProjectIds,
  };
  const tasks = openTasks.map((task) => ({ ...task, title: displayTitle(task, sprint.templateId) }));
  return { numbers, next: nextTask(tasks, day, sprint.startDate, canWork) };
}

/**
 * A not-started task whose issue has had an agent run is in progress: the host sends no event when an agent
 * picks an issue up, so the plan would show it as due until it finished. Saved on the task; never throws.
 */
export async function withStartedWork<T extends db.SprintTask>(sdb: db.SeoDb, companyId: string, tasks: T[]): Promise<T[]> {
  const waiting = tasks.filter((task) => task.status === "not_started" && task.issueId && task.assigneeKind !== "needs_you");
  if (waiting.length === 0) return tasks;
  try {
    const started = await db.issuesWithStartedRuns(sdb, companyId, waiting.map((task) => task.issueId!));
    if (started.size === 0) return tasks;
    return await Promise.all(tasks.map(async (task) => {
      if (task.status !== "not_started" || !task.issueId || !started.has(task.issueId)) return task;
      const at = task.startedAt ?? started.get(task.issueId) ?? new Date().toISOString();
      await db.updateTask(sdb, companyId, task.id, { status: "in_progress", started_at: at });
      return { ...task, status: "in_progress", startedAt: at };
    }));
  } catch {
    return tasks;
  }
}

/**
 * Marks each open task whose issue's latest run stopped at the host's
 * workspace check (no checkout of the project's repo on the server): that
 * work is stuck (engine/due.ts). Unknown when the lookup fails: never throws.
 */
export async function withRunFailures<T extends db.SprintTask>(sdb: db.SeoDb, companyId: string, input: T[]): Promise<Array<T & { runsFailing: boolean }>> {
  const tasks = await withStartedWork(sdb, companyId, input);
  const issueIds = tasks.filter((task) => task.issueId && isOpenTask(task)).map((task) => task.issueId!);
  let failing = new Map<string, unknown>();
  if (issueIds.length > 0) {
    try {
      failing = await db.issuesWithFailingRuns(sdb, companyId, issueIds, WORKSPACE_FAILURE_CODE);
    } catch {
      failing = new Map();
    }
  }
  return tasks.map((task) => ({ ...task, runsFailing: Boolean(task.issueId && isOpenTask(task) && failing.has(task.issueId)) }));
}

/** Numbers and the next thing due for every given sprint of a company. */
export async function sprintOverviews(
  sdb: db.SeoDb,
  companyId: string,
  sprints: db.Sprint[],
  today: string,
  agent: { status?: string | null } | null,
): Promise<Map<string, SprintOverview>> {
  const out = new Map<string, SprintOverview>();
  if (sprints.length === 0) return out;
  const [totals, listed, digests] = await Promise.all([
    db.sprintTotals(sdb, companyId),
    db.listOpenTasksForCompany(sdb, companyId),
    db.openNeedsYouDigests(sdb, companyId).catch(() => [] as Array<{ sprintId: string; items: [] }>),
  ]);
  // Runs that stop at the workspace check make due work stuck, like an agent that cannot work.
  const open = await withRunFailures(sdb, companyId, listed);
  const needs = countOpenNeedsYou(digests);
  const bySprint = new Map<string, db.SprintTask[]>();
  for (const task of open) {
    const list = bySprint.get(task.sprintId);
    if (list) list.push(task);
    else bySprint.set(task.sprintId, [task]);
  }
  for (const sprint of sprints) {
    out.set(sprint.id, overviewFor(sprint, { today, openTasks: bySprint.get(sprint.id) ?? [], totals: totals[sprint.id], needsYou: needs.get(sprint.id) ?? 0, agent }));
  }
  return out;
}

export interface ActiveTotals {
  active: number;
  due: number;
  overdue: number;
  stuck: number;
  /** Of `stuck`: runs stop at the workspace check. */
  stuckRuns: number;
  /** Stuck or overdue, each task once. */
  attention: number;
  mostDaysLate: number;
  waitingOnYou: number;
  /** Projects whose workspace check stops the runs (see SprintNumbers). */
  runsProjectIds: string[];
}

/** Sums over active sprints: what the SEO page's tiles and the Cockpit show. */
export function activeTotals(sprints: db.Sprint[], overviews: Map<string, SprintOverview>): ActiveTotals {
  const out: ActiveTotals = { active: 0, due: 0, overdue: 0, stuck: 0, stuckRuns: 0, attention: 0, mostDaysLate: 0, waitingOnYou: 0, runsProjectIds: [] };
  for (const sprint of sprints) {
    if (!isActiveSprint(sprint)) continue;
    const n = overviews.get(sprint.id)?.numbers;
    out.active += 1;
    if (!n) continue;
    out.due += n.due;
    out.overdue += n.overdue;
    out.stuck += n.stuck;
    out.stuckRuns += n.stuckRuns;
    out.attention += n.attention;
    out.mostDaysLate = Math.max(out.mostDaysLate, n.mostDaysLate);
    out.waitingOnYou += n.waitingOnYou;
    for (const id of n.runsProjectIds ?? []) if (!out.runsProjectIds.includes(id)) out.runsProjectIds.push(id);
  }
  return out;
}
