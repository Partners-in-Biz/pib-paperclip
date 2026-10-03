/**
 * Close-out reviews, pure part (no node imports) (Q2-1).
 *
 * Nothing fired when a body of work finished: 0 of 35 projects were ever set to
 * completed (seven were 100% done), and nobody looked at how a finished project
 * ran (retries, reopens, blocked days, what it cost, which agents and skills
 * did it) or what to change because of it. A close-out review is ONE issue for
 * the Operator, opened once per project (or issue tree) and period, with the
 * numbers already gathered and a checklist.
 *
 * When one opens:
 * - FINAL, for work that has an end: every issue of the project is done or
 *   cancelled (at least `minIssues`, at least one done), nothing touched it for
 *   `quietDays`, and it is not evergreen. Or the project was set to completed.
 * - MILESTONE, for evergreen work (a client's continuous workspace: Hunt and
 *   Gun has 85 issues and never "ends"): `milestoneClosed` issues closed since
 *   the last review AND at least `milestoneMinGapDays` days since it, or
 *   `milestoneDays` days with at least `milestoneMinClosed` closed. Counting
 *   starts the day the Cockpit first sees the project (a baseline), so a deploy
 *   does not open a review per old project, and the minimum gap keeps a busy
 *   project (Hunt and Gun closed 90 issues in five days) from asking for a
 *   review every day.
 * - Only work counts: issues opened by a routine run or a plugin's housekeeping
 *   operation (the LLM Wiki project closed 156 of those in five days) are left
 *   out of every count here (`humanWorkSql`), so a project made of them is never
 *   reviewed and a mixed one is judged on its real work.
 * - TREE, for an epic: a root issue with at least `treeMinDescendants` issues
 *   under it, itself done, everything under it done or cancelled.
 *
 * A heuristic can misfire between waves of work, so the cost of a wrong guess is
 * one review that says "nothing to change" and the dedup key keeps it to one.
 */
import type { RunAggregate } from "./measure-model.js";
import { formatDuration, formatTokens, formatUsd, round } from "./measure-model.js";

export const CLOSEOUT = {
  /** A project needs at least this many issues for a final review. */
  minIssues: 3,
  /** Final: nothing created or updated for this many days (the daily sweep). */
  quietDays: 3,
  /** Evergreen: this many issues in all, or work spread over this many days. */
  evergreenIssues: 40,
  evergreenSpanDays: 42,
  /** Milestone: closed since the last review (counting real work only), and never sooner than the minimum gap after the last one. */
  milestoneClosed: 40,
  milestoneMinGapDays: 14,
  milestoneDays: 30,
  milestoneMinClosed: 5,
  /** Tree: issues under the root. */
  treeMinDescendants: 3,
  /** A project finished longer ago than this is not reviewed after the fact. */
  maxAgeDays: 45,
  /** Reviews one company may be given by one sweep: a deploy never floods the Operator. */
  maxPerSweep: 3,
} as const;

/**
 * SQL for "this issue is real work": not a routine execution, not a task the
 * watchdog opened and not a plugin's housekeeping `:operation` issue (the LLM
 * Wiki plugin opens one per page operation, about 25 a day). `alias` is the
 * issues table alias. Close-out counting uses it everywhere, so a project made
 * of automation is never reviewed.
 */
export function humanWorkSql(alias: string): string {
  const kind = `coalesce(${alias}.origin_kind, 'manual')`;
  return `${kind} NOT LIKE 'plugin:%:operation' AND ${kind} NOT IN ('routine_execution', 'task_watchdog')`;
}

export interface ProjectFacts {
  projectId: string;
  name: string;
  /** The host's project status (`backlog`, `planned`, `in_progress`, `completed`, `cancelled`). */
  status: string;
  total: number;
  open: number;
  done: number;
  cancelled: number;
  firstCreated: string | null;
  lastCreated: string | null;
  lastUpdated: string | null;
  lastCompleted: string | null;
}

export interface Cursor {
  /** When the Cockpit last reviewed (or first saw) the project. */
  at: string;
  /** Closed issues (done or cancelled) at that time. */
  closed: number;
  /** True when this is only the day the Cockpit first saw the project, not a review. */
  baseline?: boolean;
}

const DAY = 86_400_000;
const ms = (iso: string | null): number => (iso ? Date.parse(iso) : Number.NaN);
const dateOf = (iso: string | null, fallback: Date): string => (iso && Number.isFinite(Date.parse(iso)) ? iso.slice(0, 10) : fallback.toISOString().slice(0, 10));

