/**
 * Reports, all computed from journals (SQL sums per account; the arithmetic
 * lives in domain/reports.ts).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import * as db from "../db.js";
import type { Account } from "../domain/chart.js";
import { financialYear, monthRange, previousRange, sameRangeLastYear, type DateRange } from "../domain/periods.js";
import {
  agedReport,
  balanceSheet,
  budgetVsActual,
  cashFlow,
  cashForecast,
  compareProfitAndLoss,
  generalLedger,
  netProfit,
  profitAndLoss,
  trialBalance,
  type AccountTotals,
  type AgedItem,
} from "../domain/reports.js";
import { AccountingError, addDays, addMonths, firstDayOfMonth, lastDayOfMonth, monthOf, monthsBetween, requireDate, todayIso } from "../domain/util.js";
import { ensureBook, loadChart, roleAccount } from "./books.js";
import { BOOK_CURRENCY, readSettings } from "./common.js";

export const REPORT_KINDS = ["trial_balance", "profit_and_loss", "balance_sheet", "cash_flow", "general_ledger", "comparison", "budget_vs_actual", "forecast", "aged_receivables", "aged_payables"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

function range(input: { from?: unknown; to?: unknown }, fallback: DateRange): DateRange {
  const start = input.from ? requireDate(input.from, "from") : fallback.start;
  const end = input.to ? requireDate(input.to, "to") : fallback.end;
  if (end < start) throw new AccountingError("The end date is before the start date");
  return { start, end };
}

function cashIds(accounts: Account[]): Set<string> {
  return new Set(accounts.filter((a) => a.cashFlow === "cash").map((a) => a.id));
}

function sumBalance(totals: AccountTotals[], ids: Set<string>): number {
  return totals.filter((t) => ids.has(t.accountId)).reduce((s, t) => s + t.debitMinor - t.creditMinor, 0);
}

function agedItems(items: db.OpenItemRow[]): AgedItem[] {
  return items.map((i) => ({ key: i.key, number: i.number, counterpartyName: i.counterpartyName, outstandingMinor: i.outstandingMinor, dueDate: i.dueDate, issueDate: i.issueDate, currency: i.currency }));
}

export async function runReport(ctx: PluginContext, companyId: string, kindInput: unknown, input: Record<string, unknown> = {}) {
  await ensureBook(ctx, companyId);
  const kind = String(kindInput) as ReportKind;
  if (!(REPORT_KINDS as readonly string[]).includes(kind)) throw new AccountingError(`Unknown report ${String(kindInput)}. Use ${REPORT_KINDS.join(", ")}.`);
  const settings = await readSettings(ctx, companyId);
  const chart = await loadChart(ctx, companyId);
  const today = todayIso();
  const asOf = input.asOf ? requireDate(input.asOf, "asOf") : input.to ? requireDate(input.to, "to") : today;
  const fy = financialYear(asOf, settings.yearEndMonth);

  switch (kind) {
    case "trial_balance": {
      const totals = await db.accountTotals(ctx.db, companyId, { to: asOf });
      return { kind, asOf, ...trialBalance(chart.accounts, totals) };
    }
    case "profit_and_loss": {
      const r = range(input, { start: fy.start, end: asOf });
      const totals = await db.accountTotals(ctx.db, companyId, { from: r.start, to: r.end });
      return { kind, from: r.start, to: r.end, ...profitAndLoss(chart.accounts, totals) };
    }
    case "balance_sheet": {
      const [balances, currentYear] = await Promise.all([
        db.accountTotals(ctx.db, companyId, { to: asOf }),
        db.accountTotals(ctx.db, companyId, { from: fy.start, to: asOf }),
      ]);
      return { kind, asOf, financialYearStart: fy.start, ...balanceSheet(chart.accounts, balances, currentYear) };
    }
    case "cash_flow": {
      const r = range(input, { start: fy.start, end: asOf });
      const [movements, before] = await Promise.all([
        db.accountTotals(ctx.db, companyId, { from: r.start, to: r.end }),
        db.accountTotals(ctx.db, companyId, { to: addDays(r.start, -1) }),
      ]);
      return { kind, from: r.start, to: r.end, ...cashFlow(chart.accounts, movements, sumBalance(before, cashIds(chart.accounts))) };
    }
    case "general_ledger": {
      const code = typeof input.accountCode === "string" ? input.accountCode : null;
      const account = code ? chart.byCode.get(code) : typeof input.accountId === "string" ? chart.byId.get(input.accountId) : null;
      if (!account) throw new AccountingError("Choose an account for the general ledger");
      const r = range(input, { start: fy.start, end: asOf });
      const [before, entries] = await Promise.all([
        db.accountTotals(ctx.db, companyId, { to: addDays(r.start, -1) }),
        db.glEntries(ctx.db, companyId, account.id, r.start, r.end),
      ]);
      const t = before.find((x) => x.accountId === account.id);
      const debitNormal = account.type === "asset" || account.type === "expense";
      const opening = t ? (debitNormal ? t.debitMinor - t.creditMinor : t.creditMinor - t.debitMinor) : 0;
      return { kind, from: r.start, to: r.end, account: { id: account.id, code: account.code, name: account.name, type: account.type }, ...generalLedger(account, opening, entries) };
    }
    case "comparison": {
      const month = typeof input.month === "string" && /^\d{4}-\d{2}$/.test(input.month) ? input.month : monthOf(asOf);
      const base = input.from || input.to ? range(input, monthRange(month)) : monthRange(month);
      const ranges = [base, previousRange(base), sameRangeLastYear(base)];
      const totals = await Promise.all(ranges.map((r) => db.accountTotals(ctx.db, companyId, { from: r.start, to: r.end })));
      return { kind, ranges, labels: ["This period", "Previous period", "Same period last year"], ...compareProfitAndLoss(chart.accounts, totals) };
    }
    case "budget_vs_actual": {
      const r = range(input, { start: fy.start, end: lastDayOfMonth(monthOf(asOf)) });
      const months = monthsBetween(monthOf(r.start), monthOf(r.end));
      const [budgets, actual] = await Promise.all([
        db.listBudgets(ctx.db, companyId, months[0]!, months[months.length - 1]!),
        db.accountTotals(ctx.db, companyId, { from: firstDayOfMonth(months[0]!), to: lastDayOfMonth(months[months.length - 1]!) }),
      ]);
      return { kind, from: r.start, to: r.end, months, ...budgetVsActual(chart.accounts, budgets, actual, months) };
    }
    case "forecast":
      return { kind, ...(await forecast(ctx, companyId, Number(input.months ?? 3), asOf)) };
    case "aged_receivables":
    case "aged_payables": {
      const items = await db.listOpenItems(ctx.db, companyId, { kind: kind === "aged_receivables" ? "receivable" : "payable" });
      return { kind, asOf, ...agedReport(agedItems(items), asOf) };
    }
  }
}

/** Open AR/AP by due month, recurring costs (3-month average) and manual lines. */
export async function forecast(ctx: PluginContext, companyId: string, months: number, asOf = todayIso()) {
  const chart = await loadChart(ctx, companyId);
  const [balances, receivables, payables, manual] = await Promise.all([
    db.accountTotals(ctx.db, companyId, { to: asOf }),
    db.listOpenItems(ctx.db, companyId, { kind: "receivable", currency: BOOK_CURRENCY }),
    db.listOpenItems(ctx.db, companyId, { kind: "payable", currency: BOOK_CURRENCY }),
    db.listForecastLines(ctx.db, companyId),
  ]);
  const lastFull = addMonths(monthOf(asOf), -1);
  const fromMonth = addMonths(lastFull, -2);
  const recent = await db.accountTotals(ctx.db, companyId, { from: firstDayOfMonth(fromMonth), to: lastDayOfMonth(lastFull) });
  const costIds = new Set(chart.accounts.filter((a) => a.type === "expense" && a.subtype !== "depreciation").map((a) => a.id));
  const costs = recent.filter((t) => costIds.has(t.accountId)).reduce((s, t) => s + t.debitMinor - t.creditMinor, 0);
  const recurringCostsMinor = Math.max(0, Math.round(costs / 3));
  const rows = cashForecast({
    asOf,
    months,
    openingCashMinor: sumBalance(balances, cashIds(chart.accounts)),
    receivables: agedItems(receivables),
    payables: agedItems(payables),
    recurringCostsMinor,
    manual: manual.map((m) => ({ month: m.month, description: m.description, amountMinor: m.amountMinor, repeat: m.repeat, untilMonth: m.untilMonth })),
  });
  return { asOf, recurringCostsMinor, basedOn: { from: fromMonth, to: lastFull }, rows, manualLines: manual };
}

