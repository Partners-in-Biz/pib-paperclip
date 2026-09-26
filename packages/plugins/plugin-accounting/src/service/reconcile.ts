/**
 * Bank reconciliation per bank account and statement period:
 * prepare (balances and blockers) → approval issue → a person approves →
 * the period's lines are locked to the reconciliation.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createWorkIssue } from "@partnersinbiz/pib-plugin-kit";
import * as db from "../db.js";
import { reconciliationSummary, type ReconciliationSummary } from "../domain/reconcile.js";
import { AccountingError, addDays, formatRand, requireDate } from "../domain/util.js";
import { loadChart } from "./books.js";
import { actorRecord, closeIssue, commentOn, newId, ORIGIN, requireUser, type Actor } from "./common.js";

export interface PreparedReconciliation {
  reconciliation: db.ReconciliationRow;
  summary: ReconciliationSummary;
  bank: db.BankAccountRow;
}

async function glBalance(ctx: PluginContext, companyId: string, accountCode: string, asOf: string): Promise<number> {
  const chart = await loadChart(ctx, companyId);
  const account = chart.byCode.get(accountCode);
  if (!account) return 0;
  const totals = await db.accountTotals(ctx.db, companyId, { to: asOf });
  const t = totals.find((x) => x.accountId === account.id);
  return t ? t.debitMinor - t.creditMinor : 0;
}

/** Opening/closing defaults: the previous reconciliation's closing, then the statement's own balances. */
async function defaultBalances(ctx: PluginContext, companyId: string, bankAccountId: string, start: string, end: string): Promise<{ opening: number | null; closing: number | null }> {
  const recs = await db.listReconciliations(ctx.db, companyId, bankAccountId);
  const prior = recs.filter((r) => r.periodEnd < start).sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
  const statements = await db.listStatements(ctx.db, companyId, bankAccountId);
  const opening = prior?.closingMinor ?? statements.find((s) => s.periodStart === start && s.openingMinor != null)?.openingMinor ?? null;
  const closing = statements.find((s) => s.periodEnd === end && s.closingMinor != null)?.closingMinor ?? null;
  if (closing != null && opening != null) return { opening, closing };
  // Fall back to the running balance column on the lines themselves.
  const lines = await db.listBankLines(ctx.db, companyId, { bankAccountId, from: addDays(start, -40), to: end, limit: 5000 });
  const withBalance = lines.filter((l) => l.balanceMinor != null).sort((a, b) => a.date.localeCompare(b.date));
  const last = withBalance.filter((l) => l.date <= end).pop();
  const firstIn = withBalance.find((l) => l.date >= start);
  return {
    opening: opening ?? (firstIn ? firstIn.balanceMinor! - firstIn.amountMinor : null),
    closing: closing ?? (last ? last.balanceMinor! : null),
  };
}

export async function prepareReconciliation(
  ctx: PluginContext,
  companyId: string,
  actor: Actor,
  input: { bankAccountId?: unknown; periodStart?: unknown; periodEnd?: unknown; openingMinor?: unknown; closingMinor?: unknown },
): Promise<PreparedReconciliation> {
  const bank = typeof input.bankAccountId === "string" ? await db.getBankAccount(ctx.db, companyId, input.bankAccountId) : null;
  if (!bank) throw new AccountingError("Bank account not found", "not_found");
  const start = requireDate(input.periodStart, "periodStart");
  const end = requireDate(input.periodEnd, "periodEnd");
  if (end < start) throw new AccountingError("The period ends before it starts");
  const existing = await db.reconciliationByPeriod(ctx.db, companyId, bank.id, start, end);
  if (existing && existing.status !== "draft") throw new AccountingError(`This period is already ${existing.status === "locked" ? "locked" : "waiting for approval"}`, "conflict");
  if (await db.lockedReconciliationOverlaps(ctx.db, companyId, bank.id, start, end)) throw new AccountingError("This period overlaps a locked reconciliation", "conflict");
  const defaults = await defaultBalances(ctx, companyId, bank.id, start, end);
  const opening = input.openingMinor == null || input.openingMinor === "" ? defaults.opening : Number(input.openingMinor);
  const closing = input.closingMinor == null || input.closingMinor === "" ? defaults.closing : Number(input.closingMinor);
  if (opening == null || !Number.isSafeInteger(opening)) throw new AccountingError("Enter the statement's opening balance (in cents)");
  if (closing == null || !Number.isSafeInteger(closing)) throw new AccountingError("Enter the statement's closing balance (in cents)");
  const lines = await db.listBankLines(ctx.db, companyId, { bankAccountId: bank.id, from: start, to: end, limit: 5000 });
  const summary = reconciliationSummary({ openingMinor: opening, closingMinor: closing, lines, glBalanceMinor: await glBalance(ctx, companyId, bank.accountCode, end) });
  await db.upsertReconciliation(
    ctx.db,
    companyId,
    {
      id: existing?.id ?? newId(),
      bankAccountId: bank.id,
      periodStart: start,
      periodEnd: end,
      openingMinor: opening,
      closingMinor: closing,
      linesTotalMinor: summary.linesTotalMinor,
      differenceMinor: summary.differenceMinor,
      unreconciledCount: summary.unreconciledCount,
      glBalanceMinor: summary.glBalanceMinor,
    },
    actorRecord(actor),
  );
  const reconciliation = (await db.reconciliationByPeriod(ctx.db, companyId, bank.id, start, end))!;
  return { reconciliation, summary, bank };
}

