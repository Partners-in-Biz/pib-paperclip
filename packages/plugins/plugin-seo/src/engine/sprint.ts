/**
 * Pure sprint rules: the clock (day/week/phase/status), which tasks are due,
 * who gets them, and how Paperclip issue status maps back onto tasks.
 */
import { phaseForWeek, type SprintPhase, type TaskOwner } from "../templates/outrank-90.js";
import { daysBetween } from "./time.js";

export type SprintStatus = "pre_launch" | "active" | "compounding" | "paused" | "archived";
export type AutopilotMode = "off" | "safe" | "full";
export type TaskStatus = "not_started" | "in_progress" | "blocked" | "done" | "skipped" | "na";
export type TaskSource = "template" | "manual" | "optimization";

export const SPRINT_STATUSES: SprintStatus[] = ["pre_launch", "active", "compounding", "paused", "archived"];
export const AUTOPILOT_MODES: AutopilotMode[] = ["off", "safe", "full"];
export const TASK_STATUSES: TaskStatus[] = ["not_started", "in_progress", "blocked", "done", "skipped", "na"];
export const OPEN_TASK_STATUSES: TaskStatus[] = ["not_started", "in_progress", "blocked"];
export const TERMINAL_TASK_STATUSES: TaskStatus[] = ["done", "skipped", "na"];
export const LAST_TEMPLATE_WEEK = 13;

export interface SprintClock {
  day: number;
  week: number;
  phase: SprintPhase;
  /** Status the calendar implies for a running sprint. */
  runningStatus: Extract<SprintStatus, "pre_launch" | "active" | "compounding">;
}

/**
 * Day 0 is the start (launch) date. Days before it are negative.
 * Week 0 is pre-launch (day ≤ 0); week 1 is days 1–7, week 13 is days 85–91,
 * week 14+ is compounding.
 */
export function weekForDay(day: number): number {
  return day <= 0 ? 0 : Math.ceil(day / 7);
}

export function sprintClock(startDate: string, today: string): SprintClock {
  const day = daysBetween(startDate, today);
  const week = weekForDay(day);
  const phase = phaseForWeek(week);
  const runningStatus = day <= 0 ? "pre_launch" : week <= LAST_TEMPLATE_WEEK ? "active" : "compounding";
  return { day, week, phase, runningStatus };
}

/** Paused and archived sprints keep their status; running sprints follow the calendar. */
export function nextSprintStatus(current: SprintStatus, clock: SprintClock): SprintStatus {
  if (current === "paused" || current === "archived") return current;
  return clock.runningStatus;
}

export function isRunning(status: SprintStatus): boolean {
  return status === "pre_launch" || status === "active" || status === "compounding";
}

export interface DueCandidate {
  status: TaskStatus;
  issueId: string | null;
  /** Sprint day the task is due; null = due immediately. */
  dueDay: number | null;
}

export function isDue(task: Pick<DueCandidate, "dueDay">, day: number): boolean {
  return task.dueDay == null || task.dueDay <= day;
}

/** Tasks that should get a Paperclip issue now. */
export function selectDueTasks<T extends DueCandidate>(tasks: T[], day: number): T[] {
  return tasks.filter((task) => task.status === "not_started" && !task.issueId && isDue(task, day));
}

export type AgentAvailability = { id: string; status: string } | null;

export type Assignment =
  | { kind: "agent"; agentId: string; reviewGate: boolean; wake: boolean }
  | { kind: "user"; userId: string | null; reason: "human_task" | "autopilot_off" }
  | { kind: "unassigned"; reason: "agent_unavailable" };

const UNWAKEABLE_AGENT_STATUSES = new Set(["paused", "pending_approval", "terminated"]);

/** Safe mode: agent work that publishes, sends or changes the live site needs a person's sign-off. */
export function needsSignoff(task: { owner: TaskOwner; autopilotEligible: boolean }, mode: AutopilotMode): boolean {
  return task.owner === "agent" && !task.autopilotEligible && mode !== "full";
}

export function decideAssignee(input: {
  owner: TaskOwner;
  autopilotEligible: boolean;
  mode: AutopilotMode;
  agent: AgentAvailability;
  ownerUserId: string | null;
}): Assignment {
  if (input.owner === "human") return { kind: "user", userId: input.ownerUserId, reason: "human_task" };
  if (input.mode === "off") return { kind: "user", userId: input.ownerUserId, reason: "autopilot_off" };
  if (!input.agent || input.agent.status === "terminated") return { kind: "unassigned", reason: "agent_unavailable" };
  return {
    kind: "agent",
    agentId: input.agent.id,
    reviewGate: needsSignoff(input, input.mode),
    wake: !UNWAKEABLE_AGENT_STATUSES.has(input.agent.status),
  };
}

/**
 * Map a Paperclip issue status onto the task. Returns the new task status, or
 * null when the task should not change.
 */
export function taskStatusFromIssue(issueStatus: string, current: TaskStatus): TaskStatus | null {
  switch (issueStatus) {
    case "done":
      return current === "done" ? null : "done";
    case "cancelled":
      return current === "skipped" || current === "na" ? null : "skipped";
    case "blocked":
      return current === "blocked" ? null : "blocked";
    case "in_progress":
    case "in_review":
      return current === "in_progress" ? null : "in_progress";
    case "todo":
    case "backlog":
      // Reopened or unblocked by a person: work resumes. A fresh task stays not started.
      return current === "blocked" || current === "done" || current === "skipped" ? "in_progress" : null;
    default:
      return null;
  }
}

export const SCHEDULED_AUDIT_DAYS = [0, 30, 60, 90];

/** Scheduled snapshot days up to `day`: 0, 30, 60, 90, then every 30 days while compounding. */
export function scheduledAuditDays(day: number): number[] {
  const out: number[] = [];
  for (const d of SCHEDULED_AUDIT_DAYS) if (d <= day) out.push(d);
  for (let d = 120; d <= day; d += 30) out.push(d);
  return out;
}

/**
 * Which snapshot to capture today. When several are missing (a sprint created
 * late, or a missed run) only the latest is captured; the older ones are marked
 * done so we never record duplicate snapshots of the same data.
 */
export function auditCapturePlan(day: number, done: number[]): { capture: number | null; markDone: number[] } {
  const doneSet = new Set(done);
  const missing = scheduledAuditDays(day).filter((d) => !doneSet.has(d));
  if (missing.length === 0) return { capture: null, markDone: [] };
  return { capture: Math.max(...missing), markDone: missing };
}

/** Optimization proposals allowed now: 2 per rolling 7 days in the first 4 weeks, 5 after. */
export function proposalAllowance(day: number, proposedLast7Days: number): number {
  const cap = day <= 28 ? 2 : 5;
  return Math.max(0, cap - proposedLast7Days);
}

export function keywordStatusForPosition(position: number | null | undefined): "top_3" | "top_10" | "ranking" | "not_yet" {
  if (position == null || !Number.isFinite(position) || position <= 0) return "not_yet";
  if (position <= 3) return "top_3";
  if (position <= 10) return "top_10";
  if (position <= 100) return "ranking";
  return "not_yet";
}
