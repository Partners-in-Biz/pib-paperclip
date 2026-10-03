/**
 * Bank reconciliation per bank account and statement period:
 * prepare (balances and blockers) → approval issue for a person (the owner,
 * else whoever asked) → a person approves → the period's lines are locked
 * to the reconciliation. The Bookkeeper prepares and asks; only a person
 * approves (an agent closing the issue reopens it for the person).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import * as db from "../db.js";
import { reconciliationSummary, type ReconciliationSummary } from "../domain/reconcile.js";
import { AccountingError, addDays, addMonths, lastDayOfMonth, monthOf, requireDate, requireMonth, todayIso } from "../domain/util.js";
import { resolveBankAccount } from "./bank.js";
import { loadChart } from "./books.js";
import { actorRecord, closeIssue, commentOn, money, newId, reopenForPerson, requireUser, type Actor } from "./common.js";
import { openLedgerApproval, retireOldApprovalIssue, reviewGate } from "./review.js";

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
  // A line belongs to one reconciliation: an overlapping period would count it twice and leave two approvals for the same money.
  // A longer period that fully contains an unlocked one replaces it (a later statement can hold lines dated inside the last period,
  // so the period has to grow); anything else that overlaps is refused.
  for (let guard = 0; guard < 12; guard += 1) {
    const overlap = await db.overlappingReconciliation(ctx.db, companyId, bank.id, start, end);
    if (!overlap) break;
    if (overlap.status !== "locked" && overlap.periodStart >= start && overlap.periodEnd <= end) {
      if (overlap.approvalIssueId) await closeIssue(ctx, companyId, overlap.approvalIssueId, "cancelled", `Replaced by the longer reconciliation ${start} to ${end}.`);
      await db.deleteReconciliation(ctx.db, companyId, overlap.id);
      continue;
    }
    throw new AccountingError(
      `This period overlaps the reconciliation ${overlap.periodStart} to ${overlap.periodEnd} (${overlap.status.replace("_", " ")}) without containing it. Use that one, or ask a person to discard it under Accounting → Bank → Reconcile first. Do not prepare a second one for the same lines.`,
      "conflict",
    );
  }
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

/** A reconciliation as it stands, in any status, without preparing it again (preparing refuses one that is already waiting or locked). */
export async function viewReconciliation(ctx: PluginContext, companyId: string, id: string): Promise<PreparedReconciliation> {
  const rec = await db.getReconciliation(ctx.db, companyId, id);
  if (!rec) throw new AccountingError("Reconciliation not found", "not_found");
  const bank = await db.getBankAccount(ctx.db, companyId, rec.bankAccountId);
  if (!bank) throw new AccountingError("Bank account not found", "not_found");
  const lines = await db.listBankLines(ctx.db, companyId, { bankAccountId: bank.id, from: rec.periodStart, to: rec.periodEnd, limit: 5000 });
  const summary = reconciliationSummary({ openingMinor: rec.openingMinor, closingMinor: rec.closingMinor, lines, glBalanceMinor: await glBalance(ctx, companyId, bank.accountCode, rec.periodEnd) });
  return { reconciliation: rec, summary, bank };
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
  const issue = await openLedgerApproval(ctx, {
    companyId,
    kind: "reconciliation",
    subjectId: rec.id,
    actor,
    title: `Approve bank reconciliation: ${bank.name} ${rec.periodStart} to ${rec.periodEnd}`,
    description: [
      `| | |`,
      `|---|---:|`,
      `| Opening balance | ${money(summary.openingMinor)} |`,
      `| Lines in the period | ${money(summary.linesTotalMinor)} |`,
      `| Closing balance (statement) | ${money(summary.closingMinor)} |`,
      `| Difference | ${money(summary.differenceMinor)} |`,
      `| Ledger balance of ${bank.accountCode} | ${money(summary.glBalanceMinor)} |`,
      "",
      `Prepared by ${actor.kind === "agent" ? "the Bookkeeper" : "a board user"}. Every line is reconciled or excluded, and the statement difference is zero. Approving locks these lines.`,
      "To approve, mark this issue done yourself, or approve it under **Accounting → Bank → Reconcile**. Only a person can approve: if an agent closes it, it opens again for you. The Reviewer checks it first when there is one. To refuse, cancel this issue; the reconciliation goes back to draft.",
    ].join("\n"),
    priority: "high",
    originId: `reconciliation:${rec.id}`,
  });
  await db.setReconciliationStatus(ctx.db, companyId, rec.id, "draft", { status: "pending_approval", approvalIssueId: issue.id });
  // After a Reviewer send-back this is a fresh request: the old approval issue is retired. Only now that the row points at
  // the new issue: the cancel is announced as an event, and one that finds the row still on the old issue would undo this request.
  await retireOldApprovalIssue(ctx, companyId, rec.approvalIssueId, issue.id);
  return (await db.getReconciliation(ctx.db, companyId, rec.id))!;
}

