/**
 * Company goals, pure part (no node imports) (Q10-3).
 *
 * The weekly retro reviewed the agents, never the business: nothing said how
 * many leads, which rank, how many posts or how much revenue the company
 * wanted, so nothing could be compared to what happened. A goal here is a
 * metric (a number a module reports, or one of the Cockpit's own, see
 * `metrics-keys.ts`), a target, which way is better and the period it is
 * measured over. Agents propose goals; the owner confirms them once, batched
 * in one question; every Monday the Operator gets a review comparing actuals
 * to targets.
 *
 * The host's own goals table has no target, metric or period fields (and the
 * plugin may not change host code), so targets live in the Cockpit's table and
 * each active goal is mirrored to a host goal (title and status) when the
 * plugin may write them, so the goal also shows where the host lists goals.
 */
import { METRIC_KEY_HELP, parseMetricKey, type Better } from "./metrics-keys.js";

export const GOAL_PERIODS = ["week", "month", "quarter", "year"] as const;
export type GoalPeriod = (typeof GOAL_PERIODS)[number];
export type GoalStatus = "proposed" | "active" | "achieved" | "missed" | "dropped";

export class GoalError extends Error {}

export const GOAL_LIMITS = { title: 120, description: 400, unit: 20, label: 120 } as const;
/** How many active goals a company is asked to set. */
export const GOALS_WANTED = 3;
/** How many it may have at once: more than this is a wish list, not a plan. */
export const GOALS_MAX_ACTIVE = 12;

export interface GoalRow {
  id: string;
  companyId: string;
  title: string;
  description: string | null;
  metricKey: string;
  metricLabel: string | null;
  unit: string | null;
  direction: Better;
  targetValue: number;
  baselineValue: number | null;
  period: GoalPeriod;
  dueOn: string | null;
  status: GoalStatus;
  hostGoalId: string | null;
  ownerAgentId: string | null;
  lastValue: number | null;
  lastValueAt: string | null;
  proposedByAgentId: string | null;
  confirmedByUserId: string | null;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GoalInput {
  id: string | null;
  title: string | null;
  description: string | null;
  metricKey: string | null;
  metricLabel: string | null;
  unit: string | null;
  direction: Better | null;
  targetValue: number | null;
  baselineValue: number | null;
  period: GoalPeriod | null;
  dueOn: string | null;
  ownerAgentId: string | null;
  /** Record the actual for a metric nothing reads (`manual`). */
  value: number | null;
  /** Only to drop a goal that is still a proposal. */
  drop: boolean;
}

function text(value: unknown, max: number): string | null {
  const t = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return t ? t.slice(0, max) : null;
}

function numberOrNull(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  const x = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(x)) throw new GoalError(`${field} must be a number.`);
  return x;
}

