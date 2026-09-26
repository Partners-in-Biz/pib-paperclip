/**
 * Series for the Overview charts (pure). Everything comes from journals and
 * bank lines; amounts stay in minor units of the book currency.
 */
import type { Account } from "./chart.js";
import type { AccountTotals } from "./reports.js";

export interface TrendMonth {
  month: string;
  incomeMinor: number;
  expensesMinor: number;
  profitMinor: number;
  /** Cash and bank balance at the end of the month. */
  closingCashMinor: number;
}

/**
 * Income, expenses (cost of sales included), profit and closing cash per
 * month. `opening` is every account's total before the first month;
 * `monthly` the per-month movements. Months with no journals still appear.
 */
export function monthlyTrend(accounts: Account[], opening: AccountTotals[], monthly: Array<AccountTotals & { month: string }>, months: string[]): TrendMonth[] {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const cash = (t: AccountTotals) => (byId.get(t.accountId)?.cashFlow === "cash" ? t.debitMinor - t.creditMinor : 0);
  let running = opening.reduce((s, t) => s + cash(t), 0);
  return months.map((month) => {
    let incomeMinor = 0;
    let expensesMinor = 0;
    for (const t of monthly) {
      if (t.month !== month) continue;
      const a = byId.get(t.accountId);
      if (!a) continue;
      if (a.type === "income") incomeMinor += t.creditMinor - t.debitMinor;
      else if (a.type === "expense") expensesMinor += t.debitMinor - t.creditMinor;
      running += cash(t);
    }
    return { month, incomeMinor, expensesMinor, profitMinor: incomeMinor - expensesMinor, closingCashMinor: running };
  });
}

export interface ExpenseSlice {
  label: string;
  code: string | null;
  amountMinor: number;
}

/** The largest expense accounts over a range, the rest grouped as "Other". Refunds (negative) are left out. */
export function expenseSplit(accounts: Account[], totals: AccountTotals[], top = 5): ExpenseSlice[] {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const rows: ExpenseSlice[] = [];
  for (const t of totals) {
    const a = byId.get(t.accountId);
    if (!a || a.type !== "expense") continue;
    const amountMinor = t.debitMinor - t.creditMinor;
    if (amountMinor > 0) rows.push({ label: a.name, code: a.code, amountMinor });
  }
  rows.sort((x, y) => y.amountMinor - x.amountMinor || (x.code ?? "").localeCompare(y.code ?? ""));
  if (rows.length <= top) return rows;
  const rest = rows.slice(top).reduce((s, r) => s + r.amountMinor, 0);
  return [...rows.slice(0, top), { label: "Other", code: null, amountMinor: rest }];
}

/**
 * VAT201 due date for a period: the last business day (Mon–Fri) of the month
 * after the period ends (SARS eFiling). Public holidays are not taken off.
 */
export function vatDueDate(periodEnd: string): string {
  const [y, m] = periodEnd.split("-").map(Number) as [number, number];
  // Day 0 of the month two ahead = last day of the next month.
  const d = new Date(Date.UTC(y, m + 1, 0));
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export interface Reconciliation {
  bankAccountId: string;
  reconciled: number;
  excluded: number;
  open: number;
  total: number;
}

/** Bank lines per account: done (reconciled or excluded) against open (unreconciled or matching). */
export function reconciliationByAccount(rows: Array<{ bankAccountId: string; status: string; count: number }>): Reconciliation[] {
  const map = new Map<string, Reconciliation>();
  for (const row of rows) {
    const r = map.get(row.bankAccountId) ?? { bankAccountId: row.bankAccountId, reconciled: 0, excluded: 0, open: 0, total: 0 };
    if (row.status === "reconciled") r.reconciled += row.count;
    else if (row.status === "excluded") r.excluded += row.count;
    else r.open += row.count;
    r.total += row.count;
    map.set(row.bankAccountId, r);
  }
  return [...map.values()];
}
