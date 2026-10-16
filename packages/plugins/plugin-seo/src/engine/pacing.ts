/**
 * "Run through week N" on a manual-pacing sprint: the plugin starts the plan's weeks itself, in order, up to a ceiling. The next
 * week starts when nothing of an earlier week is still in the agent's hands. Work that waits on a person or on the client (a
 * blocked task, a Needs you line, a preview with the client) never holds the next week back: waiting for an approval must not
 * stop the rest of the plan. Pure.
 */
export interface PacingTask {
  week: number;
  status: string;
  owner?: string | null;
  assigneeKind?: string | null;
  issueId?: string | null;
  /** A template task of a manual sprint that nobody has started (SprintTask.held). */
  held?: boolean | null;
}

const AGENT_HANDS = new Set(["agent", "unassigned", "reviewer"]);

/** An earlier-week task the agent (or the Reviewer, minutes away from a verdict) still has to finish. */
export function inTheAgentsHands(task: PacingTask): boolean {
  if (task.held) return false;
  if (task.status !== "not_started" && task.status !== "in_progress") return false;
  if (!task.issueId) return true; // due but not opened yet: the daily run or the queue opens it
  return !task.assigneeKind || AGENT_HANDS.has(task.assigneeKind);
}

/** The week to start now, or null (nothing held up to the ceiling, or an earlier week is not out of the agent's hands yet). */
export function nextWeekToRelease(tasks: PacingTask[], ceiling: number | null): number | null {
  if (ceiling == null) return null;
  const heldWeeks = [...new Set(tasks.filter((t) => t.held && t.week <= ceiling).map((t) => t.week))].sort((a, b) => a - b);
  const next = heldWeeks[0];
  if (next === undefined) return null;
  return tasks.some((t) => t.week < next && inTheAgentsHands(t)) ? null : next;
}
