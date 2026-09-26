/**
 * Financial reports from per-account totals. SQL expands journal lines with
 * jsonb_array_elements and sums debit/credit per account; everything here is
 * pure so the arithmetic is tested without a database.
 */
import { isDebitNormal, type Account, type AccountSubtype } from "./chart.js";
import { addMonths, daysBetween, monthOf } from "./util.js";

export interface AccountTotals {
  accountId: string;
  debitMinor: number;
  creditMinor: number;
}

export interface ReportLine {
  accountId: string;
  code: string;
  name: string;
  subtype: AccountSubtype;
  amountMinor: number;
}

function index(accounts: Account[]): Map<string, Account> {
  return new Map(accounts.map((a) => [a.id, a]));
}

function netDebit(t: AccountTotals): number {
  return t.debitMinor - t.creditMinor;
}

function byCode(a: ReportLine, b: ReportLine): number {
  return a.code.localeCompare(b.code, undefined, { numeric: true });
}

// ---------------------------------------------------------------------------
// Trial balance
// ---------------------------------------------------------------------------

export interface TrialBalanceLine {
  accountId: string;
  code: string;
  name: string;
  type: string;
  debitMinor: number;
  creditMinor: number;
}

export interface TrialBalance {
  lines: TrialBalanceLine[];
  totalDebitMinor: number;
  totalCreditMinor: number;
  balanced: boolean;
}

export function trialBalance(accounts: Account[], totals: AccountTotals[]): TrialBalance {
  const acc = index(accounts);
  const lines: TrialBalanceLine[] = [];
  for (const t of totals) {
    const a = acc.get(t.accountId);
    const net = netDebit(t);
    if (net === 0) continue;
    lines.push({
      accountId: t.accountId,
      code: a?.code ?? "?",
      name: a?.name ?? "Unknown account",
      type: a?.type ?? "asset",
      debitMinor: net > 0 ? net : 0,
      creditMinor: net < 0 ? -net : 0,
    });
  }
  lines.sort((x, y) => x.code.localeCompare(y.code, undefined, { numeric: true }));
  const totalDebitMinor = lines.reduce((s, l) => s + l.debitMinor, 0);
  const totalCreditMinor = lines.reduce((s, l) => s + l.creditMinor, 0);
  return { lines, totalDebitMinor, totalCreditMinor, balanced: totalDebitMinor === totalCreditMinor };
}

// ---------------------------------------------------------------------------
// Profit and loss
// ---------------------------------------------------------------------------

export interface ProfitAndLoss {
  revenue: ReportLine[];
  costOfSales: ReportLine[];
  otherIncome: ReportLine[];
  expenses: ReportLine[];
  totalRevenueMinor: number;
  totalCostOfSalesMinor: number;
  grossProfitMinor: number;
  totalOtherIncomeMinor: number;
  totalExpensesMinor: number;
  netProfitMinor: number;
}

/** Income shows as positive (credit − debit); costs as positive (debit − credit). */
export function profitAndLoss(accounts: Account[], totals: AccountTotals[]): ProfitAndLoss {
  const acc = index(accounts);
  const revenue: ReportLine[] = [];
  const costOfSales: ReportLine[] = [];
  const otherIncome: ReportLine[] = [];
  const expenses: ReportLine[] = [];
  for (const t of totals) {
    const a = acc.get(t.accountId);
    if (!a || (a.type !== "income" && a.type !== "expense")) continue;
    const amount = a.type === "income" ? t.creditMinor - t.debitMinor : t.debitMinor - t.creditMinor;
    if (amount === 0) continue;
    const line: ReportLine = { accountId: a.id, code: a.code, name: a.name, subtype: a.subtype, amountMinor: amount };
    if (a.subtype === "revenue") revenue.push(line);
    else if (a.subtype === "other_income") otherIncome.push(line);
    else if (a.subtype === "cost_of_sales") costOfSales.push(line);
    else expenses.push(line);
  }
  const sum = (l: ReportLine[]) => l.reduce((s, x) => s + x.amountMinor, 0);
  const totalRevenueMinor = sum(revenue);
  const totalCostOfSalesMinor = sum(costOfSales);
  const totalOtherIncomeMinor = sum(otherIncome);
  const totalExpensesMinor = sum(expenses);
  const grossProfitMinor = totalRevenueMinor - totalCostOfSalesMinor;
  return {
    revenue: revenue.sort(byCode),
    costOfSales: costOfSales.sort(byCode),
    otherIncome: otherIncome.sort(byCode),
    expenses: expenses.sort(byCode),
    totalRevenueMinor,
    totalCostOfSalesMinor,
    grossProfitMinor,
    totalOtherIncomeMinor,
    totalExpensesMinor,
    netProfitMinor: grossProfitMinor + totalOtherIncomeMinor - totalExpensesMinor,
  };
}

