/**
 * One `settle()` for every way money arrives: a person recording it, a
 * confirmed proof of payment, a payment approval, and a bank match from
 * Accounting.
 *
 * - Idempotent by `sourceKey` (bank tx id, POP id, manual id): the payment
 *   row has a unique (company, source_key); a repeat finishes the side
 *   effects (status, credit notes, journal, open item) without a new row.
 * - The allocation is computed inside the INSERT from what the invoice owes
 *   at that moment: a partial payment leaves it partly paid, a top-up pays
 *   it, an overpayment allocates what was owed and the rest stays with the
 *   customer as credit.
 * - A bank line that matches an earlier POP/manual payment of the same
 *   amount reconciles that payment instead of counting the money twice.
 * - The invoice's own unapplied credit notes are applied.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { applyCredit, applyOwnCreditNotes, invoiceBalance, refreshInvoiceStatus, syncCreditNoteStatus } from "./balances.js";
import type { BillingSettings } from "./config.js";
import { getInvoice, PAYMENT_COLUMNS, table, type InvoiceRow, type PaymentRow } from "./db.js";
import { assertPaymentAmount, BillingError, isOpenStatus } from "./domain.js";
import { emitBillItem, emitInvoiceItem } from "./openitems.js";
import { postBillPayment, postCreditNote, postPayment, postWriteOff, repostPaymentOnBank, type BillForPosting } from "./posting.js";

export type SettleSource = "manual" | "pop" | "bank" | "approval";

export interface SettleInput {
  companyId: string;
  invoiceId: string;
  amountMinor: number;
  sourceKey: string;
  source: SettleSource;
  paidAt?: string | null;
  method?: string | null;
  reference?: string | null;
  bankTxId?: string | null;
  bankAccountRole?: "bank" | "cash";
  /** Accounting's account code for the matched bank account. */
  bankAccountCode?: string | null;
  popId?: string | null;
  createdBy?: string | null;
}

export interface SettleResult {
  paymentId: string;
  invoiceId: string;
  invoiceNumber: string;
  repeat: boolean;
  reconciled: boolean;
  amountMinor: number;
  allocatedMinor: number;
  creditMinor: number;
  outstandingMinor: number;
  status: string;
  confirmedPopIds: string[];
}

const OPEN_LIST = "'sent', 'viewed', 'overdue', 'partially_paid', 'payment_pending_verification'";

export async function paymentBySourceKey(ctx: PluginContext, companyId: string, sourceKey: string): Promise<PaymentRow | null> {
  const rows = await ctx.db.query<PaymentRow>(
    `SELECT ${PAYMENT_COLUMNS} FROM ${table(ctx, "payments")} WHERE company_id = $1 AND source_key = $2`,
    [companyId, sourceKey],
  );
  return rows[0] ?? null;
}

