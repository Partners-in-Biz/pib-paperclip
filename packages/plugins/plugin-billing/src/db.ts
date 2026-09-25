import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";

export function table(ctx: PluginContext, name: string): string {
  if (!/^plugin_[a-z0-9_]+$/.test(ctx.db.namespace) || !/^[a-z_]+$/.test(name)) throw new Error("Unsafe identifier");
  return `${ctx.db.namespace}.${name}`;
}

export interface InvoiceRow {
  id: string;
  company_id: string;
  number: string;
  status: "draft" | "sent" | "viewed" | "paid" | "overdue" | "cancelled";
  currency: string;
  customer_kind: string;
  customer_ref: string;
  sender: unknown;
  customer: unknown;
  sender_snapshot: unknown;
  customer_snapshot: unknown;
  total_minor: number | string;
  tax_rate: number | string;
  due_at: unknown;
  approval_issue_id: string | null;
  pending_action: string | null;
  sent_at: unknown;
}

export async function listInvoices(ctx: PluginContext, companyId: string): Promise<InvoiceRow[]> {
  return ctx.db.query<InvoiceRow>(
    `SELECT id, company_id, number, status, currency, customer_kind, customer_ref, sender, customer,
            sender_snapshot, customer_snapshot, total_minor, tax_rate, due_at, approval_issue_id, pending_action, sent_at
       FROM ${table(ctx, "invoices")}
      WHERE company_id = $1
         OR id IN (
              SELECT invoice_id FROM ${table(ctx, "invoice_grants")} WHERE grantee_company_id = $1
            )
      ORDER BY created_at DESC`,
    [companyId],
  );
}

export async function getInvoice(ctx: PluginContext, id: string): Promise<InvoiceRow | null> {
  const rows = await ctx.db.query<InvoiceRow>(
    `SELECT id, company_id, number, status, currency, customer_kind, customer_ref, sender, customer,
            sender_snapshot, customer_snapshot, total_minor, tax_rate, due_at, approval_issue_id, pending_action, sent_at
       FROM ${table(ctx, "invoices")} WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function insertInvoice(ctx: PluginContext, row: InvoiceRow): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "invoices")}
      (id, company_id, number, status, currency, customer_kind, customer_ref, sender, customer, total_minor, tax_rate, due_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12)`,
    [
      row.id,
      row.company_id,
      row.number,
      row.status,
      row.currency,
      row.customer_kind,
      row.customer_ref,
      JSON.stringify(row.sender ?? {}),
      JSON.stringify(row.customer ?? {}),
      Number(row.total_minor),
      Number(row.tax_rate ?? 0),
      row.due_at,
    ],
  );
}

export async function insertLine(
  ctx: PluginContext,
  input: { companyId: string; invoiceId: string; description: string; quantity: number; unitAmountMinor: number },
): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "invoice_lines")}
      (id, company_id, invoice_id, description, quantity, unit_amount_minor)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), input.companyId, input.invoiceId, input.description, input.quantity, input.unitAmountMinor],
  );
}

export async function linesFor(ctx: PluginContext, invoiceId: string): Promise<Array<{ quantity: number; unit_amount_minor: number | string }>> {
  return ctx.db.query(
    `SELECT quantity, unit_amount_minor FROM ${table(ctx, "invoice_lines")} WHERE invoice_id = $1`,
    [invoiceId],
  );
}

export async function saveTotalsAndStatus(
  ctx: PluginContext,
  invoice: InvoiceRow,
): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "invoices")}
        SET status = $2, total_minor = $3, tax_rate = $4, sender_snapshot = $5::jsonb, customer_snapshot = $6::jsonb,
            approval_issue_id = $7, pending_action = $8, sent_at = $9, updated_at = now()
      WHERE id = $1`,
    [
      invoice.id,
      invoice.status,
      Number(invoice.total_minor),
      Number(invoice.tax_rate ?? 0),
      invoice.sender_snapshot == null ? null : JSON.stringify(invoice.sender_snapshot),
      invoice.customer_snapshot == null ? null : JSON.stringify(invoice.customer_snapshot),
      invoice.approval_issue_id,
      invoice.pending_action,
      invoice.sent_at,
    ],
  );
}

export async function invoiceByApproval(ctx: PluginContext, issueId: string): Promise<InvoiceRow | null> {
  const rows = await ctx.db.query<InvoiceRow>(
    `SELECT id, company_id, number, status, currency, customer_kind, customer_ref, sender, customer,
            sender_snapshot, customer_snapshot, total_minor, tax_rate, due_at, approval_issue_id, pending_action, sent_at
       FROM ${table(ctx, "invoices")} WHERE approval_issue_id = $1 LIMIT 1`,
    [issueId],
  );
  return rows[0] ?? null;
}

export async function markOverdue(ctx: PluginContext): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "invoices")}
        SET status = 'overdue', updated_at = now()
      WHERE status IN ('sent', 'viewed') AND due_at IS NOT NULL AND due_at < now()`,
  );
}