export async function requestReconciliationApproval(ctx: PluginContext, companyId: string, actor: Actor, id: string): Promise<db.ReconciliationRow> {
  const rec = await db.getReconciliation(ctx.db, companyId, id);
  if (!rec) throw new AccountingError("Reconciliation not found", "not_found");
  if (rec.status !== "draft") throw new AccountingError("Approval was already requested", "conflict");
  const { summary, bank } = await prepareReconciliation(ctx, companyId, actor, {
    bankAccountId: rec.bankAccountId,
    periodStart: rec.periodStart,
    periodEnd: rec.periodEnd,
    openingMinor: rec.openingMinor,
    closingMinor: rec.closingMinor,
  });
  if (!summary.ready) throw new AccountingError(summary.blockers.join(" "), "conflict");
  const issue = await createWorkIssue(ctx, {
    companyId,
    title: `Approve bank reconciliation: ${bank.name} ${rec.periodStart} to ${rec.periodEnd}`,
    description: [
      `| | |`,
      `|---|---:|`,
      `| Opening balance | ${formatRand(summary.openingMinor)} |`,
      `| Lines in the period | ${formatRand(summary.linesTotalMinor)} |`,
      `| Closing balance (statement) | ${formatRand(summary.closingMinor)} |`,
      `| Difference | ${formatRand(summary.differenceMinor)} |`,
      `| Ledger balance of ${bank.accountCode} | ${formatRand(summary.glBalanceMinor)} |`,
      "",
      "Every line is reconciled or excluded. Approving locks these lines. Approve it under **Accounting → Bank → Reconcile**, or mark this issue done yourself (a person must do it).",
    ].join("\n"),
    originKind: ORIGIN,
    originId: `reconciliation:${rec.id}`,
    wake: false,
  });
  await db.setReconciliationStatus(ctx.db, companyId, rec.id, "draft", { status: "pending_approval", approvalIssueId: issue.id });
  return (await db.getReconciliation(ctx.db, companyId, rec.id))!;
}

export async function approveReconciliation(ctx: PluginContext, companyId: string, actor: Actor, id: string, via: "page" | "issue" = "page"): Promise<db.ReconciliationRow> {
  const userId = requireUser(actor, "approve a reconciliation");
  const rec = await db.getReconciliation(ctx.db, companyId, id);
  if (!rec) throw new AccountingError("Reconciliation not found", "not_found");
  if (rec.status === "locked") return rec;
  if (rec.status !== "pending_approval") throw new AccountingError("Request approval first", "conflict");
  const lines = await db.listBankLines(ctx.db, companyId, { bankAccountId: rec.bankAccountId, from: rec.periodStart, to: rec.periodEnd, limit: 5000 });
  const summary = reconciliationSummary({ openingMinor: rec.openingMinor, closingMinor: rec.closingMinor, lines, glBalanceMinor: rec.glBalanceMinor });
  if (!summary.ready) {
    await db.setReconciliationStatus(ctx.db, companyId, rec.id, "pending_approval", { status: "draft" });
    if (rec.approvalIssueId) await commentOn(ctx, companyId, rec.approvalIssueId, `Not approved: ${summary.blockers.join(" ")} The reconciliation is back in draft.`);
    throw new AccountingError(summary.blockers.join(" "), "conflict");
  }
  await db.lockLinesToReconciliation(ctx.db, companyId, rec.bankAccountId, rec.periodStart, rec.periodEnd, rec.id);
  await db.setReconciliationStatus(ctx.db, companyId, rec.id, "pending_approval", { status: "locked", approvedBy: userId, lock: true });
  if (via === "page") await closeIssue(ctx, companyId, rec.approvalIssueId, "done", "Approved and locked.");
  else if (rec.approvalIssueId) await commentOn(ctx, companyId, rec.approvalIssueId, "Approved and locked.");
  return (await db.getReconciliation(ctx.db, companyId, rec.id))!;
}

export async function onReconciliationIssue(ctx: PluginContext, companyId: string, rec: db.ReconciliationRow, status: string, actor: { type?: string; id?: string }): Promise<void> {
  if (rec.status !== "pending_approval") return;
  if (status === "cancelled") {
    await db.setReconciliationStatus(ctx.db, companyId, rec.id, "pending_approval", { status: "draft" });
    return;
  }
  if (status !== "done") return;
  if (actor.type === "user" && actor.id) {
    await approveReconciliation(ctx, companyId, { kind: "user", userId: actor.id }, rec.id, "issue").catch(() => undefined);
    return;
  }
  if (rec.approvalIssueId) await commentOn(ctx, companyId, rec.approvalIssueId, "Closed without a person's approval, so the reconciliation was not locked. A board user can approve it in Accounting → Bank → Reconcile.");
}
