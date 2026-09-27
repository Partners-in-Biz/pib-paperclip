/**
 * Plain words and tones for the SEO page. Pure (no React, no runtime UI kit
 * import) so tests can import it; the components format the dates.
 */
import type { ToneName } from "@partnersinbiz/pib-plugin-ui";
import type { NextTask, TaskState } from "../engine/due.js";
import { plural } from "../engine/plain.js";

/** A task's state as people read it (engine/due.ts decides the state). */
export const STATE_LABEL: Record<TaskState, string> = {
  done: "Done",
  skipped: "Not needed",
  waiting: "Waiting on you",
  stuck: "Stuck: agent needs attention",
  overdue: "Overdue",
  in_progress: "In progress",
  due: "Due",
  upcoming: "Upcoming",
};

/** Short labels for pills and the plan legend. */
export const STATE_SHORT: Record<TaskState, string> = {
  done: "Done",
  skipped: "Not needed",
  waiting: "Waiting on you",
  stuck: "Stuck",
  overdue: "Overdue",
  in_progress: "In progress",
  due: "Due",
  upcoming: "Upcoming",
};

export const STATE_TONE: Record<TaskState, ToneName> = {
  done: "ok",
  skipped: "neutral",
  waiting: "warn",
  stuck: "bad",
  overdue: "warn",
  in_progress: "info",
  due: "accent",
  upcoming: "neutral",
};

/** Order of the plan legend and the Today list (most urgent first). */
export const STATE_ORDER: TaskState[] = ["stuck", "waiting", "overdue", "in_progress", "due", "upcoming", "done", "skipped"];

export interface SprintLike {
  legacy: boolean;
  status: string;
  day: number;
  phaseName: string;
  tasks?: { due: number; overdue: number; stuck: number; waitingOnYou: number } | null;
}

/** "Day 4 of 90 · Foundation", "Starts in 3 days", "Paused", "No 90-day plan yet". */
export function sprintStatusText(s: SprintLike): string {
  if (s.legacy) return "No 90-day plan yet";
  if (s.status === "paused") return "Paused";
  if (s.status === "archived") return "Archived";
  if (s.day < 0) return `Starts in ${plural(-s.day, "day")}`;
  if (s.day > 90) return `Day ${s.day} · compounding`;
  return `Day ${s.day} of 90 · ${s.phaseName}`;
}

/** One pill per sprint: what needs attention first. */
export function sprintBadge(s: SprintLike): { label: string; tone: ToneName } {
  if (s.legacy) return { label: "No plan yet", tone: "neutral" };
  if (s.status === "paused") return { label: "Paused", tone: "neutral" };
  if (s.status === "archived") return { label: "Archived", tone: "neutral" };
  const n = s.tasks;
  if (n?.stuck) return { label: "Stuck", tone: "bad" };
  if (n?.waitingOnYou) return { label: "Needs you", tone: "warn" };
  if (n?.overdue) return { label: "Overdue", tone: "warn" };
  return { label: "On track", tone: "ok" };
}

/** "13 due · 6 overdue · 2 need you", or "Nothing due". */
export function tasksLine(n: { due: number; overdue: number; waitingOnYou: number } | null | undefined): string {
  if (!n) return "Nothing due";
  const parts = [n.due ? `${n.due} due` : null, n.overdue ? `${n.overdue} overdue` : null, n.waitingOnYou ? `${n.waitingOnYou} ${n.waitingOnYou === 1 ? "needs" : "need"} you` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Nothing due";
}

/** The next thing due: its state word, title and due date (YYYY-MM-DD, formatted by the page). */
export function nextLine(next: NextTask | null | undefined): { label: string; tone: ToneName; title: string; dueDate: string | null } | null {
  if (!next) return null;
  const label = next.state === "upcoming" ? "Next" : STATE_SHORT[next.state];
  return { label, tone: STATE_TONE[next.state], title: next.title, dueDate: next.dueDate };
}

/** Tabs with a "needs you" badge (amber or red) come first on a phone; the rest keep their order. */
export function tabsForPhone<T extends { countTone?: unknown }>(tabs: T[], narrow: boolean): T[] {
  if (!narrow) return tabs;
  const needsYou = (t: T) => t.countTone === "warn" || t.countTone === "bad";
  return [...tabs.filter(needsYou), ...tabs.filter((t) => !needsYou(t))];
}

/** Backlink types in plain words. */
export const BACKLINK_TYPE_LABEL: Record<string, string> = {
  directory: "Directory",
  citation: "Business profile",
  community: "Community",
  guest_post: "Guest post",
  link_trade: "Partner link",
  organic: "Earned link",
  other: "Other",
};

export const BACKLINK_STATUS_LABEL: Record<string, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  submitted: "Submitted",
  live: "Live",
  rejected: "Rejected",
  lost: "Lost",
};