/** Overview numbers for the first tab. */
export async function overview(ctx: PluginContext, companyId: string) {
  await ensureBook(ctx, companyId);
  const chart = await loadChart(ctx, companyId);
  const today = todayIso();
  const month = monthRange(monthOf(today));
  const [balances, monthTotals, lineCounts, rejections, drafts] = await Promise.all([
    db.accountTotals(ctx.db, companyId, { to: today }),
    db.accountTotals(ctx.db, companyId, { from: month.start, to: month.end }),
    db.lineCounts(ctx.db, companyId),
    db.listRejections(ctx.db, companyId, "open"),
    db.listDrafts(ctx.db, companyId, ["pending_approval"]),
  ]);
  const balanceOf = (role: string, sign: 1 | -1) => {
    const account = roleAccount(chart, role);
    const t = account ? balances.find((x) => x.accountId === account.id) : null;
    return t ? sign * (t.debitMinor - t.creditMinor) : 0;
  };
  const vatIds = new Set(chart.accounts.filter((a) => a.subtype === "vat_output" || a.subtype === "vat_input" || a.subtype === "vat_control").map((a) => a.id));
  const vatDue = -balances.filter((t) => vatIds.has(t.accountId)).reduce((s, t) => s + t.debitMinor - t.creditMinor, 0);
  const pnl = profitAndLoss(chart.accounts, monthTotals);
  return {
    cashMinor: sumBalance(balances, cashIds(chart.accounts)),
    receivablesMinor: balanceOf("ar", 1),
    payablesMinor: balanceOf("ap", -1),
    vatDueMinor: vatDue,
    month: monthOf(today),
    monthRevenueMinor: pnl.totalRevenueMinor + pnl.totalOtherIncomeMinor,
    monthExpensesMinor: pnl.totalCostOfSalesMinor + pnl.totalExpensesMinor,
    monthProfitMinor: netProfit(chart.accounts, monthTotals),
    bankLines: lineCounts,
    rejectedPostings: rejections.length,
    pendingApprovals: drafts.length,
  };
}