export async function approveReconciliation(ctx: PluginContext, companyId: string, actor: Actor, id: string, via: "page" | "issue" = "page", options: { overrideReview?: boolean } = {}): Promise<db.ReconciliationRow> {
  const userId = requireUser(actor, "approve a reconciliation");
  const rec = await db.getReconciliation(ctx.db, companyId, id);
  if (!rec) throw new AccountingError("Reconciliation not found", "not_found");
  if (rec.status === "locked") return rec;
  if (rec.status !== "pending_approval") throw new AccountingError("Request approval first", "conflict");
  const gate = await reviewGate(ctx, companyId, "reconciliation", rec.id, { via, userId, override: options.overrideReview });
  const lines = await db.listBankLines(ctx.db, companyId, { bankAccountId: rec.bankAccountId, from: rec.periodStart, to: rec.periodEnd, limit: 5000 });
  const summary = reconciliationSummary({ openingMinor: rec.openingMinor, closingMinor: rec.closingMinor, lines, glBalanceMinor: rec.glBalanceMinor });
  if (!summary.ready) {
    await db.setReconciliationStatus(ctx.db, companyId, rec.id, "pending_approval", { status: "draft" });
    if (rec.approvalIssueId) await commentOn(ctx, companyId, rec.approvalIssueId, `Not approved: ${summary.blockers.join(" ")} The reconciliation is back in draft.`);
    throw new AccountingError(summary.blockers.join(" "), "conflict");
  }
  await db.lockLinesToReconciliation(ctx.db, companyId, rec.bankAccountId, rec.periodStart, rec.periodEnd, rec.id);
  await db.setReconciliationStatus(ctx.db, companyId, rec.id, "pending_approval", { status: "locked", approvedBy: userId, lock: true });
  await gate.confirm();
  if (via === "page") await closeIssue(ctx, companyId, rec.approvalIssueId, "done", "Approved and locked.");
  else if (rec.approvalIssueId) await commentOn(ctx, companyId, rec.approvalIssueId, "Approved and locked.");
  return (await db.getReconciliation(ctx.db, companyId, rec.id))!;
}

/**
 * The `prepare-reconciliation` tool: prepare one bank account's
 * reconciliation for a calendar month (or an exact statement period) and,
 * when it is ready, open its approval issue for a person.
 */
/**
 * FNB statements run from the last day of the previous month ("31 July to 31 August"), so a line dated 31 July can sit on the August
 * statement. A calendar-month reconciliation then misses it and does not match the statement. When that is why the difference is not
 * zero, say which period to use instead.
 */
async function boundaryHint(ctx: PluginContext, companyId: string, bankAccountId: string, start: string, end: string): Promise<string | null> {
  const [statements, lines] = await Promise.all([
    db.listStatements(ctx.db, companyId, bankAccountId),
    db.listBankLines(ctx.db, companyId, { bankAccountId, from: start, to: end, limit: 5000 }),
  ]);
  const byId = new Map(statements.map((st) => [st.id, st]));
  const late = new Map<string, number>();
  for (const l of lines) {
    const st = l.statementId ? byId.get(l.statementId) : undefined;
    if (st && st.periodEnd && st.periodEnd > end) late.set(st.id, (late.get(st.id) ?? 0) + 1);
  }
  const top = [...late.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!top) return null;
  const st = byId.get(top[0])!;
  return `${top[1]} line(s) dated within ${start} to ${end} are on the statement for ${st.periodStart} to ${st.periodEnd}, so this period cannot tie to a statement. Reconcile ${start} to ${st.periodEnd} instead (openingMinor from the first statement, closingMinor from the last).`;
}

