/** Month-end close checklist (read-only; a board user closes the period). */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import * as db from "../db.js";
import { dueDepreciation } from "../domain/assets.js";
import { vatPeriodFor } from "../domain/periods.js";
import { trialBalance } from "../domain/reports.js";
import { addMonths, lastDayOfMonth, monthOf, requireMonth, todayIso } from "../domain/util.js";
import { loadChart } from "./books.js";
import { BOOK_CURRENCY, readSettings } from "./common.js";
import { verifyJournalChain } from "./journals.js";

export interface ChecklistItem {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

export async function closeChecklist(ctx: PluginContext, companyId: string, monthInput?: unknown) {
  const month = monthInput ? requireMonth(monthInput, "month") : addMonths(monthOf(todayIso()), -1);
  const start = `${month}-01`;
  const end = lastDayOfMonth(month);
  const settings = await readSettings(ctx, companyId);
  const items: ChecklistItem[] = [];

  const unreconciled = await db.unreconciledInMonth(ctx.db, companyId, start, end);
  items.push({ key: "bank_lines", label: "Every bank line in the month is reconciled or excluded", ok: unreconciled === 0, detail: unreconciled ? `${unreconciled} line(s) still open` : "All done" });

  const banks = (await db.listBankAccounts(ctx.db, companyId)).filter((b) => b.active);
  const recs = await db.listReconciliations(ctx.db, companyId);
  const missing = banks.filter((b) => !recs.some((r) => r.bankAccountId === b.id && r.status === "locked" && r.periodStart <= end && r.periodEnd >= end));
  items.push({
    key: "reconciliations",
    label: "Each bank account has an approved reconciliation to the month end",
    ok: missing.length === 0,
    detail: banks.length === 0 ? "No bank accounts yet" : missing.length ? `Missing: ${missing.map((b) => b.name).join(", ")}` : "All approved",
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
  items.push({ key: "depreciation", label: "Depreciation is posted up to the month", ok: due === 0, detail: assets.length === 0 ? "No assets" : due ? `${due} month(s) not posted (Assets → Run depreciation)` : "Posted" });

  const foreign = (await db.listOpenItems(ctx.db, companyId)).filter((i) => i.currency !== BOOK_CURRENCY && i.outstandingMinor > 0);
  const reval = foreign.length ? await db.journalBySourceKey(ctx.db, companyId, `fx-reval:${month}`) : null;
  items.push({
    key: "fx",
    label: "Open foreign-currency items are revalued at the month end",
    ok: foreign.length === 0 || Boolean(reval),
    detail: foreign.length === 0 ? "No foreign-currency items" : reval ? `Posted ${reval.number}` : `${foreign.length} item(s) not revalued (Reports → FX)`,
  });

  const vat = vatPeriodFor(end, settings.vatCategory, settings.yearEndMonth);
  if (vat && vat.end === end) {
    const ret = await db.vatReturnByPeriod(ctx.db, companyId, vat.start, vat.end);
    items.push({ key: "vat", label: `VAT201 for ${vat.start} to ${vat.end} is approved`, ok: ret?.status === "locked", detail: ret ? ret.status.replace("_", " ") : "Not prepared" });
  }

  const chart = await loadChart(ctx, companyId);
  const tb = trialBalance(chart.accounts, await db.accountTotals(ctx.db, companyId, { to: end }));
  items.push({ key: "trial_balance", label: "The trial balance balances", ok: tb.balanced, detail: tb.balanced ? "Balanced" : `Debits ${tb.totalDebitMinor} vs credits ${tb.totalCreditMinor}` });

  const chain = await verifyJournalChain(ctx, companyId);
  items.push({ key: "audit_chain", label: "The journal audit chain is intact", ok: chain.ok, detail: chain.ok ? `${chain.checked} journals checked` : chain.problem ?? "Broken" });

  const status = await db.periodStatus(ctx.db, companyId, month);
  return { month, periodStatus: status, items, ready: items.every((i) => i.ok) };
}
