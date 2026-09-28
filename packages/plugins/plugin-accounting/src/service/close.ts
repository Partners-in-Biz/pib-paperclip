/** Month-end close checklist (read-only; a board user closes the period), and the steps recorded as not needed. */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import * as db from "../db.js";
import { dueDepreciation } from "../domain/assets.js";
import { periodLabel } from "../domain/dates.js";
import { endsBeforeBooks, vatPeriodFor, type DateRange } from "../domain/periods.js";
import { trialBalance } from "../domain/reports.js";
import { AccountingError, addMonths, lastDayOfMonth, monthOf, requireMonth, todayIso } from "../domain/util.js";
import { resolveBankAccount } from "./bank.js";
import { booksStartFor, loadChart } from "./books.js";
import { actorRecord, BOOK_CURRENCY, readSettings, type Actor } from "./common.js";
import { verifyJournalChain } from "./journals.js";

export interface ChecklistItem {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

/** Month-end steps the Bookkeeper can record as not needed (`mark-not-needed`). */
export const CLOSE_STEPS = ["reconciliation", "vat201"] as const;
export type CloseStep = (typeof CLOSE_STEPS)[number];

const reconciliationStep = (bankAccountId: string) => `reconciliation:${bankAccountId}`;
const VAT_STEP = "vat201";

export async function closeChecklist(ctx: PluginContext, companyId: string, monthInput?: unknown) {
  const month = monthInput ? requireMonth(monthInput, "month") : addMonths(monthOf(todayIso()), -1);
  const start = `${month}-01`;
  const end = lastDayOfMonth(month);
  const settings = await readSettings(ctx, companyId);
  const skipped = new Map((await db.listCloseSkips(ctx.db, companyId, month)).map((s) => [s.step, s.reason]));
  const items: ChecklistItem[] = [];

  const unreconciled = await db.unreconciledInMonth(ctx.db, companyId, start, end);
  items.push({ key: "bank_lines", label: "Every bank line in the month is reconciled or excluded", ok: unreconciled === 0, detail: unreconciled ? `${unreconciled} line(s) still open` : "All done" });

  const banks = (await db.listBankAccounts(ctx.db, companyId)).filter((b) => b.active);
  const recs = await db.listReconciliations(ctx.db, companyId);
  // A reconciliation the Bookkeeper recorded as not needed (with its reason) counts as done.
  const notNeeded = banks.filter((b) => skipped.has(reconciliationStep(b.id)));
  const missing = banks.filter((b) => !skipped.has(reconciliationStep(b.id)) && !recs.some((r) => r.bankAccountId === b.id && r.status === "locked" && r.periodStart <= end && r.periodEnd >= end));
  const notNeededText = notNeeded.length ? `not needed: ${notNeeded.map((b) => `${b.name} (${skipped.get(reconciliationStep(b.id))})`).join("; ")}` : "";
  items.push({
    key: "reconciliations",
    label: "Each bank account has an approved reconciliation to the month end",
    ok: missing.length === 0,
    detail: banks.length === 0
      ? "No bank accounts yet"
      : missing.length
        ? `Missing: ${missing.map((b) => b.name).join(", ")}${notNeededText ? `; ${notNeededText}` : ""}`
        : notNeededText
          ? `All approved or ${notNeededText}`
          : "All approved",
  });

  const rejections = await db.listRejections(ctx.db, companyId, "open");
  items.push({ key: "rejections", label: "No rejected postings are waiting", ok: rejections.length === 0, detail: rejections.length ? `${rejections.length} waiting (Journals → Rejected)` : "None" });

  const drafts = await db.listDrafts(ctx.db, companyId, ["draft", "pending_approval"]);
  const inMonth = drafts.filter((d) => d.date >= start && d.date <= end);
  items.push({ key: "drafts", label: "No manual journals for the month are still in draft or waiting for approval", ok: inMonth.length === 0, detail: inMonth.length ? `${inMonth.length} waiting` : "None" });

  const assets = await db.listAssets(ctx.db, companyId);
  let due = 0;
  for (const asset of assets) {
    const posted = await db.journalsWithSourcePrefix(ctx.db, companyId, `depreciation:${asset.id}:`);
    due += dueDepreciation(asset, month, new Set(posted.map((j) => j.sourceKey.split(":").pop()!))).length;
  }
  items.push({ key: "depreciation", label: "Depreciation is posted up to the month", ok: due === 0, detail: assets.length === 0 ? "No assets" : due ? `${due} month(s) not posted (Books setup → Assets & exchange rates → Run depreciation)` : "Posted" });

  const foreign = (await db.listOpenItems(ctx.db, companyId)).filter((i) => i.currency !== BOOK_CURRENCY && i.outstandingMinor > 0);
  const reval = foreign.length ? await db.journalBySourceKey(ctx.db, companyId, `fx-reval:${month}`) : null;
  items.push({
    key: "fx",
    label: "Open foreign-currency items are revalued at the month end",
    ok: foreign.length === 0 || Boolean(reval),
    detail: foreign.length === 0 ? "No foreign-currency items" : reval ? `Posted ${reval.number}` : `${foreign.length} item(s) not revalued (Books setup → Assets & exchange rates → Revalue)`,
  });

  const vat = vatPeriodFor(end, settings.vatCategory, settings.yearEndMonth);
  if (vat && vat.end === end) {
    const ret = await db.vatReturnByPeriod(ctx.db, companyId, vat.start, vat.end);
    // A VAT period that ended before these books start was filed from the previous books.
    const previousBooks = !ret && endsBeforeBooks(vat, (await booksStartFor(ctx, companyId))?.date);
    const skip = skipped.get(VAT_STEP);
    if (!previousBooks) {
      items.push({
        key: "vat",
        label: `VAT201 for ${vat.start} to ${vat.end} is approved`,
        ok: ret?.status === "locked" || (!ret && skip != null),
        detail: ret ? ret.status.replace("_", " ") : skip != null ? `Not needed: ${skip}` : "Not prepared",
      });
    }
  }

  const chart = await loadChart(ctx, companyId);
  const tb = trialBalance(chart.accounts, await db.accountTotals(ctx.db, companyId, { to: end }));
  items.push({ key: "trial_balance", label: "The trial balance balances", ok: tb.balanced, detail: tb.balanced ? "Balanced" : `Debits ${tb.totalDebitMinor} vs credits ${tb.totalCreditMinor}` });

  const chain = await verifyJournalChain(ctx, companyId);
  items.push({ key: "audit_chain", label: "The journal audit chain is intact", ok: chain.ok, detail: chain.ok ? `${chain.checked} journals checked` : chain.problem ?? "Broken" });

  const status = await db.periodStatus(ctx.db, companyId, month);
  return { month, periodStatus: status, items, ready: items.every((i) => i.ok) };
}

// ---------------------------------------------------------------------------
// What the "Month-end close" issue needs from the Bookkeeper
// ---------------------------------------------------------------------------

export interface CloseNeeds {
  month: string;
  /** Active bank accounts with statement lines up to the month end (the others have nothing to reconcile yet). */
  reconciliations: Array<{ bank: { id: string; name: string }; done: boolean; reconciliation: { id: string; status: string; periodStart: string; periodEnd: string } | null; notNeeded: string | null }>;
  /** The VAT period that ends on the month end (null when none does, the company is not VAT-registered, or the previous books filed it). */
  vat: { period: DateRange; done: boolean; status: string | null; notNeeded: string | null } | null;
}

/**
 * The Bookkeeper's part of the month-end close for `month`: every active bank
 * account with statement lines up to the month end has a reconciliation
 * whose period overlaps the month (prepared, waiting for approval or
 * locked), and the VAT201 of a VAT period ending on the month end is
 * prepared; or each is recorded as not needed with a reason.
 */
export async function closeNeeds(ctx: PluginContext, companyId: string, month: string): Promise<CloseNeeds> {
  const start = `${month}-01`;
  const end = lastDayOfMonth(month);
  const [banks, recs, skips, settings] = await Promise.all([
    db.listBankAccounts(ctx.db, companyId),
    db.listReconciliations(ctx.db, companyId),
    db.listCloseSkips(ctx.db, companyId, month),
    readSettings(ctx, companyId),
  ]);
  const skipped = new Map(skips.map((s) => [s.step, s.reason]));
  const reconciliations: CloseNeeds["reconciliations"] = [];
  for (const bank of banks.filter((b) => b.active)) {
    const lines = await db.listBankLines(ctx.db, companyId, { bankAccountId: bank.id, to: end, limit: 1 });
    if (!lines.length) continue;
    const rec = recs
      .filter((r) => r.bankAccountId === bank.id && r.periodStart <= end && r.periodEnd >= start)
      .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0] ?? null;
    const notNeeded = skipped.get(reconciliationStep(bank.id)) ?? null;
    reconciliations.push({
      bank: { id: bank.id, name: bank.name },
      done: Boolean(rec) || notNeeded != null,
      reconciliation: rec ? { id: rec.id, status: rec.status, periodStart: rec.periodStart, periodEnd: rec.periodEnd } : null,
      notNeeded,
    });
  }
  let vat: CloseNeeds["vat"] = null;
  const period = vatPeriodFor(end, settings.vatCategory, settings.yearEndMonth);
  if (period && period.end === end) {
    const ret = await db.vatReturnByPeriod(ctx.db, companyId, period.start, period.end);
    const previousBooks = !ret && endsBeforeBooks(period, (await booksStartFor(ctx, companyId))?.date);
    if (!previousBooks) {
      const notNeeded = skipped.get(VAT_STEP) ?? null;
      vat = { period, done: Boolean(ret) || notNeeded != null, status: ret?.status ?? null, notNeeded };
    }
  }
  return { month, reconciliations, vat };
}