/** Remove a reconciliation that is not locked (a person only): its approval issue is cancelled and the lines stay as they are. */
export async function discardReconciliation(ctx: PluginContext, companyId: string, actor: Actor, id: string): Promise<{ discarded: boolean }> {
  requireUser(actor, "discard a reconciliation");
  const rec = await db.getReconciliation(ctx.db, companyId, id);
  if (!rec) throw new AccountingError("Reconciliation not found", "not_found");
  if (rec.status === "locked") throw new AccountingError("A locked reconciliation cannot be discarded", "conflict");
  if (rec.approvalIssueId) await closeIssue(ctx, companyId, rec.approvalIssueId, "cancelled", "Discarded: this reconciliation was replaced.");
  return { discarded: await db.deleteReconciliation(ctx.db, companyId, id) };
}

export async function prepareReconciliationTool(
  ctx: PluginContext,
  companyId: string,
  actor: Actor,
  input: { bankAccountId?: unknown; month?: unknown; periodStart?: unknown; periodEnd?: unknown; openingMinor?: unknown; closingMinor?: unknown; requestApproval?: unknown },
) {
  const bank = await resolveBankAccount(ctx, companyId, input.bankAccountId);
  let start: string;
  let end: string;
  if (input.periodStart || input.periodEnd) {
    start = requireDate(input.periodStart, "periodStart");
    end = requireDate(input.periodEnd, "periodEnd");
  } else {
    const month = typeof input.month === "string" && input.month.trim() ? requireMonth(input.month.trim(), "month") : addMonths(monthOf(todayIso()), -1);
    start = `${month}-01`;
    end = lastDayOfMonth(month);
  }
  const existing = await db.reconciliationByPeriod(ctx.db, companyId, bank.id, start, end);
  if (existing && existing.status !== "draft") {
    return {
      reconciliationId: existing.id,
      bankAccount: { id: bank.id, name: bank.name },
      periodStart: start,
      periodEnd: end,
      status: existing.status,
      approvalIssueId: existing.approvalIssueId,
      next: existing.status === "locked" ? "Already approved and locked. Nothing to do." : "Already waiting for a person's approval on its issue. Nothing to do.",
    };
  }
  const prepared = await prepareReconciliation(ctx, companyId, actor, { bankAccountId: bank.id, periodStart: start, periodEnd: end, openingMinor: input.openingMinor, closingMinor: input.closingMinor });
  let rec = prepared.reconciliation;
  const s = prepared.summary;
  const hint = !s.ready && s.unreconciledCount === 0 && s.differenceMinor !== 0 ? await boundaryHint(ctx, companyId, bank.id, start, end) : null;
  const wantApproval = input.requestApproval !== false;
  if (wantApproval && s.ready) rec = await requestReconciliationApproval(ctx, companyId, actor, rec.id);
  const next = rec.status === "pending_approval"
    ? "Approval issue opened for a person. Nothing more to do here; it shows in the Cockpit until they approve."
    : s.ready
      ? "Ready. Run again without requestApproval: false to open the approval issue."
      : s.unreconciledCount > 0
        ? `Reconcile the ${s.unreconciledCount} open line(s) first (list-bank-lines with bankAccountId and to: ${end}), then run this again.`
        : hint
          ? hint
          : `The statement does not add up (difference ${money(s.differenceMinor)}): check the opening and closing balance on the statement (pass openingMinor and closingMinor), or a line may be missing. If you cannot tell, ask with the ask-owner tool.`;
  return {
    reconciliationId: rec.id,
    bankAccount: { id: bank.id, name: bank.name },
    periodStart: start,
    periodEnd: end,
    status: rec.status,
    openingMinor: s.openingMinor,
    closingMinor: s.closingMinor,
    linesTotalMinor: s.linesTotalMinor,
    differenceMinor: s.differenceMinor,
    openLines: s.unreconciledCount,
    ledgerBalanceMinor: s.glBalanceMinor,
    ledgerDifferenceMinor: s.glDifferenceMinor,
    ready: s.ready,
    blockers: s.blockers,
    approvalIssueId: rec.approvalIssueId,
    next,
  };
}

export async function onReconciliationIssue(ctx: PluginContext, companyId: string, rec: db.ReconciliationRow, status: string, actor: { type?: string; id?: string }): Promise<void> {
  if (rec.status !== "pending_approval") return;
  if (actor.type === "agent" && (status === "done" || status === "cancelled")) {
    await reopenForPerson(ctx, companyId, rec.approvalIssueId, `bank reconciliation ${rec.periodStart} to ${rec.periodEnd}`);
    return;
  }
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
