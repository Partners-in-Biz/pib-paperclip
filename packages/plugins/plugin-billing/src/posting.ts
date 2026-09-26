/**
 * Ledger orchestration: load the rows, build the journal (ledger.ts), check
 * the balance, enqueue it, and mark the document "posting". The
 * `ledger.post.result` handler stores the journal number back on the
 * document. Nothing is posted when `ledger.enabled` is off.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { isModuleEnabled, LEDGER_EVENTS, PIB_PLUGINS, settleOutbox, type LedgerPostResult, type TaxCode } from "@partnersinbiz/pib-plugin-kit";
import { ledgerEnabled, reportingCurrency, type BillingSettings } from "./config.js";
import { asObject, getInvoice, linesFor, table, type InvoiceRow, type PaymentRow } from "./db.js";
import { rateToBook } from "./fx.js";
import {
  billJournal,
  billPaymentJournal,
  creditNoteJournal,
  expenseJournal,
  invoiceIssueJournal,
  invoiceVoidJournal,
  parseLedgerKey,
  paymentJournal,
  postJournal,
  realisedFxJournal,
  reverseJournal,
  writeOffJournal,
  ymd,
} from "./ledger.js";
import { computeDocument, splitByGroups, type DocumentTotals } from "./money.js";

export function customerName(invoice: Pick<InvoiceRow, "customer" | "customer_snapshot" | "customer_ref">): string {
  const customer = asObject(invoice.customer_snapshot ?? invoice.customer);
  return typeof customer.name === "string" && customer.name ? customer.name : invoice.customer_ref;
}

export async function invoiceTotals(ctx: PluginContext, invoice: InvoiceRow): Promise<DocumentTotals> {
  const lines = await linesFor(ctx, invoice.id);
  return computeDocument(
    lines.map((line) => ({ quantity: Number(line.quantity), unitAmountMinor: Number(line.unit_amount_minor), taxCode: line.tax_code ?? null })),
    { pricesIncludeVat: Boolean(invoice.prices_include_vat), taxRatePercent: Number(invoice.tax_rate ?? 0) },
  );
}

async function bookRate(ctx: PluginContext, settings: BillingSettings, currency: string, date: string): Promise<number | null> {
  const book = reportingCurrency(settings);
  if (currency === book) return null;
  try {
    return await rateToBook(ctx, currency, book, date);
  } catch {
    return null;
  }
}

/**
 * Journals go to Accounting only when posting is on in the settings and the
 * company has not switched the Accounting module off.
 */
export async function ledgerOn(ctx: PluginContext, companyId: string, settings: BillingSettings): Promise<boolean> {
  return ledgerEnabled(settings) && (await isModuleEnabled(ctx, companyId, PIB_PLUGINS.accounting));
}