/**
 * The `mark-not-needed` tool: a month-end reconciliation or VAT201 is not
 * needed, with the reason (shown on the checklist; the month-end close check
 * accepts it).
 */
export async function markNotNeeded(ctx: PluginContext, companyId: string, actor: Actor, input: { month?: unknown; step?: unknown; bankAccountId?: unknown; reason?: unknown }) {
  const month = requireMonth(typeof input.month === "string" ? input.month.trim() : input.month, "month");
  const step = String(input.step ?? "");
  if (!(CLOSE_STEPS as readonly string[]).includes(step)) throw new AccountingError("step must be reconciliation or vat201");
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 300) : "";
  if (reason.length < 5) throw new AccountingError("Say why in reason, e.g. \"No statement for this account in August: it had no activity\"");
  if (step === "vat201") {
    const settings = await readSettings(ctx, companyId);
    const period = vatPeriodFor(lastDayOfMonth(month), settings.vatCategory, settings.yearEndMonth);
    if (!period || period.end !== lastDayOfMonth(month)) {
      return {
        month,
        step,
        recorded: false,
        next: period ? `No VAT period ends in ${month} (the current one ends on ${period.end}), so no VAT201 is due for it. Nothing to record.` : "The company is not VAT-registered, so there is no VAT201. Nothing to record.",
      };
    }
    await db.saveCloseSkip(ctx.db, companyId, { month, step: VAT_STEP, reason, recordedBy: actorRecord(actor) });
    return { month, step, recorded: true, vatPeriod: { start: period.start, end: period.end, label: periodLabel(period.start, period.end) }, reason, next: "Recorded. The month-end checklist shows the reason, and closing the month-end issue accepts it." };
  }
  const bank = await resolveBankAccount(ctx, companyId, input.bankAccountId);
  await db.saveCloseSkip(ctx.db, companyId, { month, step: reconciliationStep(bank.id), reason, recordedBy: actorRecord(actor) });
  return { month, step, recorded: true, bankAccount: { id: bank.id, name: bank.name }, reason, next: "Recorded. The month-end checklist shows the reason, and closing the month-end issue accepts it." };
}
