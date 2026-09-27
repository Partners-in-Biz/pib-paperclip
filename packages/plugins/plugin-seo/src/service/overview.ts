/**
 * Each sprint's numbers and the next thing due, from one set of rules
 * (engine/due.ts): the SEO page, `list-sprints`, the CRM client card and the
 * Cockpit all read them from here, so their numbers agree.
 */
import * as db from "../db.js";
import { agentCanWork, nextTask, tallyTasks, type NextTask, type TaskTally } from "../engine/due.js";
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
  input: { today: string; openTasks: db.SprintTask[]; totals?: db.SprintTotals; needsYou?: number; agent: { status?: string | null } | null },
): SprintOverview {
  const day = sprintClock(sprint.startDate, input.today).day;
  // A paused or archived sprint waits on purpose: its work is not stuck.
  const canWork = isRunning(sprint.status) ? agentCanWork(input.agent) : true;
  const tally = tallyTasks(input.openTasks, day, canWork);
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
  };
  const tasks = input.openTasks.map((task) => ({ ...task, title: displayTitle(task, sprint.templateId) }));
  return { numbers, next: nextTask(tasks, day, sprint.startDate, canWork) };
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
  const [totals, open, digests] = await Promise.all([
    db.sprintTotals(sdb, companyId),
    db.listOpenTasksForCompany(sdb, companyId),
    db.openNeedsYouDigests(sdb, companyId).catch(() => [] as Array<{ sprintId: string; items: [] }>),
  ]);
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

/** Sums over active sprints: what the SEO page's tiles and the Cockpit show. */
export function activeTotals(sprints: db.Sprint[], overviews: Map<string, SprintOverview>): { active: number; due: number; overdue: number; stuck: number; waitingOnYou: number } {
  const out = { active: 0, due: 0, overdue: 0, stuck: 0, waitingOnYou: 0 };
  for (const sprint of sprints) {
    if (!isActiveSprint(sprint)) continue;
    const n = overviews.get(sprint.id)?.numbers;
    out.active += 1;
    if (!n) continue;
    out.due += n.due;
    out.overdue += n.overdue;
    out.stuck += n.stuck;
    out.waitingOnYou += n.waitingOnYou;
  }
  return out;
}
