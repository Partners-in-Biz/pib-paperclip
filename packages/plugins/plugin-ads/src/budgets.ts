/**
 * Monthly budget caps and pacing (pure). A cap belongs to a scope (PiB's own ads, or one client) and to a month.
 * The plugin never pauses a live campaign by itself: at the alert point (90% by default) it asks a person.
 *
 * Two projections are kept apart on purpose:
 * - run rate: what the last days actually cost, carried forward (what is likely);
 * - committed: the daily budgets of the active campaigns, carried forward (what the platform may spend at most).
 * A change is checked against the committed projection, because that is the money a person is agreeing to.
 */
import { addDays, daysInMonth, monthOf } from "./dates.js";
import { mean } from "./metrics.js";

export type PaceState = "no_cap" | "ok" | "watch" | "alert" | "over";

export const DEFAULT_ALERT_PCT = 90;

export interface PaceInput {
  capMinor: number | null;
  /** Month to date, in the scope's currency. */
  spentMinor: number;
  spentTodayMinor: number;
  /** `YYYY-MM-DD` in the company's timezone. */
  today: string;
  /** Spend of up to the last 7 complete days of this month, oldest first. */
  recentDaily: number[];
  /** Sum of the daily budgets of active campaigns, minor units. */
  committedDailyMinor: number;
  alertPct?: number;
}

export interface Pace {
  month: string;
  dayOfMonth: number;
  daysInMonth: number;
  /** Whole days after today. */
  daysLeft: number;
  capMinor: number | null;
  spentMinor: number;
  /** 0..1+, null without a cap */
  pctUsed: number | null;
  /** How much of the month has passed, 0..1 */
  expectedPct: number;
  runRateDailyMinor: number;
  projectedRunRateMinor: number;
  projectedCommittedMinor: number;
  /** cap - spent, null without a cap (negative once over) */
  headroomMinor: number | null;
  state: PaceState;
  onTrackToExceed: boolean;
}

export function monthPace(input: PaceInput): Pace {
  const month = monthOf(input.today);
  const total = daysInMonth(month);
  const dayOfMonth = Number(input.today.slice(8, 10));
  const daysLeft = Math.max(0, total - dayOfMonth);
  const runRate = input.recentDaily.length ? mean(input.recentDaily)! : input.spentMinor / Math.max(1, dayOfMonth);
  const restOfToday = (daily: number) => Math.max(0, daily - input.spentTodayMinor);
  const projectedRunRateMinor = Math.round(input.spentMinor + runRate * daysLeft + restOfToday(runRate));
  const projectedCommittedMinor = Math.round(input.spentMinor + input.committedDailyMinor * daysLeft + restOfToday(input.committedDailyMinor));
  const cap = input.capMinor !== null && input.capMinor > 0 ? input.capMinor : null;
  const pctUsed = cap === null ? null : input.spentMinor / cap;
  const expectedPct = dayOfMonth / total;
  const alertAt = (input.alertPct ?? DEFAULT_ALERT_PCT) / 100;
  const onTrackToExceed = cap !== null && projectedRunRateMinor > cap;
  let state: PaceState = "no_cap";
  if (cap !== null) {
    if (pctUsed! >= 1) state = "over";
    else if (pctUsed! >= alertAt) state = "alert";
    else if (onTrackToExceed || pctUsed! > expectedPct + 0.15) state = "watch";
    else state = "ok";
  }
  return {
    month,
    dayOfMonth,
    daysInMonth: total,
    daysLeft,
    capMinor: cap,
    spentMinor: input.spentMinor,
    pctUsed,
    expectedPct,
    runRateDailyMinor: Math.round(runRate),
    projectedRunRateMinor,
    projectedCommittedMinor,
    headroomMinor: cap === null ? null : cap - input.spentMinor,
    state,
    onTrackToExceed,
  };
}

/** A change that adds spend: a daily amount from `from` (default today) to `to` (default month end), and/or a one-off amount. */
export interface SpendAddition {
  dailyMinor?: number;
  /** First day the extra daily amount applies, `YYYY-MM-DD`. Default: tomorrow. */
  fromDay?: string | null;
  /** Last day it applies. Default: the end of the month. */
  toDay?: string | null;
  oneOffMinor?: number;
}

export type CapState = "no_cap" | "within" | "exceeds";

export interface CapImpact {
  state: CapState;
  capMinor: number | null;
  /** Committed month-end projection before and after the change. */
  projectedBeforeMinor: number;
  projectedAfterMinor: number;
  /** What the change adds to this month, minor units. */
  addedThisMonthMinor: number;
  /** cap - projectedAfter; negative when it goes over. Null without a cap. */
  headroomAfterMinor: number | null;
}

/** Days in the current month, after today, on which a daily amount applies. */
export function activeDaysThisMonth(today: string, addition: Pick<SpendAddition, "fromDay" | "toDay">): number {
  const month = monthOf(today);
  const last = `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
  const from = addition.fromDay && addition.fromDay > addDays(today, 1) ? addition.fromDay : addDays(today, 1);
  const to = addition.toDay && addition.toDay < last ? addition.toDay : last;
  if (from > to || monthOf(from) !== month) return 0;
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

export function capImpact(pace: Pace, today: string, addition: SpendAddition, spentTodayMinor = 0): CapImpact {
  const days = activeDaysThisMonth(today, addition);
  const daily = Math.max(0, addition.dailyMinor ?? 0);
  // The change may also start today: the rest of today counts when it applies from today (no fromDay, or today).
  const startsToday = !addition.fromDay || addition.fromDay <= today;
  const restOfToday = startsToday ? Math.max(0, daily - spentTodayMinor) : 0;
  const addedThisMonthMinor = Math.round(daily * days + restOfToday + Math.max(0, addition.oneOffMinor ?? 0));
  const projectedAfterMinor = pace.projectedCommittedMinor + addedThisMonthMinor;
  if (pace.capMinor === null) {
    return { state: "no_cap", capMinor: null, projectedBeforeMinor: pace.projectedCommittedMinor, projectedAfterMinor, addedThisMonthMinor, headroomAfterMinor: null };
  }
  return {
    state: projectedAfterMinor > pace.capMinor ? "exceeds" : "within",
    capMinor: pace.capMinor,
    projectedBeforeMinor: pace.projectedCommittedMinor,
    projectedAfterMinor,
    addedThisMonthMinor,
    headroomAfterMinor: pace.capMinor - projectedAfterMinor,
  };
}
