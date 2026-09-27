/**
 * Journals skipped while Accounting was switched off (or posting was off in
 * the settings). Documents that should be in the books but never reached the
 * outbox are enqueued now, under the same keys they would have had, so a
 * repeat run (or a journal that did go out) changes nothing.
 *
 * Runs when the Setup plugin says Accounting is on (`modules.updated`) and
 * from a nightly job. Not covered: an expense or bill changed while posting
 * was off after its first journal went out (its later version).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { billingSettings } from "./config.js";
import { billLines, forPosting } from "./costs.js";
import { getInvoice, INVOICE_COLUMNS, PAYMENT_COLUMNS, table, type CreditNoteRow, type ExpenseRow, type InvoiceRow, type PaymentRow } from "./db.js";
import { ledgerOn, postBill, postBillPayment, postCreditNote, postExpense, postInvoiceIssue, postInvoiceVoid, postPayment, postWriteOff } from "./posting.js";
import { getBill } from "./settle.js";

export interface BackpostCounts {
  invoices: number;
  voids: number;
  payments: number;
  creditNotes: number;
  writeOffs: number;
  bills: number;
  billPayments: number;
  expenses: number;
}

const EMPTY: BackpostCounts = { invoices: 0, voids: 0, payments: 0, creditNotes: 0, writeOffs: 0, bills: 0, billPayments: 0, expenses: 0 };

/** Enqueue every journal this company's documents are missing. Returns how many of each were sent. */
export async function postMissingJournals(ctx: PluginContext, companyId: string, limit = 200): Promise<BackpostCounts> {
  const settings = await billingSettings(ctx, companyId);
  if (!(await ledgerOn(ctx, companyId, settings))) return { ...EMPTY };
  const counts = { ...EMPTY };
  const n = Math.max(1, Math.min(limit, 1000));
  const invoiceCache = new Map<string, InvoiceRow | null>();
  const invoice = async (id: string) => {
    if (!invoiceCache.has(id)) invoiceCache.set(id, await getInvoice(ctx, id));
    return invoiceCache.get(id) ?? null;
  };

  // Invoices sent without their issue journal.
  const issued = await ctx.db.query<InvoiceRow>(
    `SELECT ${INVOICE_COLUMNS} FROM ${table(ctx, "invoices")}
      WHERE company_id = $1 AND status NOT IN ('draft', 'cancelled') AND ledger_status IS NULL AND total_minor > 0
      ORDER BY sent_at NULLS LAST, created_at LIMIT ${n}`,
    [companyId],
  );
  for (const row of issued) {
    await postInvoiceIssue(ctx, row, settings);
    invoiceCache.set(row.id, row);
    counts.invoices += 1;
  }

  // Invoices whose issue journal went out but whose void did not.
  const voided = await ctx.db.query<InvoiceRow>(
    `SELECT ${INVOICE_COLUMNS.split(",").map((c) => `i.${c.trim()}`).join(", ")} FROM ${table(ctx, "invoices")} i
      WHERE i.company_id = $1 AND i.status = 'cancelled' AND i.ledger_status IS NOT NULL AND i.sent_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM ${table(ctx, "outbox")} o WHERE o.key = 'billing:invoice:' || i.id || ':void')
      LIMIT ${n}`,
    [companyId],
  );
  for (const row of voided) {
    await postInvoiceVoid(ctx, row, settings);
    counts.voids += 1;
  }

  // Payments.
  const payments = await ctx.db.query<PaymentRow>(
    `SELECT ${PAYMENT_COLUMNS.split(",").map((c) => `p.${c.trim()}`).join(", ")} FROM ${table(ctx, "payments")} p
       JOIN ${table(ctx, "invoices")} i ON i.id = p.invoice_id
      WHERE p.company_id = $1 AND p.ledger_status IS NULL AND i.status <> 'draft'
      ORDER BY p.paid_at LIMIT ${n}`,
    [companyId],
  );
  for (const payment of payments) {
    const inv = await invoice(payment.invoice_id);
    if (!inv) continue;
    await postPayment(ctx, inv, payment, settings);
    counts.payments += 1;
  }

  // Credit notes.
  const notes = await ctx.db.query<Pick<CreditNoteRow, "id" | "invoice_id" | "number" | "amount_minor" | "created_at">>(
    `SELECT id, invoice_id, number, amount_minor, created_at FROM ${table(ctx, "credit_notes")}
      WHERE company_id = $1 AND ledger_status IS NULL ORDER BY created_at LIMIT ${n}`,
    [companyId],
  );
  for (const note of notes) {
    const inv = await invoice(note.invoice_id);
    if (!inv) continue;
    await postCreditNote(ctx, { id: note.id, number: note.number ?? `CN-${note.id.slice(0, 8)}`, amount_minor: note.amount_minor, created_at: note.created_at }, inv, settings);
    counts.creditNotes += 1;
  }

  // Write-offs (their journal key is on the invoice).
  const writeOffs = await ctx.db.query<{ invoice_id: string; amount_minor: string | number }>(
    `SELECT a.invoice_id, a.amount_minor FROM ${table(ctx, "credit_applications")} a
      WHERE a.company_id = $1 AND a.source_kind = 'write_off'
        AND NOT EXISTS (SELECT 1 FROM ${table(ctx, "outbox")} o WHERE o.key = 'billing:invoice:' || a.invoice_id || ':write_off')
      LIMIT ${n}`,
    [companyId],
  );
  for (const row of writeOffs) {
    const inv = await invoice(row.invoice_id);
    if (!inv) continue;
    await postWriteOff(ctx, inv, Number(row.amount_minor), null, settings);
    counts.writeOffs += 1;
  }

  // Approved bills and their payments.
  const bills = await ctx.db.query<{ id: string }>(
    `SELECT id FROM ${table(ctx, "bills")}
      WHERE company_id = $1 AND status IN ('approved', 'partially_paid', 'paid') AND ledger_status IS NULL AND total_minor > 0
      ORDER BY approved_at NULLS LAST, created_at LIMIT ${n}`,
    [companyId],
  );
  for (const row of bills) {
    const bill = await getBill(ctx, row.id);
    if (!bill) continue;
    await postBill(ctx, bill, await billLines(ctx, bill.id), settings);
    counts.bills += 1;
  }
  const billPayments = await ctx.db.query<{ id: string; bill_id: string; amount_minor: string | number; paid_at: unknown; bank_tx_id: string | null }>(
    `SELECT p.id, p.bill_id, p.amount_minor, p.paid_at, p.bank_tx_id FROM ${table(ctx, "bill_payments")} p
      WHERE p.company_id = $1 AND p.ledger_status IS NULL ORDER BY p.paid_at LIMIT ${n}`,
    [companyId],
  );
  for (const payment of billPayments) {
    const bill = await getBill(ctx, payment.bill_id);
    if (!bill) continue;
    await postBillPayment(ctx, bill, payment, settings);
    counts.billPayments += 1;
  }

  // Recorded expenses never posted (first version).
  const expenses = await ctx.db.query<ExpenseRow>(
    `SELECT id, company_id, description, amount_minor, currency, category, incurred_on, vendor, tax_code, vat_minor, vat_claimable, paid_from, fx_rate, status, ledger_version, ledger_status
       FROM ${table(ctx, "expenses")}
      WHERE company_id = $1 AND status = 'recorded' AND ledger_version = 0 AND ledger_status IS NULL AND amount_minor > 0
      ORDER BY incurred_on NULLS LAST, created_at LIMIT ${n}`,
    [companyId],
  );
  for (const expense of expenses) {
    if (await postExpense(ctx, forPosting(expense), 1, settings, null)) counts.expenses += 1;
  }
  return counts;
}

export function backpostTotal(counts: BackpostCounts): number {
  return Object.values(counts).reduce((sum, value) => sum + value, 0);
}