async function paymentById(ctx: PluginContext, id: string): Promise<PaymentRow | null> {
  const rows = await ctx.db.query<PaymentRow>(`SELECT ${PAYMENT_COLUMNS} FROM ${table(ctx, "payments")} WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/** An earlier POP/manual/approval payment of the same amount with no bank line yet. */
export async function unreconciledPayment(ctx: PluginContext, invoiceId: string, amountMinor: number): Promise<PaymentRow | null> {
  const rows = await ctx.db.query<PaymentRow>(
    `SELECT ${PAYMENT_COLUMNS} FROM ${table(ctx, "payments")}
      WHERE invoice_id = $1 AND bank_tx_id IS NULL AND source IN ('manual', 'pop', 'approval') AND amount_minor = $2
      ORDER BY paid_at LIMIT 1`,
    [invoiceId, amountMinor],
  );
  return rows[0] ?? null;
}

function paidAtOf(value: string | null | undefined): string {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new BillingError("paidAt must be a date");
  return parsed.toISOString();
}

export async function settle(ctx: PluginContext, input: SettleInput, settings: BillingSettings, now = new Date()): Promise<SettleResult> {
  const amount = assertPaymentAmount(input.amountMinor);
  const sourceKey = String(input.sourceKey ?? "").trim();
  if (!sourceKey || sourceKey.length > 200) throw new BillingError("A payment source key is required");
  const invoice = await getInvoice(ctx, input.invoiceId);
  if (!invoice || invoice.company_id !== input.companyId) throw new BillingError("Invoice was not found");

  let payment = await paymentBySourceKey(ctx, input.companyId, sourceKey);
  let reconciled = false;
  if (!payment && input.bankTxId) {
    // The bank line may already sit on a payment it reconciled earlier.
    const rows = await ctx.db.query<PaymentRow>(
      `SELECT ${PAYMENT_COLUMNS} FROM ${table(ctx, "payments")} WHERE company_id = $1 AND bank_tx_id = $2 AND invoice_id = $3 LIMIT 1`,
      [input.companyId, input.bankTxId, invoice.id],
    );
    if (rows[0]) {
      payment = rows[0];
      reconciled = rows[0].source_key !== sourceKey;
    }
  }
  const repeat = Boolean(payment);

  if (!payment) {
    if (invoice.status === "draft") throw new BillingError("Send the invoice before recording a payment");
    if (invoice.status === "cancelled") throw new BillingError("This invoice is cancelled");
    if (input.source === "bank" && input.bankTxId) {
      const earlier = await unreconciledPayment(ctx, invoice.id, amount);
      if (earlier) {
        const res = await ctx.db.execute(
          `UPDATE ${table(ctx, "payments")} SET bank_tx_id = $2 WHERE id = $1 AND bank_tx_id IS NULL`,
          [earlier.id, input.bankTxId],
        );
        if ((res.rowCount ?? 0) > 0) {
          payment = { ...earlier, bank_tx_id: input.bankTxId };
          reconciled = true;
          await repostPaymentOnBank(ctx, invoice, earlier, settings, { bankTxId: input.bankTxId, bankAccountRole: input.bankAccountRole, bankAccountCode: input.bankAccountCode });
        }
      }
    }
  }

  if (!payment) {
    const id = randomUUID();
    await ctx.db.execute(
      `INSERT INTO ${table(ctx, "payments")}
        (id, company_id, invoice_id, amount_minor, allocated_minor, method, reference, paid_at, source, source_key, bank_tx_id, pop_id,
         currency, customer_kind, customer_ref, created_by)
       SELECT $1::text, i.company_id, i.id, $3::bigint,
              CASE WHEN i.status IN (${OPEN_LIST}) THEN LEAST($3::bigint, GREATEST(0, i.total_minor
                - COALESCE((SELECT sum(COALESCE(p.allocated_minor, p.amount_minor)) FROM ${table(ctx, "payments")} p WHERE p.invoice_id = i.id), 0)
                - COALESCE((SELECT sum(a.amount_minor) FROM ${table(ctx, "credit_applications")} a WHERE a.invoice_id = i.id), 0)))
              ELSE 0 END,
              $4::text, $5::text, $6::timestamptz, $7::text, $8::text, $9::text, $10::text, i.currency, i.customer_kind, i.customer_ref, $11::text
         FROM ${table(ctx, "invoices")} i
        WHERE i.id = $2::text
       ON CONFLICT (company_id, source_key) DO NOTHING`,
      [
        id,
        invoice.id,
        amount,
        (input.method ?? (input.source === "bank" ? "eft" : "eft")).trim().toLowerCase() || "eft",
        input.reference?.trim() || null,
        paidAtOf(input.paidAt),
        input.source,
        sourceKey,
        input.bankTxId ?? null,
        input.popId ?? null,
        input.createdBy ?? null,
      ],
    );
    payment = await paymentBySourceKey(ctx, input.companyId, sourceKey);
    if (!payment) throw new BillingError("The payment could not be recorded");
  }

  // Proofs of payment this money confirms.
  const confirmedPopIds: string[] = [];
  const popIds = input.popId ? [input.popId] : input.source === "bank" ? await pendingPopIds(ctx, invoice.id) : [];
  for (const popId of popIds) {
    const res = await ctx.db.execute(
      `UPDATE ${table(ctx, "pops")} SET status = 'confirmed', payment_id = $2, reviewed_by = $3, reviewed_at = now()
        WHERE id = $1 AND status = 'pending'`,
      [popId, payment.id, input.source === "bank" ? "bank match" : input.createdBy ?? null],
    );
    if ((res.rowCount ?? 0) > 0) confirmedPopIds.push(popId);
  }

  if (!reconciled) await applyOwnCreditNotes(ctx, invoice.id, input.createdBy);
  let refreshed = await refreshInvoiceStatus(ctx, invoice.id, now);
  // Paid in full another way (recorded, approved): proofs still waiting are settled by this money.
  if (refreshed && refreshed.balance.outstandingMinor <= 0 && !input.popId) {
    for (const popId of await pendingPopIds(ctx, invoice.id)) {
      const res = await ctx.db.execute(
        `UPDATE ${table(ctx, "pops")} SET status = 'confirmed', payment_id = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $1 AND status = 'pending'`,
        [popId, payment.id, "invoice paid"],
      );
      if ((res.rowCount ?? 0) > 0) confirmedPopIds.push(popId);
    }
    if (confirmedPopIds.length) refreshed = await refreshInvoiceStatus(ctx, invoice.id, now);
  }
  if (!reconciled) await postPayment(ctx, invoice, payment, settings, { bankAccountRole: input.bankAccountRole, bankAccountCode: input.bankAccountCode });
  await emitInvoiceItem(ctx, invoice.id);

  const allocated = Number(payment.allocated_minor ?? payment.amount_minor);
  return {
    paymentId: payment.id,
    invoiceId: invoice.id,
    invoiceNumber: invoice.number,
    repeat,
    reconciled,
    amountMinor: Number(payment.amount_minor),
    allocatedMinor: allocated,
    creditMinor: Math.max(0, Number(payment.amount_minor) - allocated),
    outstandingMinor: refreshed?.balance.outstandingMinor ?? 0,
    status: refreshed?.status ?? invoice.status,
    confirmedPopIds,
  };
}

async function pendingPopIds(ctx: PluginContext, invoiceId: string): Promise<string[]> {
  const rows = await ctx.db.query<{ id: string }>(
    `SELECT id FROM ${table(ctx, "pops")} WHERE invoice_id = $1 AND status = 'pending'`,
    [invoiceId],
  );
  return rows.map((row) => row.id);
}

// ── Credit notes, customer credit and write-offs ───────────────────────────

export async function creditedOnInvoice(ctx: PluginContext, invoiceId: string): Promise<number> {
  const rows = await ctx.db.query<{ total: string | number | null }>(
    `SELECT COALESCE(sum(amount_minor), 0) AS total FROM ${table(ctx, "credit_notes")} WHERE invoice_id = $1`,
    [invoiceId],
  );
  return Number(rows[0]?.total ?? 0);
}

/**
 * After a credit note row exists: apply it to its invoice (up to what is
 * owed; the rest is customer credit), refresh the status, post the journal
 * and share the open item.
 */
export async function afterCreditNote(
  ctx: PluginContext,
  note: { id: string; number: string; amount_minor: number | string; created_at?: unknown },
  invoice: InvoiceRow,
  settings: BillingSettings,
  createdBy?: string | null,
): Promise<{ appliedMinor: number; status: string }> {
  const applied = await applyOwnCreditNotes(ctx, invoice.id, createdBy);
  await syncCreditNoteStatus(ctx, note.id);
  const refreshed = await refreshInvoiceStatus(ctx, invoice.id);
  await postCreditNote(ctx, note, invoice, settings);
  await emitInvoiceItem(ctx, invoice.id);
  return { appliedMinor: applied, status: refreshed?.status ?? invoice.status };
}

/** Use a customer's credit (overpayment or credit-note remainder) on another invoice of theirs. */
export async function applyCustomerCredit(
  ctx: PluginContext,
  input: { companyId: string; invoiceId: string; sourceKind: "credit_note" | "payment"; sourceId: string; amountMinor?: number | null; createdBy?: string | null },
): Promise<{ appliedMinor: number; status: string }> {
  const balance = await invoiceBalance(ctx, input.invoiceId);
  if (!balance || balance.invoice.company_id !== input.companyId) throw new BillingError("Invoice was not found");
  if (!isOpenStatus(balance.invoice.status)) throw new BillingError("Credit can only be applied to an unpaid, sent invoice");
  const source = await ctx.db.query<{ customer_kind: string | null; customer_ref: string | null; currency: string | null }>(
    input.sourceKind === "credit_note"
      ? `SELECT customer_kind, customer_ref, currency FROM ${table(ctx, "credit_notes")} WHERE id = $1 AND company_id = $2`
      : `SELECT customer_kind, customer_ref, currency FROM ${table(ctx, "payments")} WHERE id = $1 AND company_id = $2`,
    [input.sourceId, input.companyId],
  );
  const row = source[0];
  if (!row) throw new BillingError("That credit was not found");
  if (row.customer_ref !== balance.invoice.customer_ref || (row.customer_kind ?? "company") !== balance.invoice.customer_kind) {
    throw new BillingError("That credit belongs to another customer");
  }
  if (row.currency && row.currency !== balance.invoice.currency) throw new BillingError("That credit is in another currency");
  const wanted = input.amountMinor == null ? balance.outstandingMinor : Math.min(assertPaymentAmount(input.amountMinor), balance.outstandingMinor);
  const available = await availableOf(ctx, input.sourceKind, input.sourceId);
  const amount = Math.min(wanted, available);
  if (amount <= 0) throw new BillingError("There is no credit left to apply");
  const ok = await applyCredit(ctx, {
    companyId: input.companyId,
    invoiceId: input.invoiceId,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    amountMinor: amount,
    key: `${input.sourceKind}:${input.sourceId}:${input.invoiceId}:${randomUUID().slice(0, 8)}`,
    createdBy: input.createdBy,
  });
  if (!ok) throw new BillingError("The credit could not be applied (the amounts changed). Try again.");
  if (input.sourceKind === "credit_note") await syncCreditNoteStatus(ctx, input.sourceId);
  const refreshed = await refreshInvoiceStatus(ctx, input.invoiceId);
  await emitInvoiceItem(ctx, input.invoiceId);
  return { appliedMinor: amount, status: refreshed?.status ?? balance.invoice.status };
}

async function availableOf(ctx: PluginContext, kind: "credit_note" | "payment", id: string): Promise<number> {
  const rows = await ctx.db.query<{ available: string | number | null }>(
    kind === "credit_note"
      ? `SELECT n.amount_minor - COALESCE((SELECT sum(a.amount_minor) FROM ${table(ctx, "credit_applications")} a WHERE a.source_kind = 'credit_note' AND a.source_id = n.id), 0) AS available
           FROM ${table(ctx, "credit_notes")} n WHERE n.id = $1`
      : `SELECT p.amount_minor - COALESCE(p.allocated_minor, p.amount_minor) - COALESCE((SELECT sum(a.amount_minor) FROM ${table(ctx, "credit_applications")} a WHERE a.source_kind = 'payment' AND a.source_id = p.id), 0) AS available
           FROM ${table(ctx, "payments")} p WHERE p.id = $1`,
    [id],
  );
  return Math.max(0, Number(rows[0]?.available ?? 0));
}

/** Write off what is left on an invoice (bad debt). */
export async function writeOff(
  ctx: PluginContext,
  input: { companyId: string; invoiceId: string; reason?: string | null; createdBy?: string | null },
  settings: BillingSettings,
): Promise<{ amountMinor: number; status: string }> {
  const balance = await invoiceBalance(ctx, input.invoiceId);
  if (!balance || balance.invoice.company_id !== input.companyId) throw new BillingError("Invoice was not found");
  if (balance.outstandingMinor <= 0) throw new BillingError("Nothing is owed on this invoice");
  const amount = balance.outstandingMinor;
  const ok = await applyCredit(ctx, {
    companyId: input.companyId,
    invoiceId: input.invoiceId,
    sourceKind: "write_off",
    sourceId: input.invoiceId,
    amountMinor: amount,
    key: `write_off:${input.invoiceId}`,
    createdBy: input.createdBy,
  });
  if (!ok) throw new BillingError("The write-off could not be recorded (the balance changed). Try again.");
  const refreshed = await refreshInvoiceStatus(ctx, input.invoiceId);
  await postWriteOff(ctx, balance.invoice, amount, input.reason ?? null, settings);
  await emitInvoiceItem(ctx, input.invoiceId);
  return { amountMinor: amount, status: refreshed?.status ?? "written_off" };
}

// ── Bills (money out) ──────────────────────────────────────────────────────

export interface BillRow extends BillForPosting {
  status: string;
  supplier_email: string | null;
  prices_include_vat: boolean | null;
  default_tax_code: string | null;
  subtotal_minor: number | string;
  vat_minor: number | string;
  due_date: unknown;
  notes: string | null;
  source: string;
  mail_message_id: string | null;
  mail_thread_id: string | null;
  file_key: string | null;
  file_name: string | null;
  file_mime: string | null;
  approval_issue_id: string | null;
  pending_action: string | null;
  paid_at: unknown;
  ledger_status: string | null;
  ledger_error: string | null;
  journal_number: string | null;
  created_by: string | null;
  created_at: unknown;
  updated_at: unknown;
}

/** Bill columns; `date` columns come back as YYYY-MM-DD text (drivers disagree on date parsing). */
export function billColumns(alias = ""): string {
  const a = alias ? `${alias}.` : "";
  return [
    "id", "company_id", "supplier_kind", "supplier_ref", "supplier_name", "supplier_email", "supplier_reference", "status", "currency",
    "prices_include_vat", "default_tax_code", "category", "subtotal_minor", "vat_minor", "total_minor",
  ].map((c) => `${a}${c}`).join(", ")
    + `, ${a}issue_date::text AS issue_date, ${a}due_date::text AS due_date, `
    + [
      "notes", "source", "mail_message_id", "mail_thread_id", "file_key", "file_name", "file_mime", "fx_rate", "approval_issue_id", "pending_action",
      "approved_at", "paid_at", "ledger_status", "ledger_error", "journal_number", "created_by", "created_at", "updated_at",
    ].map((c) => `${a}${c}`).join(", ");
}

export const BILL_COLUMNS = billColumns();

export async function getBill(ctx: PluginContext, id: string): Promise<BillRow | null> {
  const rows = await ctx.db.query<BillRow>(`SELECT ${BILL_COLUMNS} FROM ${table(ctx, "bills")} WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function billPaidMinor(ctx: PluginContext, billId: string): Promise<number> {
  const rows = await ctx.db.query<{ paid: string | number | null }>(
    `SELECT COALESCE(sum(allocated_minor), 0) AS paid FROM ${table(ctx, "bill_payments")} WHERE bill_id = $1`,
    [billId],
  );
  return Number(rows[0]?.paid ?? 0);
}

export async function refreshBillStatus(ctx: PluginContext, billId: string): Promise<string | null> {
  const bill = await getBill(ctx, billId);
  if (!bill || (bill.status !== "approved" && bill.status !== "partially_paid" && bill.status !== "paid")) return bill?.status ?? null;
  const paid = await billPaidMinor(ctx, billId);
  const next = paid >= Number(bill.total_minor) ? "paid" : paid > 0 ? "partially_paid" : "approved";
  if (next !== bill.status) {
    await ctx.db.execute(
      `UPDATE ${table(ctx, "bills")} SET status = $2, paid_at = CASE WHEN $2 = 'paid' THEN COALESCE(paid_at, now()) ELSE paid_at END, updated_at = now()
        WHERE id = $1 AND status IN ('approved', 'partially_paid', 'paid')`,
      [billId, next],
    );
  }
  return next;
}

export async function settleBill(
  ctx: PluginContext,
  input: { companyId: string; billId: string; amountMinor: number; sourceKey: string; source: SettleSource; paidAt?: string | null; method?: string | null; reference?: string | null; bankTxId?: string | null; bankAccountRole?: "bank" | "cash"; bankAccountCode?: string | null; createdBy?: string | null },
  settings: BillingSettings,
): Promise<{ paymentId: string; repeat: boolean; status: string; outstandingMinor: number }> {
  const amount = assertPaymentAmount(input.amountMinor);
  const bill = await getBill(ctx, input.billId);
  if (!bill || bill.company_id !== input.companyId) throw new BillingError("Bill was not found");
  const existing = await ctx.db.query<{ id: string; amount_minor: string | number; paid_at: unknown; bank_tx_id: string | null }>(
    `SELECT id, amount_minor, paid_at, bank_tx_id FROM ${table(ctx, "bill_payments")} WHERE company_id = $1 AND source_key = $2`,
    [input.companyId, input.sourceKey],
  );
  let payment = existing[0] ?? null;
  const repeat = Boolean(payment);
  if (!payment) {
    if (bill.status !== "approved" && bill.status !== "partially_paid") throw new BillingError("Approve the bill before paying it");
    const id = randomUUID();
    await ctx.db.execute(
      `INSERT INTO ${table(ctx, "bill_payments")}
        (id, company_id, bill_id, amount_minor, allocated_minor, method, reference, paid_at, source, source_key, bank_tx_id, currency, created_by)
       SELECT $1::text, b.company_id, b.id, $3::bigint,
              LEAST($3::bigint, GREATEST(0, b.total_minor - COALESCE((SELECT sum(p.allocated_minor) FROM ${table(ctx, "bill_payments")} p WHERE p.bill_id = b.id), 0))),
              $4::text, $5::text, $6::timestamptz, $7::text, $8::text, $9::text, b.currency, $10::text
         FROM ${table(ctx, "bills")} b
        WHERE b.id = $2::text
       ON CONFLICT (company_id, source_key) DO NOTHING`,
      [id, bill.id, amount, (input.method ?? "eft").toLowerCase(), input.reference ?? null, paidAtOf(input.paidAt), input.source, input.sourceKey, input.bankTxId ?? null, input.createdBy ?? null],
    );
    const rows = await ctx.db.query<{ id: string; amount_minor: string | number; paid_at: unknown; bank_tx_id: string | null }>(
      `SELECT id, amount_minor, paid_at, bank_tx_id FROM ${table(ctx, "bill_payments")} WHERE company_id = $1 AND source_key = $2`,
      [input.companyId, input.sourceKey],
    );
    payment = rows[0] ?? null;
    if (!payment) throw new BillingError("The payment could not be recorded");
  }
  const status = (await refreshBillStatus(ctx, bill.id)) ?? bill.status;
  await postBillPayment(ctx, bill, payment, settings, { bankAccountRole: input.bankAccountRole, bankAccountCode: input.bankAccountCode });
  await emitBillItem(ctx, bill.id);
  const paid = await billPaidMinor(ctx, bill.id);
  return { paymentId: payment.id, repeat, status, outstandingMinor: Math.max(0, Number(bill.total_minor) - paid) };
}

export { paymentById };