export async function insertGrant(ctx: PluginContext, input: { companyId: string; invoiceId: string; granteeCompanyId: string }): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "invoice_grants")} (id, company_id, invoice_id, grantee_company_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (invoice_id, grantee_company_id) DO NOTHING`,
    [randomUUID(), input.companyId, input.invoiceId, input.granteeCompanyId],
  );
}

export async function grantsForInvoice(ctx: PluginContext, invoiceId: string): Promise<Array<{ grantee_company_id: string }>> {
  return ctx.db.query(
    `SELECT grantee_company_id FROM ${table(ctx, "invoice_grants")} WHERE invoice_id = $1`,
    [invoiceId],
  );
}

export function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

export interface QuoteRow {
  id: string;
  company_id: string;
  number: string;
  status: string;
  currency: string;
  customer_kind: string;
  customer_ref: string;
  sender: unknown;
  customer: unknown;
  total_minor: number | string;
  tax_rate: number | string;
  valid_until: unknown;
  converted_invoice_id: string | null;
}

export interface ExpenseRow {
  id: string;
  company_id: string;
  description: string;
  amount_minor: number | string;
  currency: string;
  category: string;
  incurred_on: unknown;
}

export async function listQuotes(ctx: PluginContext, companyId: string): Promise<QuoteRow[]> {
  return ctx.db.query<QuoteRow>(
    `SELECT id, company_id, number, status, currency, customer_kind, customer_ref, sender, customer,
            total_minor, tax_rate, valid_until, converted_invoice_id
       FROM ${table(ctx, "quotes")}
      WHERE company_id = $1
      ORDER BY created_at DESC`,
    [companyId],
  );
}

export async function getQuote(ctx: PluginContext, id: string): Promise<QuoteRow | null> {
  const rows = await ctx.db.query<QuoteRow>(
    `SELECT id, company_id, number, status, currency, customer_kind, customer_ref, sender, customer,
            total_minor, tax_rate, valid_until, converted_invoice_id
       FROM ${table(ctx, "quotes")} WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function insertQuote(ctx: PluginContext, row: QuoteRow): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "quotes")}
      (id, company_id, number, status, currency, customer_kind, customer_ref, sender, customer, total_minor, tax_rate, valid_until)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12)`,
    [
      row.id,
      row.company_id,
      row.number,
      row.status,
      row.currency,
      row.customer_kind,
      row.customer_ref,
      JSON.stringify(row.sender ?? {}),
      JSON.stringify(row.customer ?? {}),
      Number(row.total_minor),
      Number(row.tax_rate ?? 0),
      row.valid_until,
    ],
  );
}

export async function insertQuoteLine(
  ctx: PluginContext,
  input: { companyId: string; quoteId: string; description: string; quantity: number; unitAmountMinor: number },
): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "quote_lines")}
      (id, company_id, quote_id, description, quantity, unit_amount_minor)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), input.companyId, input.quoteId, input.description, input.quantity, input.unitAmountMinor],
  );
}

export async function quoteLinesFor(ctx: PluginContext, quoteId: string): Promise<Array<{ quantity: number; unit_amount_minor: number | string }>> {
  return ctx.db.query(
    `SELECT quantity, unit_amount_minor FROM ${table(ctx, "quote_lines")} WHERE quote_id = $1`,
    [quoteId],
  );
}

export async function saveQuoteStatus(
  ctx: PluginContext,
  quote: QuoteRow,
): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "quotes")}
        SET status = $2, total_minor = $3, tax_rate = $4, converted_invoice_id = $5, updated_at = now()
      WHERE id = $1`,
    [quote.id, quote.status, Number(quote.total_minor), Number(quote.tax_rate ?? 0), quote.converted_invoice_id],
  );
}

export async function listExpenses(ctx: PluginContext, companyId: string): Promise<ExpenseRow[]> {
  return ctx.db.query<ExpenseRow>(
    `SELECT id, company_id, description, amount_minor, currency, category, incurred_on
       FROM ${table(ctx, "expenses")}
      WHERE company_id = $1
      ORDER BY incurred_on DESC NULLS LAST, created_at DESC`,
    [companyId],
  );
}