async function mark(ctx: PluginContext, tableName: string, id: string, extra = ""): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, tableName)} SET ledger_status = COALESCE(ledger_status, 'pending')${extra} WHERE id = $1`,
    [id],
  );
}

/** Invoice issued (sent): AR / revenue / output VAT. Stores the issue FX rate. */
export async function postInvoiceIssue(ctx: PluginContext, invoice: InvoiceRow, settings: BillingSettings): Promise<void> {
  if (!(await ledgerOn(ctx, invoice.company_id, settings))) return;
  const totals = await invoiceTotals(ctx, invoice);
  if (totals.totalMinor <= 0) return;
  const date = ymd(invoice.sent_at ?? new Date());
  const fxRate = invoice.fx_rate != null ? Number(invoice.fx_rate) : await bookRate(ctx, settings, invoice.currency, date);
  const journal = invoiceIssueJournal({
    id: invoice.id,
    number: invoice.number,
    date,
    currency: invoice.currency,
    fxRate,
    customerKind: invoice.customer_kind,
    customerRef: invoice.customer_ref,
    customerName: customerName(invoice),
    totalMinor: totals.totalMinor,
    groups: totals.groups,
  });
  await postJournal(ctx, invoice.company_id, journal);
  await ctx.db.execute(
    `UPDATE ${table(ctx, "invoices")} SET ledger_status = COALESCE(ledger_status, 'pending'), fx_rate = COALESCE(fx_rate, $2) WHERE id = $1`,
    [invoice.id, fxRate],
  );
}

/** Void a sent invoice: reverse its issue journal. */
export async function postInvoiceVoid(ctx: PluginContext, invoice: InvoiceRow, settings: BillingSettings): Promise<void> {
  if (!invoice.ledger_status || !(await ledgerOn(ctx, invoice.company_id, settings))) return;
  const totals = await invoiceTotals(ctx, invoice);
  if (totals.totalMinor <= 0) return;
  const issue = invoiceIssueJournal({
    id: invoice.id,
    number: invoice.number,
    date: invoice.sent_at ?? new Date(),
    currency: invoice.currency,
    fxRate: invoice.fx_rate == null ? null : Number(invoice.fx_rate),
    customerKind: invoice.customer_kind,
    customerRef: invoice.customer_ref,
    customerName: customerName(invoice),
    totalMinor: totals.totalMinor,
    groups: totals.groups,
  });
  await postJournal(ctx, invoice.company_id, invoiceVoidJournal(issue, { id: invoice.id, number: invoice.number, date: new Date() }));
}

export interface BankSide {
  bankAccountRole?: "bank" | "cash";
  bankAccountCode?: string | null;
}

function paymentPayload(invoice: InvoiceRow, payment: PaymentRow, fxRate: number | null, bank: BankSide & { bankTxId?: string | null; keySuffix?: string | null }) {
  return paymentJournal({
    id: payment.id,
    invoiceNumber: invoice.number,
    date: ymd(payment.paid_at),
    currency: invoice.currency,
    fxRate,
    amountMinor: Number(payment.amount_minor),
    customerKind: invoice.customer_kind,
    customerRef: invoice.customer_ref,
    bankTxId: bank.bankTxId ?? null,
    bankAccountRole: bank.bankAccountRole,
    bankAccountCode: bank.bankAccountCode ?? null,
    method: payment.method,
    reference: payment.reference,
    keySuffix: bank.keySuffix ?? null,
  });
}

/** Payment received (+ realised FX when the invoice is in a foreign currency). */
export async function postPayment(ctx: PluginContext, invoice: InvoiceRow, payment: PaymentRow, settings: BillingSettings, bank: BankSide = {}): Promise<void> {
  if (!(await ledgerOn(ctx, invoice.company_id, settings))) return;
  const date = ymd(payment.paid_at);
  const fxRate = payment.fx_rate != null ? Number(payment.fx_rate) : await bookRate(ctx, settings, invoice.currency, date);
  await postJournal(ctx, invoice.company_id, paymentPayload(invoice, payment, fxRate, { ...bank, bankTxId: payment.bank_tx_id ?? null }));
  await ctx.db.execute(
    `UPDATE ${table(ctx, "payments")} SET ledger_status = COALESCE(ledger_status, 'pending'), fx_rate = COALESCE(fx_rate, $2) WHERE id = $1`,
    [payment.id, fxRate],
  );
  const issueRate = invoice.fx_rate == null ? null : Number(invoice.fx_rate);
  if (fxRate && issueRate) {
    const fx = realisedFxJournal({
      paymentId: payment.id,
      invoiceNumber: invoice.number,
      date,
      bookCurrency: reportingCurrency(settings),
      allocatedMinor: Number(payment.allocated_minor ?? payment.amount_minor),
      issueRate,
      paymentRate: fxRate,
      customerKind: invoice.customer_kind,
      customerRef: invoice.customer_ref,
    });
    if (fx) await postJournal(ctx, invoice.company_id, fx);
  }
}

/**
 * A bank line matched a payment a person recorded earlier (POP or manual):
 * reverse that payment's journal and post it again on the matched bank
 * account with the bank tx id, so Accounting can reconcile the line.
 */
export async function repostPaymentOnBank(
  ctx: PluginContext,
  invoice: InvoiceRow,
  payment: PaymentRow,
  settings: BillingSettings,
  bank: BankSide & { bankTxId: string },
): Promise<void> {
  if (!payment.ledger_status || !(await ledgerOn(ctx, invoice.company_id, settings))) return;
  const fxRate = payment.fx_rate == null ? null : Number(payment.fx_rate);
  const original = paymentPayload(invoice, payment, fxRate, {});
  await postJournal(ctx, invoice.company_id, reverseJournal(original, payment.paid_at));
  await postJournal(ctx, invoice.company_id, paymentPayload(invoice, payment, fxRate, { ...bank, keySuffix: `bank:${bank.bankTxId}` }));
}

export async function postCreditNote(
  ctx: PluginContext,
  note: { id: string; number: string; amount_minor: number | string; created_at?: unknown },
  invoice: InvoiceRow,
  settings: BillingSettings,
): Promise<void> {
  if (!(await ledgerOn(ctx, invoice.company_id, settings))) return;
  const totals = await invoiceTotals(ctx, invoice);
  const amount = Number(note.amount_minor);
  await postJournal(ctx, invoice.company_id, creditNoteJournal({
    id: note.id,
    number: note.number,
    invoiceNumber: invoice.number,
    date: note.created_at ?? new Date(),
    currency: invoice.currency,
    fxRate: invoice.fx_rate == null ? null : Number(invoice.fx_rate),
    amountMinor: amount,
    customerKind: invoice.customer_kind,
    customerRef: invoice.customer_ref,
    split: splitByGroups(amount, totals.groups),
  }));
  await mark(ctx, "credit_notes", note.id);
}

export async function postWriteOff(ctx: PluginContext, invoice: InvoiceRow, amountMinor: number, reason: string | null, settings: BillingSettings): Promise<void> {
  if (!(await ledgerOn(ctx, invoice.company_id, settings))) return;
  const totals = await invoiceTotals(ctx, invoice);
  await postJournal(ctx, invoice.company_id, writeOffJournal({
    split: splitByGroups(amountMinor, totals.groups),
    invoiceId: invoice.id,
    invoiceNumber: invoice.number,
    date: new Date(),
    currency: invoice.currency,
    fxRate: invoice.fx_rate == null ? null : Number(invoice.fx_rate),
    amountMinor,
    customerKind: invoice.customer_kind,
    customerRef: invoice.customer_ref,
    reason,
  }));
}

export interface BillForPosting {
  id: string;
  company_id: string;
  supplier_name: string;
  supplier_reference: string | null;
  supplier_kind: string;
  supplier_ref: string | null;
  currency: string;
  category: string;
  total_minor: number | string;
  issue_date: unknown;
  approved_at: unknown;
  fx_rate: number | string | null;
}

export async function postBill(
  ctx: PluginContext,
  bill: BillForPosting,
  lines: Array<{ category: string | null; tax_code: string | null; net_minor: number | string | null; vat_minor: number | string | null }>,
  settings: BillingSettings,
): Promise<void> {
  if (!(await ledgerOn(ctx, bill.company_id, settings))) return;
  const date = ymd(bill.issue_date ?? bill.approved_at ?? new Date());
  const fxRate = bill.fx_rate != null ? Number(bill.fx_rate) : await bookRate(ctx, settings, bill.currency, date);
  await postJournal(ctx, bill.company_id, billJournal({
    id: bill.id,
    supplierName: bill.supplier_name,
    supplierReference: bill.supplier_reference,
    date,
    currency: bill.currency,
    fxRate,
    totalMinor: Number(bill.total_minor),
    supplierKind: bill.supplier_kind,
    supplierRef: bill.supplier_ref,
    lines: lines.map((l) => ({
      category: l.category || bill.category || "other",
      taxCode: (l.tax_code as TaxCode | null) ?? null,
      netMinor: Number(l.net_minor ?? 0),
      vatMinor: Number(l.vat_minor ?? 0),
    })),
  }));
  await ctx.db.execute(
    `UPDATE ${table(ctx, "bills")} SET ledger_status = COALESCE(ledger_status, 'pending'), fx_rate = COALESCE(fx_rate, $2) WHERE id = $1`,
    [bill.id, fxRate],
  );
}

export async function postBillPayment(
  ctx: PluginContext,
  bill: BillForPosting,
  payment: { id: string; amount_minor: number | string; paid_at: unknown; bank_tx_id: string | null },
  settings: BillingSettings,
  bank: BankSide = {},
): Promise<void> {
  if (!(await ledgerOn(ctx, bill.company_id, settings))) return;
  const date = ymd(payment.paid_at);
  const fxRate = await bookRate(ctx, settings, bill.currency, date);
  await postJournal(ctx, bill.company_id, billPaymentJournal({
    id: payment.id,
    supplierName: bill.supplier_name,
    date,
    currency: bill.currency,
    fxRate,
    amountMinor: Number(payment.amount_minor),
    bankTxId: payment.bank_tx_id,
    bankAccountRole: bank.bankAccountRole,
    bankAccountCode: bank.bankAccountCode ?? null,
    supplierKind: bill.supplier_kind,
    supplierRef: bill.supplier_ref,
  }));
  await mark(ctx, "bill_payments", payment.id);
}

export interface ExpenseForPosting {
  id: string;
  company_id: string;
  description: string;
  vendor: string | null;
  incurred_on: unknown;
  currency: string;
  amount_minor: number | string;
  vat_minor: number | string | null;
  vat_claimable: boolean | null;
  tax_code: string | null;
  category: string;
  paid_from: string | null;
  fx_rate: number | string | null;
}

function expensePayload(expense: ExpenseForPosting, version: number, fxRate: number | null) {
  return expenseJournal({
    id: expense.id,
    version,
    description: expense.description,
    vendor: expense.vendor,
    date: expense.incurred_on ?? new Date(),
    currency: expense.currency,
    fxRate,
    amountMinor: Number(expense.amount_minor),
    vatMinor: Number(expense.vat_minor ?? 0),
    vatClaimable: Boolean(expense.vat_claimable),
    taxCode: (expense.tax_code as TaxCode | null) ?? null,
    category: expense.category,
    paidFrom: expense.paid_from,
  });
}

/**
 * Post an expense as version `nextVersion`; when an earlier version was
 * posted (`previous`), reverse it first. Zero-amount expenses are skipped.
 */
export async function postExpense(
  ctx: PluginContext,
  expense: ExpenseForPosting,
  nextVersion: number,
  settings: BillingSettings,
  previous?: ExpenseForPosting | null,
): Promise<boolean> {
  if (!(await ledgerOn(ctx, expense.company_id, settings))) return false;
  if (previous && nextVersion > 1 && Number(previous.amount_minor) > 0) {
    await postJournal(ctx, expense.company_id, reverseJournal(expensePayload(previous, nextVersion - 1, previous.fx_rate == null ? null : Number(previous.fx_rate)), new Date()));
  }
  if (Number(expense.amount_minor) <= 0) return false;
  const date = ymd(expense.incurred_on ?? new Date());
  const fxRate = await bookRate(ctx, settings, expense.currency, date);
  await postJournal(ctx, expense.company_id, expensePayload(expense, nextVersion, fxRate));
  await ctx.db.execute(
    `UPDATE ${table(ctx, "expenses")} SET ledger_version = $2, ledger_status = 'pending', fx_rate = $3 WHERE id = $1`,
    [expense.id, nextVersion, fxRate],
  );
  return true;
}

const DOC_TABLE: Record<string, { table: string; column: string }> = {
  invoice: { table: "invoices", column: "issue_journal" },
  payment: { table: "payments", column: "journal_number" },
  credit_note: { table: "credit_notes", column: "journal_number" },
  bill: { table: "bills", column: "journal_number" },
  bill_payment: { table: "bill_payments", column: "journal_number" },
  expense: { table: "expenses", column: "journal_number" },
};

/**
 * `ledger.post.result` from Accounting: settle the outbox row and store the
 * journal number (or the rejection) on the document. Only the main journal
 * of a document writes its number (issue for invoices, approve for bills,
 * the current version for expenses, the bank re-post for payments). A
 * `posted` result always wins, also when it arrives after a rejection (a
 * retry after the chart was fixed); a rejection never overwrites a posting.
 */
export async function onLedgerResult(ctx: PluginContext, result: LedgerPostResult): Promise<boolean> {
  if (!result?.key || result.source?.plugin !== PIB_PLUGINS.billing) return false;
  const posted = result.status === "posted";
  await settleOutbox(ctx, result.key, result as unknown as Record<string, unknown>, posted ? "done" : "failed");
  const parsed = parseLedgerKey(result.key);
  if (!parsed) return true;
  const target = DOC_TABLE[parsed.kind];
  if (!target) return true;
  const main =
    (parsed.kind === "invoice" && parsed.event === "issue") ||
    (parsed.kind === "bill" && parsed.event === "approve") ||
    (parsed.kind === "expense" && parsed.event != null && /^v\d+$/.test(parsed.event)) ||
    (parsed.kind === "payment" && (parsed.event == null || /^bank:/.test(parsed.event))) ||
    ((parsed.kind === "bill_payment" || parsed.kind === "credit_note") && (parsed.event == null || parsed.event === "issue"));
  if (!main) return true;
  const hasError = target.table === "invoices" || target.table === "bills";
  const journal = result.journalNumber ?? result.journalId ?? null;
  if (posted) {
    await ctx.db.execute(
      `UPDATE ${table(ctx, target.table)} SET ledger_status = 'posted', ${target.column} = COALESCE($2, ${target.column})${hasError ? ", ledger_error = NULL" : ""} WHERE id = $1`,
      [parsed.id, journal],
    );
  } else {
    await ctx.db.execute(
      `UPDATE ${table(ctx, target.table)} SET ledger_status = 'rejected'${hasError ? ", ledger_error = $2" : ""} WHERE id = $1 AND COALESCE(ledger_status, '') <> 'posted'`,
      hasError ? [parsed.id, String(result.error ?? "Rejected by Accounting")] : [parsed.id],
    );
  }
  return true;
}

export const LEDGER_RESULT_EVENT = `plugin.${PIB_PLUGINS.accounting}.${LEDGER_EVENTS.postResult}` as const;

export async function reloadInvoice(ctx: PluginContext, id: string): Promise<InvoiceRow | null> {
  return getInvoice(ctx, id);
}