/** Validates what an agent sent to `goal-set`. Every message says what to pass instead. */
export function parseGoalInput(raw: Record<string, unknown>): GoalInput {
  const id = text(raw.id, 40);
  const period = raw.period === undefined || raw.period === "" || raw.period === null ? null : raw.period;
  if (period !== null && !(GOAL_PERIODS as readonly string[]).includes(String(period))) throw new GoalError(`period must be one of ${GOAL_PERIODS.join(", ")}: how often the number is compared with the target.`);
  const direction = raw.direction === undefined || raw.direction === "" || raw.direction === null ? null : raw.direction;
  if (direction !== null && direction !== "lower" && direction !== "higher") throw new GoalError("direction must be lower or higher: which way is better.");
  const metricKey = text(raw.metricKey, 120);
  if (metricKey && !parseMetricKey(metricKey)) throw new GoalError(`"${metricKey}" is not a metric key. ${METRIC_KEY_HELP}`);
  let dueOn: string | null = null;
  if (raw.dueOn !== undefined && raw.dueOn !== null && raw.dueOn !== "") {
    const value = typeof raw.dueOn === "string" ? raw.dueOn.trim() : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new GoalError("dueOn must be a date as YYYY-MM-DD.");
    dueOn = value;
  }
  const input: GoalInput = {
    id,
    title: text(raw.title, GOAL_LIMITS.title),
    description: text(raw.description, GOAL_LIMITS.description),
    metricKey,
    metricLabel: text(raw.metricLabel, GOAL_LIMITS.label),
    unit: text(raw.unit, GOAL_LIMITS.unit),
    direction: direction as Better | null,
    targetValue: numberOrNull(raw.targetValue, "targetValue"),
    baselineValue: numberOrNull(raw.baselineValue, "baselineValue"),
    period: period as GoalPeriod | null,
    dueOn,
    ownerAgentId: text(raw.ownerAgentId, 64),
    value: numberOrNull(raw.value, "value"),
    drop: raw.drop === true,
  };
  if (!id) {
    if (!input.title) throw new GoalError('title is required for a new goal: one line the owner would say, e.g. "30 new leads a month".');
    if (!input.metricKey) throw new GoalError(`metricKey is required: the number the goal is measured by. ${METRIC_KEY_HELP}`);
    if (input.targetValue === null) throw new GoalError("targetValue is required: the number to reach (a number, not a range).");
  }
  return input;
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export type GoalState = "reached" | "on_track" | "behind" | "no_data";

/** At or above this share of the way to the target counts as on track. */
export const ON_TRACK_AT = 0.8;

export interface GoalProgress {
  state: GoalState;
  current: number | null;
  /** Share of the way from the baseline (else from zero) to the target; may pass 1; null with no value. */
  progress: number | null;
  /** current - last recorded value, null when there is none. */
  change: number | null;
}

const fmt = (x: number): string => (Math.abs(x) >= 100 ? String(Math.round(x)) : String(Math.round(x * 100) / 100));

export function goalProgress(goal: Pick<GoalRow, "direction" | "targetValue" | "baselineValue">, current: number | null, previous: number | null = null): GoalProgress {
  if (current === null) return { state: "no_data", current: null, progress: null, change: null };
  const { direction, targetValue: target } = goal;
  const base = goal.baselineValue ?? (direction === "higher" ? 0 : null);
  const reached = direction === "higher" ? current >= target : current <= target;
  let progress: number;
  if (direction === "higher") progress = base !== null && target !== base ? (current - base) / (target - base) : target === 0 ? 1 : current / target;
  else progress = base !== null && base !== target ? (base - current) / (base - target) : current <= target ? 1 : target / Math.max(current, 1e-9);
  const state: GoalState = reached ? "reached" : progress >= ON_TRACK_AT ? "on_track" : "behind";
  return { state, current, progress: Math.round(progress * 1000) / 1000, change: previous === null ? null : Math.round((current - previous) * 100) / 100 };
}

export const STATE_LABEL: Record<GoalState, string> = { reached: "Reached", on_track: "On track", behind: "Behind", no_data: "No number" };

/** One goal as the tool and the review print it. */
export function goalBrief(goal: GoalRow, progress: GoalProgress): Record<string, unknown> {
  return {
    id: goal.id,
    title: goal.title,
    status: goal.status,
    metric: goal.metricKey,
    metricLabel: goal.metricLabel,
    unit: goal.unit,
    better: goal.direction,
    target: goal.targetValue,
    baseline: goal.baselineValue,
    period: goal.period,
    dueOn: goal.dueOn,
    current: progress.current,
    progressPct: progress.progress === null ? null : Math.round(progress.progress * 100),
    state: progress.state,
    changeSinceLastReview: progress.change,
    owner: goal.ownerAgentId,
  };
}

// ---------------------------------------------------------------------------
// The weekly business review
// ---------------------------------------------------------------------------

export interface ReviewGoalRow {
  goal: GoalRow;
  progress: GoalProgress;
  /** The number the Cockpit could not read, with why. */
  note: string | null;
}

/** Title and description of the weekly business review issue. */
export function businessReviewContent(input: {
  weekLabel: string;
  rows: ReviewGoalRow[];
  proposedWaiting: number;
  cockpitHref: string;
}): { title: string; description: string } {
  const { rows } = input;
  const reached = rows.filter((r) => r.progress.state === "reached").length;
  const behind = rows.filter((r) => r.progress.state === "behind");
  const noData = rows.filter((r) => r.progress.state === "no_data");
  const lines: string[] = [
    `The business, against its goals, for the week of ${input.weekLabel}. ${rows.length} active ${rows.length === 1 ? "goal" : "goals"}: ${reached} reached, ${rows.length - reached - behind.length - noData.length} on track, ${behind.length} behind${noData.length ? `, ${noData.length} with no number` : ""}.`,
    "",
    "| Goal | Number | Target | Now | Last review | Progress | State |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const { goal, progress } of rows) {
    const unit = goal.unit ? ` ${goal.unit}` : "";
    const last = progress.current !== null && progress.change !== null ? fmt(progress.current - progress.change) + unit : "–";
    lines.push(
      `| ${goal.title} | ${goal.metricLabel ?? goal.metricKey} (${goal.period}) | ${goal.direction === "lower" ? "at most " : ""}${fmt(goal.targetValue)}${unit} | ${progress.current === null ? "–" : fmt(progress.current) + unit} | ${last} | ${progress.progress === null ? "–" : `${Math.round(progress.progress * 100)}%`} | ${STATE_LABEL[progress.state]} |`,
    );
  }
  lines.push("");
  if (input.proposedWaiting > 0) lines.push(`${input.proposedWaiting} proposed ${input.proposedWaiting === 1 ? "goal waits" : "goals wait"} for the owner's yes (one question is already open; do not ask again).`, "");
  lines.push("## Checklist", "");
  for (const { goal, progress } of rows.filter((r) => r.progress.state === "behind" || r.progress.state === "no_data")) {
    if (progress.state === "behind") lines.push(`- [ ] **${goal.title}** is behind (${progress.progress === null ? "" : `${Math.round(progress.progress * 100)}% of the way`}): find the cause in the modules' numbers, name the change that moves it, hand it to the agent that owns it (a Hand-off issue), and say when you will look again.`);
    else lines.push(`- [ ] **${goal.title}** has no number: ${rows.find((r) => r.goal.id === goal.id)?.note ?? "the Cockpit could not read it"}. Fix the source, or record it with goal-set (id, value).`);
  }
  if (behind.length === 0 && noData.length === 0) lines.push("- [ ] Nothing is behind. Say in one line what drove the best number, and whether any target should be raised (ask the owner, one question, if so).");
  lines.push(
    "- [ ] Close this issue with one line per behind goal: the cause and the change you handed off (**Learned:** lines for anything lasting).",
    "",
    `[Open the Cockpit](${input.cockpitHref})`,
  );
  return { title: `Business review: week of ${input.weekLabel}`, description: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// The one question that confirms the proposed goals
// ---------------------------------------------------------------------------

/** The Cockpit's own effect: a yes makes every listed proposal active. */
export const ACTIVATE_GOALS_EFFECT = "cockpit.activate-goals";

export interface GoalsAskCard {
  kind: "decision";
  question: string;
  why: string;
  options: string[];
  links: Array<{ label: string; href: string }>;
  steps: string[];
  effect: { key: string; params: { goalIds: string } };
}

const SHORT = (x: number): string => (Math.abs(x) >= 100 ? String(Math.round(x)) : String(Math.round(x * 100) / 100));

/** How a goal reads on a card or in a list: `Revenue (50000 ZAR per month)`. */
export function goalLine(g: Pick<GoalRow, "title" | "targetValue" | "direction" | "period" | "unit">): string {
  return `${g.title} (${g.direction === "lower" ? "at most " : ""}${SHORT(g.targetValue)}${g.unit ? ` ${g.unit}` : ""} per ${g.period})`;
}

/** The most goals one question lists (and so adopts): the owner reads every one of them; the rest are asked right after. */
export const GOALS_PER_QUESTION = 6;

/**
 * One question for the proposed goals, so the owner confirms the targets once
 * (not one question per goal). The first option is the yes the effect acts on,
 * and the effect adopts exactly the goals the question lists: never more than
 * the owner could read (at most `GOALS_PER_QUESTION`, fewer when the text would
 * not fit). Goals left over are asked about in the next question.
 */
export function goalsAskCard(goals: Array<Pick<GoalRow, "id" | "title" | "targetValue" | "direction" | "period" | "unit">>, options: { cockpitHref?: string } = {}): GoalsAskCard {
  const build = (n: number): string => {
    const left = goals.length - n;
    const rest = left > 0 ? ` ${left} more proposed ${left === 1 ? "goal is" : "goals are"} asked right after this one.` : "";
    return `Adopt ${n === 1 ? "this goal" : `these ${n} goals`}? ${goals.slice(0, n).map(goalLine).join("; ")}.${rest}`;
  };
  let shown = Math.min(goals.length, GOALS_PER_QUESTION);
  while (shown > 1 && build(shown).length > 600) shown -= 1;
  const listed = goals.slice(0, shown);
  return {
    kind: "decision",
    question: build(shown).slice(0, 600),
    why: "Goals give the weekly review something to compare the numbers with. Nothing is measured against a target until you confirm it.",
    options: [`Yes: adopt ${shown === 1 ? "it" : "all of them"} as written`, "No: I want changes (reply with what to change)"],
    links: [{ label: "Open the Cockpit", href: options.cockpitHref ?? "/cockpit" }],
    steps: [],
    effect: { key: ACTIVATE_GOALS_EFFECT, params: { goalIds: listed.map((g) => g.id).join(",") } },
  };
}
