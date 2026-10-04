/** A scope's month, read from the rollups: the inputs of the pacing maths in one place. */
import { capFor, scopeMonthFacts, type ScopeRow } from "./db.js";
import { monthPace, type Pace } from "./budgets.js";
import { monthOf, monthStart, todayIn } from "./dates.js";
import type { AdsRuntime } from "./runtime.js";

export interface ScopePace {
  today: string;
  month: string;
  currency: string;
  pace: Pace;
  committedDailyMinor: number;
  spentTodayMinor: number;
  /** Accounts of the scope in another currency than the scope's: left out of the totals. */
  mismatchedAccounts: number;
}

export async function scopePace(rt: AdsRuntime, scope: ScopeRow, onDay?: string): Promise<ScopePace> {
  const today = onDay ?? todayIn(rt.config.timezone, rt.now());
  const month = monthOf(today);
  const cap = await capFor(rt.ctx, rt.companyId, scope, month);
  const facts = await scopeMonthFacts(rt.ctx, rt.companyId, scope.scope_key, scope.currency, monthStart(month), today);
  const pace = monthPace({
    capMinor: cap,
    spentMinor: facts.spentMinor,
    spentTodayMinor: facts.spentTodayMinor,
    today,
    recentDaily: facts.recentDaily,
    committedDailyMinor: facts.committedDailyMinor,
    alertPct: scope.alert_pct,
  });
  return { today, month, currency: scope.currency, pace, committedDailyMinor: facts.committedDailyMinor, spentTodayMinor: facts.spentTodayMinor, mismatchedAccounts: facts.mismatchedAccounts };
}