export async function insertExpense(ctx: PluginContext, expense: ExpenseRow): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "expenses")}
      (id, company_id, description, amount_minor, currency, category, incurred_on)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [expense.id, expense.company_id, expense.description, Number(expense.amount_minor), expense.currency, expense.category, expense.incurred_on],
  );
}

export async function listInvoiceNumbers(ctx: PluginContext, companyId: string): Promise<string[]> {
  const rows = await ctx.db.query<{ number: string }>(
    `SELECT number FROM ${table(ctx, "invoices")} WHERE company_id = $1`,
    [companyId],
  );
  return rows.map((row) => row.number);
}

export async function listQuoteNumbers(ctx: PluginContext, companyId: string): Promise<string[]> {
  const rows = await ctx.db.query<{ number: string }>(
    `SELECT number FROM ${table(ctx, "quotes")} WHERE company_id = $1`,
    [companyId],
  );
  return rows.map((row) => row.number);
}

export interface RecurringRow {
  id: string;
  company_id: string;
  template_invoice_id: string;
  frequency: string;
  next_run_at: unknown;
  is_active: boolean;
}

export async function listRecurring(ctx: PluginContext, companyId: string): Promise<RecurringRow[]> {
  return ctx.db.query<RecurringRow>(
    `SELECT id, company_id, template_invoice_id, frequency, next_run_at, is_active
       FROM ${table(ctx, "recurring_invoices")}
      WHERE company_id = $1
      ORDER BY next_run_at`,
    [companyId],
  );
}

export async function getRecurring(ctx: PluginContext, id: string): Promise<RecurringRow | null> {
  const rows = await ctx.db.query<RecurringRow>(
    `SELECT id, company_id, template_invoice_id, frequency, next_run_at, is_active
       FROM ${table(ctx, "recurring_invoices")} WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function insertRecurring(ctx: PluginContext, row: RecurringRow): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "recurring_invoices")}
      (id, company_id, template_invoice_id, frequency, next_run_at, is_active)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [row.id, row.company_id, row.template_invoice_id, row.frequency, row.next_run_at, row.is_active],
  );
}

export async function saveRecurring(ctx: PluginContext, row: RecurringRow): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "recurring_invoices")}
        SET next_run_at = $2, is_active = $3, updated_at = now()
      WHERE id = $1`,
    [row.id, row.next_run_at, row.is_active],
  );
}

export async function dueRecurring(ctx: PluginContext): Promise<RecurringRow[]> {
  return ctx.db.query<RecurringRow>(
    `SELECT id, company_id, template_invoice_id, frequency, next_run_at, is_active
       FROM ${table(ctx, "recurring_invoices")}
      WHERE is_active = true AND next_run_at <= now()`,
  );
}

export interface PaymentRow {
  id: string;
  company_id: string;
  invoice_id: string;
  amount_minor: number | string;
  method: string;
  reference: string | null;
  paid_at: unknown;
}

export async function insertPayment(ctx: PluginContext, payment: PaymentRow): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "payments")}
      (id, company_id, invoice_id, amount_minor, method, reference, paid_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [payment.id, payment.company_id, payment.invoice_id, Number(payment.amount_minor), payment.method, payment.reference, payment.paid_at],
  );
}

export async function paymentsForInvoice(ctx: PluginContext, invoiceId: string): Promise<PaymentRow[]> {
  return ctx.db.query<PaymentRow>(
    `SELECT id, company_id, invoice_id, amount_minor, method, reference, paid_at
       FROM ${table(ctx, "payments")} WHERE invoice_id = $1 ORDER BY paid_at`,
    [invoiceId],
  );
}

export interface CreditNoteRow {
  id: string;
  company_id: string;
  invoice_id: string;
  amount_minor: number | string;
  reason: string;
  status: string;
  created_at: unknown;
}

export async function insertCreditNote(ctx: PluginContext, note: CreditNoteRow): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "credit_notes")} (id, company_id, invoice_id, amount_minor, reason, status)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [note.id, note.company_id, note.invoice_id, Number(note.amount_minor), note.reason, note.status],
  );
}

export async function listCreditNotes(ctx: PluginContext, companyId: string): Promise<CreditNoteRow[]> {
  return ctx.db.query<CreditNoteRow>(
    `SELECT id, company_id, invoice_id, amount_minor, reason, status, created_at
       FROM ${table(ctx, "credit_notes")} WHERE company_id = $1 ORDER BY created_at DESC`,
    [companyId],
  );
}