/** Work with no end: many issues, or spread over many weeks. */
export function isEvergreen(f: Pick<ProjectFacts, "total" | "firstCreated" | "lastCreated">): boolean {
  if (f.total >= CLOSEOUT.evergreenIssues) return true;
  const span = (ms(f.lastCreated) - ms(f.firstCreated)) / DAY;
  return Number.isFinite(span) && span >= CLOSEOUT.evergreenSpanDays;
}

export type CloseoutKind = "final" | "milestone" | "tree";

export interface CloseoutPlan {
  kind: CloseoutKind;
  /** Dedup key within the project: `final:<date of the last completion>` or `milestone:<date>`. */
  periodKey: string;
  /** Why, in words for the review's first line. */
  reason: string;
}

/**
 * Whether a project needs a review now. `cursor` is the last review or the
 * baseline (null: the Cockpit has never seen the project, so the caller should
 * record a baseline for an evergreen project and wait). `explicitlyCompleted`
 * is a person or agent having set the project's status to completed.
 */
export function planProject(f: ProjectFacts, now: Date, cursor: Cursor | null, options: { quietDays?: number; explicitlyCompleted?: boolean } = {}): CloseoutPlan | null {
  const closed = f.done + f.cancelled;
  const ageDays = (now.getTime() - ms(f.lastCompleted ?? f.lastUpdated)) / DAY;
  const recent = !Number.isFinite(ageDays) || ageDays <= CLOSEOUT.maxAgeDays;
  const completedDate = dateOf(f.lastCompleted ?? f.lastUpdated, now);
  if (options.explicitlyCompleted || f.status === "completed") {
    if (f.total === 0 || !recent) return null;
    return { kind: "final", periodKey: `final:${completedDate}`, reason: `The project was marked completed (${f.done} issues done, ${f.cancelled} cancelled).` };
  }
  if (isEvergreen(f)) {
    if (!cursor) return null;
    const since = Math.max(0, closed - cursor.closed);
    const days = (now.getTime() - ms(cursor.at)) / DAY;
    if (since >= CLOSEOUT.milestoneClosed && days >= CLOSEOUT.milestoneMinGapDays) return { kind: "milestone", periodKey: `milestone:${now.toISOString().slice(0, 10)}`, reason: `${since} issues were closed in the ${Math.floor(days)} days since the last review (one every ${CLOSEOUT.milestoneClosed} closed issues, at most once in ${CLOSEOUT.milestoneMinGapDays} days).` };
    if (days >= CLOSEOUT.milestoneDays && since >= CLOSEOUT.milestoneMinClosed) return { kind: "milestone", periodKey: `milestone:${now.toISOString().slice(0, 10)}`, reason: `${Math.floor(days)} days since the last review, with ${since} issues closed.` };
    return null;
  }
  if (f.open > 0 || f.done < 1 || f.total < CLOSEOUT.minIssues || !recent) return null;
  const quiet = options.quietDays ?? CLOSEOUT.quietDays;
  const touched = Math.max(ms(f.lastUpdated), ms(f.lastCreated));
  if (Number.isFinite(touched) && now.getTime() - touched < quiet * DAY) return null;
  return { kind: "final", periodKey: `final:${completedDate}`, reason: `Every one of its ${f.total} issues is done or cancelled and nothing has changed for ${quiet} days.` };
}

export interface TreeFacts {
  rootId: string;
  identifier: string | null;
  title: string | null;
  total: number;
  open: number;
  rootDone: boolean;
  lastCompleted: string | null;
}

/** An epic is finished when its root is done, at least `treeMinDescendants` issues sit under it, and everything under it is closed. */
export function planTree(t: TreeFacts, now: Date): CloseoutPlan | null {
  const descendants = t.total - 1;
  if (!t.rootDone || t.open > 0 || descendants < CLOSEOUT.treeMinDescendants) return null;
  const age = (now.getTime() - ms(t.lastCompleted)) / DAY;
  if (Number.isFinite(age) && age > CLOSEOUT.maxAgeDays) return null;
  return { kind: "tree", periodKey: `tree:${dateOf(t.lastCompleted, now)}`, reason: `${t.identifier ?? "The epic"} and the ${descendants} issues under it are all closed.` };
}

// ---------------------------------------------------------------------------
// The issue
// ---------------------------------------------------------------------------

export interface CloseoutAgent {
  agentId: string;
  name: string | null;
  usd: number;
  runs: number;
  failed: number;
  skills: string[];
}

