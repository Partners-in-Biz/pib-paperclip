/**
 * Accountant pack: a ZIP with the trial balance, general ledger, journals,
 * chart, open items, VAT returns and the audit hash-check result. Stored in
 * the private R2 bucket and handed out as a presigned download (24 hours).
 * Without R2 a small pack comes back inline for the browser to save.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import * as db from "../db.js";
import { toCsv, zipFiles } from "../domain/files.js";
import { financialYear } from "../domain/periods.js";
import { trialBalance } from "../domain/reports.js";
import { AccountingError, addDays, decimal, requireDate, todayIso } from "../domain/util.js";
import { VAT_FIELDS, VAT_FIELD_LABELS } from "../domain/vat.js";
import { ensureBook, loadChart } from "./books.js";
import { newId, privateR2, r2Url, readSettings, type Actor } from "./common.js";
import { verifyJournalChain } from "./journals.js";

const INLINE_LIMIT = 700_000;

export async function buildPack(ctx: PluginContext, companyId: string, actor: Actor, input: { from?: unknown; to?: unknown }) {
  await ensureBook(ctx, companyId);
  const settings = await readSettings(ctx, companyId);
  const to = input.to ? requireDate(input.to, "to") : todayIso();
  const from = input.from ? requireDate(input.from, "from") : financialYear(to, settings.yearEndMonth).start;
  if (to < from) throw new AccountingError("The end date is before the start date");
  const chart = await loadChart(ctx, companyId);
  const [totals, journals, openItems, vatReturns, chain, before] = await Promise.all([
    db.accountTotals(ctx.db, companyId, { to }),
    db.journalsInRange(ctx.db, companyId, from, to),
    db.listOpenItems(ctx.db, companyId, { openOnly: false }),
    db.listVatReturns(ctx.db, companyId),
    verifyJournalChain(ctx, companyId),
    db.accountTotals(ctx.db, companyId, { to: addDays(from, -1) }),
  ]);

  const tb = trialBalance(chart.accounts, totals);
  const tbCsv = toCsv(
    ["Code", "Account", "Type", "Debit", "Credit"],
    [...tb.lines.map((l) => [l.code, l.name, l.type, decimal(l.debitMinor), decimal(l.creditMinor)]), ["", "Total", "", decimal(tb.totalDebitMinor), decimal(tb.totalCreditMinor)]],
  );
  const chartCsv = toCsv(
    ["Code", "Name", "Type", "Kind", "Cash flow", "Active", "Roles"],
    chart.accounts.map((a) => [a.code, a.name, a.type, a.subtype, a.cashFlow, a.active ? "yes" : "no", [...chart.roles].filter(([, c]) => c === a.code).map(([r]) => r).join(" ")]),
  );

  // GL: opening per account, then each line with a running balance.
  const opening = new Map(before.map((t) => [t.accountId, t.debitMinor - t.creditMinor]));
  const running = new Map(opening);
  const glRows: unknown[][] = [];
  for (const a of chart.accounts) {
    const o = opening.get(a.id);
    if (o) glRows.push([a.code, a.name, from, "", "Opening balance", "", "", decimal(o)]);
  }
  for (const j of journals) {
    for (const l of j.lines) {
      const bal = (running.get(l.accountId) ?? 0) + l.debitMinor - l.creditMinor;
      running.set(l.accountId, bal);
      const a = chart.byId.get(l.accountId);
      glRows.push([l.accountCode, a?.name ?? "", j.date, j.number, l.memo || j.memo, decimal(l.debitMinor), decimal(l.creditMinor), decimal(bal)]);
    }
  }
  glRows.sort((x, y) => String(x[0]).localeCompare(String(y[0]), undefined, { numeric: true }));
  const glCsv = toCsv(["Code", "Account", "Date", "Journal", "Memo", "Debit", "Credit", "Balance (debit +)"], glRows);

  const journalRows: unknown[][] = [];
  for (const j of journals) {
    j.lines.forEach((l, i) =>
      journalRows.push([
        j.number,
        j.date,
        j.kind,
        j.status,
        j.sourceKey,
        j.memo,
        i + 1,
        l.accountCode,
        l.memo ?? "",
        decimal(l.debitMinor),
        decimal(l.creditMinor),
        l.taxCode ?? "",
        l.taxBaseMinor == null ? "" : decimal(l.taxBaseMinor),
        j.currency,
        j.fxRate ?? "",
        j.hash,
      ]),
    );
  }
  const journalsCsv = toCsv(["Journal", "Date", "Kind", "Status", "Source", "Memo", "Line", "Account", "Line memo", "Debit", "Credit", "Tax code", "Tax base", "Currency", "FX rate", "Hash"], journalRows);

  const openCsv = toCsv(
    ["Kind", "Number", "Counterparty", "Currency", "Total", "Outstanding", "Issued", "Due", "Status"],
    openItems.map((i) => [i.kind, i.number, i.counterpartyName, i.currency, decimal(i.totalMinor), decimal(i.outstandingMinor), i.issueDate ?? "", i.dueDate ?? "", i.status]),
  );
  const vatCsv = toCsv(
    ["Period start", "Period end", "Status", ...VAT_FIELDS.map((f) => VAT_FIELD_LABELS[f])],
    vatReturns.map((v) => [v.periodStart, v.periodEnd, v.status, ...VAT_FIELDS.map((f) => decimal(Number(v.boxes[f] ?? 0)))]),
  );
  const audit = {
    generatedAt: new Date().toISOString(),
    company: settings.legalName || companyId,
    vatNumber: settings.vatNumber || null,
    period: { from, to },
    hashChain: chain,
    trialBalanceBalanced: tb.balanced,
    journalsInPeriod: journals.length,
    note: "Each journal's hash is sha256 over its content and the previous journal's hash; ok=true means no posted journal was changed or removed.",
  };
  const readme = [
    `Accountant pack for ${settings.legalName || "the company"} (${from} to ${to}).`,
    "",
    "trial-balance.csv      Balances at the end date",
    "general-ledger.csv     Every line in the period with running balances",
    "journals.csv           Journal lines with source keys and hashes",
    "chart-of-accounts.csv  Accounts and the roles mapped to them",
    "open-items.csv         Receivables and payables from Billing",
    "vat-returns.csv        VAT201 fields per period",
    "audit-check.json       Result of the hash-chain check",
    "",
    "Amounts are in ZAR. Debit balances are positive in the GL balance column.",
  ].join("\r\n");

  const zip = zipFiles([
    { name: "README.txt", data: readme },
    { name: "trial-balance.csv", data: tbCsv },
    { name: "general-ledger.csv", data: glCsv },
    { name: "journals.csv", data: journalsCsv },
    { name: "chart-of-accounts.csv", data: chartCsv },
    { name: "open-items.csv", data: openCsv },
    { name: "vat-returns.csv", data: vatCsv },
    { name: "audit-check.json", data: JSON.stringify(audit, null, 2) },
  ]);
  const fileName = `accountant-pack-${from}-${to}.zip`;
  const cfg = await privateR2(ctx, companyId, settings.raw);
  if (cfg) {
    const key = `${cfg.prefix}/${companyId}/packs/${to}-${newId()}.zip`;
    const res = await fetch(r2Url(cfg, "PUT", key, 300), { method: "PUT", body: zip, headers: { "content-type": "application/zip" } });
    if (!res.ok) throw new AccountingError(`Could not store the pack (HTTP ${res.status})`);
    const url = r2Url(cfg, "GET", key, 24 * 3600, { "response-content-disposition": `attachment; filename="${fileName}"` });
    return { fileName, bytes: zip.byteLength, url, expiresInSec: 24 * 3600, data: null, audit, preparedBy: actor.kind };
  }
  if (zip.byteLength > INLINE_LIMIT) throw new AccountingError("The pack is too large to download directly. Set up the private R2 bucket in the Accounting settings.", "not_configured");
  return { fileName, bytes: zip.byteLength, url: null, expiresInSec: 0, data: Buffer.from(zip).toString("base64"), audit, preparedBy: actor.kind };
}
