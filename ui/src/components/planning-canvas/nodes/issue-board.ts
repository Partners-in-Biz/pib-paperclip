import { ISSUE_STATUSES, PLANNING_CANVAS_LIMITS, type PlanningCanvasIssueQuery, type PlanningCanvasKanbanData, type PlanningCanvasTimelineData } from "@paperclipai/shared";

/** One issue as `POST .../query` returns it (the same summary the refs read uses, plus dates). */
export interface QueriedIssue {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  projectId: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export type KanbanGroupBy = PlanningCanvasKanbanData["groupBy"];
export type TimelineScale = PlanningCanvasTimelineData["scale"];

export const PRIORITIES = ["critical", "high", "medium", "low"] as const;
export const UNASSIGNED = "unassigned";

export function defaultQuery(): PlanningCanvasIssueQuery {
  return { kind: "issues", filter: {}, limit: PLANNING_CANVAS_LIMITS.issueQueryLimitMax };
}
export function newKanban(): PlanningCanvasKanbanData {
  return { source: defaultQuery(), groupBy: "status", collapsed: [] };
}
export function newTimeline(): PlanningCanvasTimelineData {
  return { source: defaultQuery(), scale: "week" };
}

export function isKanbanData(value: unknown): value is PlanningCanvasKanbanData {
  const v = value as PlanningCanvasKanbanData | null | undefined;
  return !!v && typeof v === "object" && v.source?.kind === "issues" && ["status", "assignee", "priority"].includes(v.groupBy) && Array.isArray(v.collapsed);
}
export function isTimelineData(value: unknown): value is PlanningCanvasTimelineData {
  const v = value as PlanningCanvasTimelineData | null | undefined;
  return !!v && typeof v === "object" && (v.source?.kind === "issues" || v.source?.kind === "projects") && ["day", "week", "month"].includes(v.scale);
}

/** True when the read hit its cap, so more issues may exist than are shown. */
export function isCapped(count: number, query: PlanningCanvasIssueQuery) {
  return count >= Math.min(query.limit, PLANNING_CANVAS_LIMITS.issueQueryLimitMax);
}

export interface KanbanColumn {
  key: string;
  issues: QueriedIssue[];
}

function groupKey(issue: QueriedIssue, groupBy: KanbanGroupBy) {
  if (groupBy === "status") return issue.status;
  if (groupBy === "priority") return issue.priority;
  return issue.assigneeAgentId ?? (issue.assigneeUserId ? `user:${issue.assigneeUserId}` : UNASSIGNED);
}

/** Columns in a stable order: known statuses and priorities in workflow order, assignees by first appearance. */
export function groupIssues(issues: readonly QueriedIssue[], groupBy: KanbanGroupBy): KanbanColumn[] {
  const columns = new Map<string, QueriedIssue[]>();
  if (groupBy === "status") for (const s of ISSUE_STATUSES) columns.set(s, []);
  if (groupBy === "priority") for (const p of PRIORITIES) columns.set(p, []);
  for (const issue of issues) {
    const key = groupKey(issue, groupBy);
    const list = columns.get(key);
    if (list) list.push(issue);
    else columns.set(key, [issue]);
  }
  return [...columns].map(([key, list]) => ({ key, issues: list }));
}

/** Return `issues` with one issue's status replaced (the optimistic move). */
export function withStatus(issues: readonly QueriedIssue[], id: string, status: string): QueriedIssue[] {
  return issues.map((issue) => (issue.id === id ? { ...issue, status } : issue));
}

const DAY_MS = 86_400_000;
/** Width of one day, in rem, at each scale. */
export const DAY_REM: Record<TimelineScale, number> = { day: 2.5, week: 0.75, month: 0.2 };
/** Tick spacing in days at each scale. */
const TICK_DAYS: Record<TimelineScale, number> = { day: 1, week: 7, month: 30 };

export interface TimelineBar {
  id: string;
  label: string;
  start: number;
  end: number;
  done: boolean;
}
export interface TimelineMilestone {
  id: string;
  label: string;
  at: number;
}

const parse = (iso: string | null | undefined) => {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

/** Q10: startedAt (or createdAt) to completedAt (or now). No due-date column exists, so none is shown. */
export function issueBars(issues: readonly QueriedIssue[], now: number): TimelineBar[] {
  const bars: TimelineBar[] = [];
  for (const issue of issues) {
    const start = parse(issue.startedAt) ?? parse(issue.createdAt);
    if (start === null) continue;
    const completed = parse(issue.completedAt);
    bars.push({
      id: issue.id,
      label: issue.identifier ? `${issue.identifier} ${issue.title}` : issue.title,
      start,
      end: Math.max(start, completed ?? now),
      done: completed !== null,
    });
  }
  return bars.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

export interface TimelineProject {
  id: string;
  name: string;
  targetDate: string | null;
  createdAt: string | Date;
}

/** Project target dates are milestones; a project outside the query's issues is left out. */
export function projectMilestones(projects: readonly TimelineProject[], only: ReadonlySet<string> | null): TimelineMilestone[] {
  const out: TimelineMilestone[] = [];
  for (const project of projects) {
    if (only && !only.has(project.id)) continue;
    const at = parse(project.targetDate);
    if (at !== null) out.push({ id: project.id, label: project.name, at });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Bars for the `projects` source: a project runs from its creation to its target date (or now). */
export function projectBars(projects: readonly TimelineProject[], now: number): TimelineBar[] {
  const bars: TimelineBar[] = [];
  for (const project of projects) {
    const start = parse(typeof project.createdAt === "string" ? project.createdAt : project.createdAt.toISOString());
    if (start === null) continue;
    const target = parse(project.targetDate);
    bars.push({ id: project.id, label: project.name, start, end: Math.max(start, target ?? now), done: target !== null && target <= now });
  }
  return bars.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

export interface TimelineLayout {
  from: number;
  to: number;
  widthRem: number;
  ticks: Array<{ at: number; pct: number; label: string }>;
  pct: (ms: number) => number;
}

function tickLabel(ms: number, scale: TimelineScale) {
  const d = new Date(ms);
  if (scale === "month") return d.toLocaleDateString(undefined, { month: "short", year: "2-digit", timeZone: "UTC" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Range, width and ticks. `range` (when set) wins; otherwise the data's extent with a day of padding each side. */
export function timelineLayout(
  bars: readonly TimelineBar[],
  milestones: readonly TimelineMilestone[],
  scale: TimelineScale,
  now: number,
  range?: { from: string; to: string },
): TimelineLayout {
  const points = [...bars.flatMap((b) => [b.start, b.end]), ...milestones.map((m) => m.at)];
  let from = parse(range?.from) ?? (points.length ? Math.min(...points) : now - 7 * DAY_MS);
  let to = parse(range?.to) ?? (points.length ? Math.max(...points) : now + 7 * DAY_MS);
  if (!range) {
    from -= DAY_MS;
    to += DAY_MS;
  }
  if (to <= from) to = from + DAY_MS;
  const startDay = Math.floor(from / DAY_MS) * DAY_MS;
  const days = Math.max(1, Math.ceil((to - startDay) / DAY_MS));
  const span = days * DAY_MS;
  const pct = (ms: number) => Math.min(100, Math.max(0, ((ms - startDay) / span) * 100));
  const ticks: TimelineLayout["ticks"] = [];
  for (let d = 0; d <= days; d += TICK_DAYS[scale]) {
    const at = startDay + d * DAY_MS;
    ticks.push({ at, pct: pct(at), label: tickLabel(at, scale) });
  }
  return { from: startDay, to: startDay + span, widthRem: Math.max(days * DAY_REM[scale], 12), ticks, pct };
}