export interface CloseoutInput {
  kind: CloseoutKind;
  scopeName: string;
  /** What was measured: `Hunt and Gun` project, the epic `PAR-12`. */
  scopeLabel: string;
  reason: string;
  /** The period measured: from the last review (or the start) to now. */
  fromLabel: string;
  total: RunAggregate;
  agents: CloseoutAgent[];
  issues: { total: number; done: number; cancelled: number; blocked: number; blockedDays: number };
  reopenWakes: number;
  unblockWakes: number;
  closedPerDay: number | null;
  prefix: string | null;
  projectId: string | null;
}

/** Title and description of a close-out review issue. */
export function closeoutContent(input: CloseoutInput): { title: string; description: string } {
  const t = input.total;
  const done = input.issues.done;
  const perDone = done > 0 ? formatUsd(t.usd / done) : "–";
  const kindLabel = input.kind === "final" ? "finished" : input.kind === "tree" ? "epic closed" : "milestone";
  const agents = input.agents
    .slice(0, 6)
    .map((a) => `${a.name ?? "An agent"}: ${formatUsd(a.usd)}, ${a.runs} runs${a.failed ? ` (${a.failed} failed)` : ""}${a.skills.length ? `; skills ${a.skills.slice(0, 6).join(", ")}` : ""}`);
  const table = [
    `| Issues | ${input.issues.total}: ${done} done, ${input.issues.cancelled} cancelled${input.issues.blocked ? `, ${input.issues.blocked} blocked now` : ""} |`,
    `| Runs | ${t.runs}: ${t.succeeded} succeeded, ${t.failed} failed, ${t.cancelled} cancelled |`,
    `| Retries and continuations | ${t.retries} retries, ${t.continuations} continuation wakes, ${input.reopenWakes} reopened by a comment |`,
    `| Blocked | ${input.issues.blockedDays > 0 ? `${round(input.issues.blockedDays, 1)} days across ${input.issues.blocked} ${input.issues.blocked === 1 ? "issue" : "issues"} blocked now` : "nothing blocked now"}; ${input.unblockWakes} spells ended when a blocker resolved |`,
    `| Time | ${round(t.wallSec / 3600, 1)} agent hours; a run takes ${formatDuration(t.p50Sec)} typically, ${formatDuration(t.p90Sec)} at the slow end |`,
    `| Tokens | ${formatTokens(t.inputTokens)} in, ${formatTokens(t.outputTokens)} out, ${formatTokens(t.cachedInputTokens)} read from cache |`,
    `| Notional spend | ${formatUsd(t.usd)}${done > 0 ? `, ${perDone} per finished issue` : ""}${input.closedPerDay !== null ? `; ${round(input.closedPerDay, 1)} issues closed a day` : ""} |`,
    t.limitFailures ? `| Plan limit | ${t.limitFailures} ${t.limitFailures === 1 ? "run" : "runs"} failed on the subscription limit |` : null,
  ].filter((row): row is string => !!row);
  const lines = [
    `**${input.scopeLabel}**: ${kindLabel}. ${input.reason} Review how the work ran, so the next piece runs better. The numbers are already gathered (${input.fromLabel}); notional spend is what the tokens would cost at list price, not what was billed.`,
    "",
    "## How it ran",
    "",
    "| | |",
    "|---|---|",
    ...table,
    "",
    "## Who worked on it",
    "",
    ...(agents.length ? agents.map((a) => `- ${a}`) : ["- No run is linked to these issues."]),
    "",
    "## Checklist",
    "",
    "- [ ] **Read the evidence.** Open the costliest and the most-retried issues (the biggest numbers above) and write, in three lines, what slowed or wasted the work.",
    "- [ ] **Decide what to change.** For each change (a skill, an instruction, a routine, a plugin, who does what) record it with improvement-propose: the number it should move, where it stands now, the target and when to look again. \"Nothing to change\" is a valid answer; say why.",
    "- [ ] **Record what was learned.** Add **Learned:** lines for lasting lessons (company memory), and fold anything that is really a rule for a tool into its skill (improvement-propose with sourceFactId).",
    ...(input.kind === "final" && input.projectId ? [`- [ ] **Close the project in Paperclip.** Set its status to completed (\`PATCH /api/projects/${input.projectId}\` with \`{"status":"completed"}\`) if no more work is planned.`] : []),
    "- [ ] **Close this issue** with one line: efficient, acceptable or wasteful, the two numbers that say so, and the changes you recorded.",
  ].filter((line, i, all) => !(line === "" && all[i - 1] === ""));
  return { title: `Close-out review: ${input.scopeName}`, description: lines.join("\n") };
}