/** Net profit straight from totals (credit − debit over income and expense accounts). */
export function netProfit(accounts: Account[], totals: AccountTotals[]): number {
  const acc = index(accounts);
  let n = 0;
  for (const t of totals) {
    const a = acc.get(t.accountId);
    if (a && (a.type === "income" || a.type === "expense")) n += t.creditMinor - t.debitMinor;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Balance sheet
// ---------------------------------------------------------------------------

export interface BalanceSheet {
  currentAssets: ReportLine[];
  nonCurrentAssets: ReportLine[];
  currentLiabilities: ReportLine[];
  nonCurrentLiabilities: ReportLine[];
  equity: ReportLine[];
  retainedEarningsMinor: number;
  currentYearEarningsMinor: number;
  totalAssetsMinor: number;
  totalLiabilitiesMinor: number;
  totalEquityMinor: number;
  balanced: boolean;
}

/**
 * `balances` = every account's totals up to the date; `currentYear` = totals
 * from the financial year start to the date. Profit before this financial
 * year is shown with retained earnings (no closing journals are needed).
 */
export function balanceSheet(accounts: Account[], balances: AccountTotals[], currentYear: AccountTotals[]): BalanceSheet {
  const acc = index(accounts);
  const currentAssets: ReportLine[] = [];
  const nonCurrentAssets: ReportLine[] = [];
  const currentLiabilities: ReportLine[] = [];
  const nonCurrentLiabilities: ReportLine[] = [];
  const equity: ReportLine[] = [];
  for (const t of balances) {
    const a = acc.get(t.accountId);
    if (!a || a.type === "income" || a.type === "expense") continue;
    const amount = isDebitNormal(a.type) ? t.debitMinor - t.creditMinor : t.creditMinor - t.debitMinor;
    if (amount === 0) continue;
    const line: ReportLine = { accountId: a.id, code: a.code, name: a.name, subtype: a.subtype, amountMinor: amount };
    if (a.type === "asset") (a.subtype === "fixed_asset" || a.subtype === "accumulated_depreciation" ? nonCurrentAssets : currentAssets).push(line);
    else if (a.type === "liability") (a.subtype === "non_current_liability" ? nonCurrentLiabilities : currentLiabilities).push(line);
    else equity.push(line);
  }
  const allProfit = netProfit(accounts, balances);
  const currentYearEarningsMinor = netProfit(accounts, currentYear);
  const retainedEarningsMinor = allProfit - currentYearEarningsMinor;
  const sum = (l: ReportLine[]) => l.reduce((s, x) => s + x.amountMinor, 0);
  const totalAssetsMinor = sum(currentAssets) + sum(nonCurrentAssets);
  const totalLiabilitiesMinor = sum(currentLiabilities) + sum(nonCurrentLiabilities);
  const totalEquityMinor = sum(equity) + retainedEarningsMinor + currentYearEarningsMinor;
  return {
    currentAssets: currentAssets.sort(byCode),
    nonCurrentAssets: nonCurrentAssets.sort(byCode),
    currentLiabilities: currentLiabilities.sort(byCode),
    nonCurrentLiabilities: nonCurrentLiabilities.sort(byCode),
    equity: equity.sort(byCode),
    retainedEarningsMinor,
    currentYearEarningsMinor,
    totalAssetsMinor,
    totalLiabilitiesMinor,
    totalEquityMinor,
    balanced: totalAssetsMinor === totalLiabilitiesMinor + totalEquityMinor,
  };
}

// ---------------------------------------------------------------------------
// Cash flow (indirect method)
// ---------------------------------------------------------------------------

export interface CashFlowStatement {
  netProfitMinor: number;
  operating: ReportLine[];
  investing: ReportLine[];
  financing: ReportLine[];
  other: ReportLine[];
  operatingTotalMinor: number;
  investingTotalMinor: number;
  financingTotalMinor: number;
  otherTotalMinor: number;
  netChangeMinor: number;
  openingCashMinor: number;
  closingCashMinor: number;
  /** Net change must equal the movement on the cash accounts. */
  reconciles: boolean;
}

/**
 * Net profit, then every non-cash balance-sheet account's movement turned
 * into its cash effect (−(debit − credit)), grouped by the account's cash-flow
 * class. By double entry the total equals the change in cash.
 */
export function cashFlow(accounts: Account[], movements: AccountTotals[], openingCashMinor: number): CashFlowStatement {
  const acc = index(accounts);
  const groups: Record<"operating" | "investing" | "financing" | "other", ReportLine[]> = { operating: [], investing: [], financing: [], other: [] };
  let cashMovement = 0;
  for (const t of movements) {
    const a = acc.get(t.accountId);
    if (!a || a.type === "income" || a.type === "expense") continue;
    if (a.cashFlow === "cash") {
      cashMovement += netDebit(t);
      continue;
    }
    const effect = -netDebit(t);
    if (effect === 0) continue;
    const line: ReportLine = { accountId: a.id, code: a.code, name: a.name, subtype: a.subtype, amountMinor: effect };
    const bucket = a.cashFlow === "none" ? "other" : a.cashFlow;
    groups[bucket].push(line);
  }
  const np = netProfit(accounts, movements);
  const sum = (l: ReportLine[]) => l.reduce((s, x) => s + x.amountMinor, 0);
  const operatingTotalMinor = np + sum(groups.operating);
  const investingTotalMinor = sum(groups.investing);
  const financingTotalMinor = sum(groups.financing);
  const otherTotalMinor = sum(groups.other);
  const netChangeMinor = operatingTotalMinor + investingTotalMinor + financingTotalMinor + otherTotalMinor;
  return {
    netProfitMinor: np,
    operating: groups.operating.sort(byCode),
    investing: groups.investing.sort(byCode),
    financing: groups.financing.sort(byCode),
    other: groups.other.sort(byCode),
    operatingTotalMinor,
    investingTotalMinor,
    financingTotalMinor,
    otherTotalMinor,
    netChangeMinor,
    openingCashMinor,
    closingCashMinor: openingCashMinor + cashMovement,
    reconciles: netChangeMinor === cashMovement,
  };
}

// ---------------------------------------------------------------------------
// General ledger detail
// ---------------------------------------------------------------------------

export interface GlEntry {
  journalId: string;
  number: string;
  date: string;
  memo: string;
  lineMemo: string | null;
  debitMinor: number;
  creditMinor: number;
}

export interface GlRow extends GlEntry {
  balanceMinor: number;
}

/** Running balance in the account's normal direction (debit accounts: debit − credit). */
export function generalLedger(account: Account, openingMinor: number, entries: GlEntry[]): { openingMinor: number; rows: GlRow[]; closingMinor: number } {
  const debitNormal = isDebitNormal(account.type);
  let balance = openingMinor;
  const rows = entries.map((e) => {
    balance += debitNormal ? e.debitMinor - e.creditMinor : e.creditMinor - e.debitMinor;
    return { ...e, balanceMinor: balance };
  });
  return { openingMinor, rows, closingMinor: balance };
}

// ---------------------------------------------------------------------------
// Comparisons and budgets
// ---------------------------------------------------------------------------

export interface ComparisonRow {
  accountId: string;
  code: string;
  name: string;
  section: "revenue" | "cost_of_sales" | "other_income" | "expenses";
  values: number[];
}

/** P&L for several ranges side by side (e.g. this period, previous, same period last year). */
export function compareProfitAndLoss(accounts: Account[], ranges: AccountTotals[][]): { rows: ComparisonRow[]; netProfit: number[] } {
  const reports = ranges.map((r) => profitAndLoss(accounts, r));
  const rows = new Map<string, ComparisonRow>();
  reports.forEach((report, i) => {
    const sections: Array<[ComparisonRow["section"], ReportLine[]]> = [
      ["revenue", report.revenue],
      ["cost_of_sales", report.costOfSales],
      ["other_income", report.otherIncome],
      ["expenses", report.expenses],
    ];
    for (const [section, lines] of sections) {
      for (const line of lines) {
        const row = rows.get(line.accountId) ?? { accountId: line.accountId, code: line.code, name: line.name, section, values: ranges.map(() => 0) };
        row.values[i] = line.amountMinor;
        rows.set(line.accountId, row);
      }
    }
  });
  const order = ["revenue", "cost_of_sales", "other_income", "expenses"];
  return {
    rows: [...rows.values()].sort((a, b) => order.indexOf(a.section) - order.indexOf(b.section) || a.code.localeCompare(b.code, undefined, { numeric: true })),
    netProfit: reports.map((r) => r.netProfitMinor),
  };
}

export interface BudgetRow {
  accountCode: string;
  name: string;
  budgetMinor: number;
  actualMinor: number;
  varianceMinor: number;
}

/**
 * Budget vs actual over a range. Budgets are per account per month; actuals
 * use the P&L sign (income positive, costs positive).
 */
export function budgetVsActual(
  accounts: Account[],
  budgets: Array<{ accountCode: string; month: string; amountMinor: number }>,
  actual: AccountTotals[],
  months: string[],
): { rows: BudgetRow[]; totals: { budgetMinor: number; actualMinor: number; varianceMinor: number } } {
  const byCodeMap = new Map(accounts.map((a) => [a.code, a]));
  const byId = index(accounts);
  const rows = new Map<string, BudgetRow>();
  const monthSet = new Set(months);
  for (const b of budgets) {
    if (!monthSet.has(b.month)) continue;
    const a = byCodeMap.get(b.accountCode);
    const row = rows.get(b.accountCode) ?? { accountCode: b.accountCode, name: a?.name ?? b.accountCode, budgetMinor: 0, actualMinor: 0, varianceMinor: 0 };
    row.budgetMinor += b.amountMinor;
    rows.set(b.accountCode, row);
  }
  for (const t of actual) {
    const a = byId.get(t.accountId);
    if (!a || (a.type !== "income" && a.type !== "expense")) continue;
    const amount = a.type === "income" ? t.creditMinor - t.debitMinor : t.debitMinor - t.creditMinor;
    const row = rows.get(a.code) ?? { accountCode: a.code, name: a.name, budgetMinor: 0, actualMinor: 0, varianceMinor: 0 };
    row.actualMinor += amount;
    rows.set(a.code, row);
  }
  const list = [...rows.values()].map((r) => {
    const a = byCodeMap.get(r.accountCode);
    // Positive variance = better than budget (more income, or less cost).
    const variance = a?.type === "income" ? r.actualMinor - r.budgetMinor : r.budgetMinor - r.actualMinor;
    return { ...r, varianceMinor: variance };
  });
  list.sort((a, b) => a.accountCode.localeCompare(b.accountCode, undefined, { numeric: true }));
  const totals = list.reduce(
    (s, r) => ({ budgetMinor: s.budgetMinor + r.budgetMinor, actualMinor: s.actualMinor + r.actualMinor, varianceMinor: s.varianceMinor + r.varianceMinor }),
    { budgetMinor: 0, actualMinor: 0, varianceMinor: 0 },
  );
  return { rows: list, totals };
}

// ---------------------------------------------------------------------------
// Aged receivables / payables
// ---------------------------------------------------------------------------

export const AGE_BUCKETS = ["current", "1_30", "31_60", "61_90", "over_90"] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number];

export interface AgedItem {
  key: string;
  number: string;
  counterpartyName: string;
  outstandingMinor: number;
  dueDate: string | null;
  issueDate: string | null;
  currency: string;
}

export function ageBucket(item: Pick<AgedItem, "dueDate" | "issueDate">, asOf: string): AgeBucket {
  const ref = item.dueDate ?? item.issueDate;
  if (!ref) return "current";
  const days = daysBetween(ref, asOf);
  if (days <= 0) return "current";
  if (days <= 30) return "1_30";
  if (days <= 60) return "31_60";
  if (days <= 90) return "61_90";
  return "over_90";
}

export interface AgedRow {
  counterpartyName: string;
  buckets: Record<AgeBucket, number>;
  totalMinor: number;
  items: Array<AgedItem & { bucket: AgeBucket; daysOverdue: number }>;
}

export function agedReport(items: AgedItem[], asOf: string): { rows: AgedRow[]; totals: Record<AgeBucket, number> & { total: number } } {
  const rows = new Map<string, AgedRow>();
  const totals = { current: 0, "1_30": 0, "31_60": 0, "61_90": 0, over_90: 0, total: 0 };
  for (const item of items) {
    if (item.outstandingMinor === 0) continue;
    const bucket = ageBucket(item, asOf);
    const ref = item.dueDate ?? item.issueDate;
    const name = item.counterpartyName || "Unknown";
    const row = rows.get(name) ?? { counterpartyName: name, buckets: { current: 0, "1_30": 0, "31_60": 0, "61_90": 0, over_90: 0 }, totalMinor: 0, items: [] };
    row.buckets[bucket] += item.outstandingMinor;
    row.totalMinor += item.outstandingMinor;
    row.items.push({ ...item, bucket, daysOverdue: ref ? Math.max(0, daysBetween(ref, asOf)) : 0 });
    rows.set(name, row);
    totals[bucket] += item.outstandingMinor;
    totals.total += item.outstandingMinor;
  }
  return { rows: [...rows.values()].sort((a, b) => b.totalMinor - a.totalMinor), totals };
}

// ---------------------------------------------------------------------------
// Cash-flow forecast
// ---------------------------------------------------------------------------

export interface ForecastInput {
  asOf: string;
  months: number;
  openingCashMinor: number;
  receivables: AgedItem[];
  payables: AgedItem[];
  /** Average monthly cash costs (salaries and operating expenses, no depreciation). */
  recurringCostsMinor: number;
  manual: Array<{ month: string; description: string; amountMinor: number; repeat: "none" | "monthly"; untilMonth: string | null }>;
}

export interface ForecastMonth {
  month: string;
  openingMinor: number;
  receiptsMinor: number;
  paymentsMinor: number;
  recurringMinor: number;
  manualMinor: number;
  closingMinor: number;
  manualLines: Array<{ description: string; amountMinor: number }>;
}

/**
 * Month-by-month cash: open receivables and payables by due month (overdue
 * ones in the first month), recurring costs as an estimate (less what is
 * already in payables that month), plus manual lines.
 */
export function cashForecast(input: ForecastInput): ForecastMonth[] {
  const first = monthOf(input.asOf);
  const months = Array.from({ length: Math.max(1, Math.min(input.months, 24)) }, (_, i) => addMonths(first, i));
  const bucket = (item: AgedItem) => {
    const due = item.dueDate ?? item.issueDate ?? input.asOf;
    const m = monthOf(due);
    return m < first ? first : m;
  };
  let opening = input.openingCashMinor;
  return months.map((month) => {
    const receipts = input.receivables.filter((i) => bucket(i) === month).reduce((s, i) => s + i.outstandingMinor, 0);
    const payments = input.payables.filter((i) => bucket(i) === month).reduce((s, i) => s + i.outstandingMinor, 0);
    const recurring = Math.max(0, input.recurringCostsMinor - payments);
    const manualLines = input.manual
      .filter((l) => (l.repeat === "monthly" ? l.month <= month && (!l.untilMonth || month <= l.untilMonth) : l.month === month))
      .map((l) => ({ description: l.description, amountMinor: l.amountMinor }));
    const manual = manualLines.reduce((s, l) => s + l.amountMinor, 0);
    const closing = opening + receipts - payments - recurring + manual;
    const row = { month, openingMinor: opening, receiptsMinor: receipts, paymentsMinor: payments, recurringMinor: recurring, manualMinor: manual, closingMinor: closing, manualLines };
    opening = closing;
    return row;
  });
}
