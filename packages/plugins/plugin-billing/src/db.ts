import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { textArrayParam, type ClientRef, type ClientScope } from "@partnersinbiz/pib-plugin-kit";

export function table(ctx: PluginContext, name: string): string {
  if (!/^plugin_[a-z0-9_]+$/.test(ctx.db.namespace) || !/^[a-z_]+$/.test(name)) throw new Error("Unsafe identifier");
  return `${ctx.db.namespace}.${name}`;
}

export type InvoiceStatus =
  | "draft"
  | "sent"
  | "viewed"
  | "payment_pending_verification"
  | "partially_paid"
  | "paid"
  | "overdue"
  | "cancelled"
  | "written_off";

export interface InvoiceRow {
  id: string;
  company_id: string;
  number: string;
  status: InvoiceStatus;
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
  created_at?: unknown;
  updated_at?: unknown;
  default_tax_code?: string | null;
  prices_include_vat?: boolean | null;
  notes?: string | null;
  subtotal_minor?: number | string | null;
  vat_minor?: number | string | null;
  paid_at?: unknown;
  fx_rate?: number | string | null;
  send_to?: unknown;
  delivery_key?: string | null;
  delivery_status?: string | null;
  delivery_error?: string | null;
  mail_seq?: number | string | null;
  pdf_key?: string | null;
  ledger_status?: string | null;
  ledger_error?: string | null;
  issue_journal?: string | null;
  recurring_id?: string | null;
  recurring_key?: string | null;
  subscription_id?: string | null;
  quote_id?: string | null;
  cancelled_at?: unknown;
  void_reason?: string | null;
  /** The CRM deal this invoice bills (copied from its quote, or set when it was drafted). */
  deal_id?: string | null;
}

export const INVOICE_COLUMNS = `id, company_id, number, status, currency, customer_kind, customer_ref, sender, customer,
            sender_snapshot, customer_snapshot, total_minor, tax_rate, due_at, approval_issue_id, pending_action, sent_at,
            created_at, updated_at, default_tax_code, prices_include_vat, notes, subtotal_minor, vat_minor, paid_at, fx_rate,
            send_to, delivery_key, delivery_status, delivery_error, mail_seq, pdf_key, ledger_status, ledger_error, issue_journal,
            recurring_id, recurring_key, subscription_id, quote_id, cancelled_at, void_reason, deal_id`;

/**
 * SQL filter for one billing customer (a CRM company or contact). `n` is the
 * next free `$` index.
 */
export function customerWhere(customer: ClientRef, n: number, alias = ""): { sql: string; params: unknown[] } {
  const col = (name: string) => (alias ? `${alias}.${name}` : name);
  return { sql: `${col("customer_kind")} = $${n} AND ${col("customer_ref")} = $${n + 1}`, params: [customer.kind, customer.id] };
}

/** Every invoice this company may see, or only one customer's when `customer` is set. */
export async function listInvoices(ctx: PluginContext, companyId: string, customer: ClientScope = null): Promise<InvoiceRow[]> {
  const filter = customer ? customerWhere(customer, 2) : null;
  return ctx.db.query<InvoiceRow>(
    `SELECT ${INVOICE_COLUMNS}
       FROM ${table(ctx, "invoices")}
      WHERE (company_id = $1
         OR id IN (
              SELECT invoice_id FROM ${table(ctx, "invoice_grants")} WHERE grantee_company_id = $1
            ))${filter ? ` AND ${filter.sql}` : ""}
      ORDER BY created_at DESC`,
    [companyId, ...(filter?.params ?? [])],
  );
}

export async function getInvoice(ctx: PluginContext, id: string): Promise<InvoiceRow | null> {
  const rows = await ctx.db.query<InvoiceRow>(
    `SELECT ${INVOICE_COLUMNS}
       FROM ${table(ctx, "invoices")} WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function insertInvoice(ctx: PluginContext, row: InvoiceRow): Promise<number> {
  const res = await ctx.db.execute(
    `INSERT INTO ${table(ctx, "invoices")}
      (id, company_id, number, status, currency, customer_kind, customer_ref, sender, customer, total_minor, tax_rate, due_at,
       default_tax_code, prices_include_vat, notes, subtotal_minor, vat_minor, send_to, recurring_id, recurring_key, subscription_id, quote_id, deal_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19, $20, $21, $22, $23)
     ON CONFLICT DO NOTHING`,
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
      row.due_at ?? null,
      row.default_tax_code ?? null,
      Boolean(row.prices_include_vat),
      row.notes ?? null,
      Number(row.subtotal_minor ?? 0),
      Number(row.vat_minor ?? 0),
      row.send_to == null ? null : JSON.stringify(row.send_to),
      row.recurring_id ?? null,
      row.recurring_key ?? null,
      row.subscription_id ?? null,
      row.quote_id ?? null,
      row.deal_id ?? null,
    ],
  );
  return res.rowCount ?? 0;
}

export interface LineRow {
  id: string;
  description: string;
  quantity: number;
  unit_amount_minor: number | string;
  tax_code?: string | null;
  net_minor?: number | string | null;
  vat_minor?: number | string | null;
  gross_minor?: number | string | null;
  time_entry_id?: string | null;
}

export async function insertLine(
  ctx: PluginContext,
  input: { companyId: string; invoiceId: string; description: string; quantity: number; unitAmountMinor: number; taxCode?: string | null; timeEntryId?: string | null; id?: string },
): Promise<string> {
  const id = input.id ?? randomUUID();
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "invoice_lines")}
      (id, company_id, invoice_id, description, quantity, unit_amount_minor, tax_code, time_entry_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, input.companyId, input.invoiceId, input.description, input.quantity, input.unitAmountMinor, input.taxCode ?? null, input.timeEntryId ?? null],
  );
  return id;
}

export async function linesFor(ctx: PluginContext, invoiceId: string): Promise<LineRow[]> {
  return ctx.db.query(
    `SELECT id, description, quantity, unit_amount_minor, tax_code, net_minor, vat_minor, gross_minor, time_entry_id
       FROM ${table(ctx, "invoice_lines")} WHERE invoice_id = $1 ORDER BY created_at, id`,
    [invoiceId],
  );
}

export async function saveLineAmounts(
  ctx: PluginContext,
  lineTable: "invoice_lines" | "quote_lines" | "bill_lines",
  lineId: string,
  amounts: { netMinor: number; vatMinor: number; grossMinor: number },
): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, lineTable)} SET net_minor = $2, vat_minor = $3, gross_minor = $4 WHERE id = $1`,
    [lineId, amounts.netMinor, amounts.vatMinor, amounts.grossMinor],
  );
}

/**
 * Store a draft's computed totals and pricing fields only. Approval, status and
 * snapshot columns are left alone, so a line edit never undoes a send request
 * (or a send) that happened meanwhile.
 */
export async function saveInvoiceTotals(ctx: PluginContext, invoice: InvoiceRow): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "invoices")}
        SET total_minor = $2, subtotal_minor = $3, vat_minor = $4, tax_rate = $5, default_tax_code = $6, prices_include_vat = $7, updated_at = now()
      WHERE id = $1 AND status = 'draft'`,
    [
      invoice.id,
      Number(invoice.total_minor),
      Number(invoice.subtotal_minor ?? 0),
      Number(invoice.vat_minor ?? 0),
      Number(invoice.tax_rate ?? 0),
      invoice.default_tax_code ?? null,
      Boolean(invoice.prices_include_vat),
    ],
  );
}

export async function invoiceByApproval(ctx: PluginContext, issueId: string): Promise<InvoiceRow | null> {
  const rows = await ctx.db.query<InvoiceRow>(
    `SELECT ${INVOICE_COLUMNS}
       FROM ${table(ctx, "invoices")} WHERE approval_issue_id = $1 LIMIT 1`,
    [issueId],
  );
  return rows[0] ?? null;
}

/**
 * Sent or viewed invoices past due become overdue. Partly paid invoices and
 * those waiting on proof-of-payment checks keep their status (ageing and
 * reminders read the due date).
 */
/** Sent/viewed invoices past their due time → overdue, except for companies in `skipCompanyIds` (module off). */
export async function markOverdue(ctx: PluginContext, skipCompanyIds: string[] = []): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "invoices")}
        SET status = 'overdue', updated_at = now()
      WHERE status IN ('sent', 'viewed') AND due_at IS NOT NULL AND due_at < now()
        AND NOT (company_id = ANY(${textArrayParam(1)}))`,
    [JSON.stringify(skipCompanyIds)],
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

export function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
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
  created_at?: unknown;
  default_tax_code?: string | null;
  prices_include_vat?: boolean | null;
  notes?: string | null;
  subtotal_minor?: number | string | null;
  vat_minor?: number | string | null;
  send_to?: unknown;
  approval_issue_id?: string | null;
  pending_action?: string | null;
  sent_at?: unknown;
  delivery_key?: string | null;
  delivery_status?: string | null;
  delivery_error?: string | null;
  mail_seq?: number | string | null;
  pdf_key?: string | null;
  /** The CRM deal this quote belongs to. */
  deal_id?: string | null;
  accepted_at?: unknown;
  updated_at?: unknown;
}

const QUOTE_COLUMNS = `id, company_id, number, status, currency, customer_kind, customer_ref, sender, customer,
            total_minor, tax_rate, valid_until, converted_invoice_id, created_at, default_tax_code, prices_include_vat, notes,
            subtotal_minor, vat_minor, send_to, approval_issue_id, pending_action, sent_at, delivery_key, delivery_status,
            delivery_error, mail_seq, pdf_key, deal_id, accepted_at, updated_at`;

export interface ExpenseRow {
  id: string;
  company_id: string;
  description: string;
  amount_minor: number | string;
  currency: string;
  category: string;
  incurred_on: unknown;
  vendor?: string | null;
  supplier_kind?: string | null;
  supplier_ref?: string | null;
  tax_code?: string | null;
  vat_minor?: number | string | null;
  vat_claimable?: boolean | null;
  paid_from?: string | null;
  status?: string | null;
  receipt_key?: string | null;
  receipt_name?: string | null;
  receipt_mime?: string | null;
  extraction?: unknown;
  needs_review?: boolean | null;
  billable?: boolean | null;
  customer_kind?: string | null;
  customer_ref?: string | null;
  invoice_id?: string | null;
  fx_rate?: number | string | null;
  ledger_version?: number | string | null;
  ledger_status?: string | null;
  journal_number?: string | null;
  created_by?: string | null;
}

export async function listQuotes(ctx: PluginContext, companyId: string, customer: ClientScope = null): Promise<QuoteRow[]> {
  const filter = customer ? customerWhere(customer, 2) : null;
  return ctx.db.query<QuoteRow>(
    `SELECT ${QUOTE_COLUMNS}
       FROM ${table(ctx, "quotes")}
      WHERE company_id = $1${filter ? ` AND ${filter.sql}` : ""}
      ORDER BY created_at DESC`,
    [companyId, ...(filter?.params ?? [])],
  );
}

export async function getQuote(ctx: PluginContext, id: string): Promise<QuoteRow | null> {
  const rows = await ctx.db.query<QuoteRow>(
    `SELECT ${QUOTE_COLUMNS}
       FROM ${table(ctx, "quotes")} WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function quoteByApproval(ctx: PluginContext, issueId: string): Promise<QuoteRow | null> {
  const rows = await ctx.db.query<QuoteRow>(
    `SELECT ${QUOTE_COLUMNS} FROM ${table(ctx, "quotes")} WHERE approval_issue_id = $1 LIMIT 1`,
    [issueId],
  );
  return rows[0] ?? null;
}

export async function insertQuote(ctx: PluginContext, row: QuoteRow): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "quotes")}
      (id, company_id, number, status, currency, customer_kind, customer_ref, sender, customer, total_minor, tax_rate, valid_until,
       default_tax_code, prices_include_vat, notes, subtotal_minor, vat_minor, deal_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
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
      row.valid_until ?? null,
      row.default_tax_code ?? null,
      Boolean(row.prices_include_vat),
      row.notes ?? null,
      Number(row.subtotal_minor ?? 0),
      Number(row.vat_minor ?? 0),
      row.deal_id ?? null,
    ],
  );
}

export async function insertQuoteLine(
  ctx: PluginContext,
  input: { companyId: string; quoteId: string; description: string; quantity: number; unitAmountMinor: number; taxCode?: string | null },
): Promise<string> {
  const id = randomUUID();
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "quote_lines")}
      (id, company_id, quote_id, description, quantity, unit_amount_minor, tax_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, input.companyId, input.quoteId, input.description, input.quantity, input.unitAmountMinor, input.taxCode ?? null],
  );
  return id;
}

export async function quoteLinesFor(ctx: PluginContext, quoteId: string): Promise<LineRow[]> {
  return ctx.db.query(
    `SELECT id, description, quantity, unit_amount_minor, tax_code, net_minor, vat_minor, gross_minor
       FROM ${table(ctx, "quote_lines")} WHERE quote_id = $1 ORDER BY created_at, id`,
    [quoteId],
  );
}

export async function saveQuoteStatus(
  ctx: PluginContext,
  quote: QuoteRow,
): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "quotes")}
        SET status = $2, total_minor = $3, tax_rate = $4, converted_invoice_id = $5, subtotal_minor = $6, vat_minor = $7,
            approval_issue_id = $8, pending_action = $9, sent_at = $10, default_tax_code = $11, prices_include_vat = $12,
            accepted_at = $13, updated_at = now()
      WHERE id = $1`,
    [
      quote.id,
      quote.status,
      Number(quote.total_minor),
      Number(quote.tax_rate ?? 0),
      quote.converted_invoice_id,
      Number(quote.subtotal_minor ?? 0),
      Number(quote.vat_minor ?? 0),
      quote.approval_issue_id ?? null,
      quote.pending_action ?? null,
      quote.sent_at ?? null,
      quote.default_tax_code ?? null,
      Boolean(quote.prices_include_vat),
      quote.accepted_at ?? null,
    ],
  );
}

const EXPENSE_COLUMNS = `id, company_id, description, amount_minor, currency, category, incurred_on, vendor, supplier_kind, supplier_ref,
            tax_code, vat_minor, vat_claimable, paid_from, status, receipt_key, receipt_name, receipt_mime, extraction, needs_review,
            billable, customer_kind, customer_ref, invoice_id, fx_rate, ledger_version, ledger_status, journal_number, created_by`;

export async function listExpenses(ctx: PluginContext, companyId: string): Promise<ExpenseRow[]> {
  return ctx.db.query<ExpenseRow>(
    `SELECT ${EXPENSE_COLUMNS}
       FROM ${table(ctx, "expenses")}
      WHERE company_id = $1
      ORDER BY incurred_on DESC NULLS LAST, created_at DESC`,
    [companyId],
  );
}

export async function getExpense(ctx: PluginContext, id: string): Promise<ExpenseRow | null> {
  const rows = await ctx.db.query<ExpenseRow>(`SELECT ${EXPENSE_COLUMNS} FROM ${table(ctx, "expenses")} WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function insertExpense(ctx: PluginContext, expense: ExpenseRow): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "expenses")}
      (id, company_id, description, amount_minor, currency, category, incurred_on, vendor, supplier_kind, supplier_ref, tax_code,
       vat_minor, vat_claimable, paid_from, status, receipt_key, receipt_name, receipt_mime, extraction, needs_review, billable,
       customer_kind, customer_ref, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb, $20, $21, $22, $23, $24)`,
    [
      expense.id,
      expense.company_id,
      expense.description,
      Number(expense.amount_minor),
      expense.currency,
      expense.category,
      expense.incurred_on ?? null,
      expense.vendor ?? null,
      expense.supplier_kind ?? null,
      expense.supplier_ref ?? null,
      expense.tax_code ?? null,
      Number(expense.vat_minor ?? 0),
      Boolean(expense.vat_claimable),
      expense.paid_from ?? "bank",
      expense.status ?? "recorded",
      expense.receipt_key ?? null,
      expense.receipt_name ?? null,
      expense.receipt_mime ?? null,
      expense.extraction == null ? null : JSON.stringify(expense.extraction),
      Boolean(expense.needs_review),
      Boolean(expense.billable),
      expense.customer_kind ?? null,
      expense.customer_ref ?? null,
      expense.created_by ?? null,
    ],
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
  auto_send?: boolean | null;
  ends_at?: unknown;
  last_invoice_id?: string | null;
}

const RECURRING_COLUMNS = "id, company_id, template_invoice_id, frequency, next_run_at, is_active, auto_send, ends_at, last_invoice_id";

/** Recurring schedules; with `customer`, only those whose template invoice bills that customer. */
export async function listRecurring(ctx: PluginContext, companyId: string, customer: ClientScope = null): Promise<RecurringRow[]> {
  if (!customer) {
    return ctx.db.query<RecurringRow>(
      `SELECT ${RECURRING_COLUMNS}
         FROM ${table(ctx, "recurring_invoices")}
        WHERE company_id = $1
        ORDER BY next_run_at`,
      [companyId],
    );
  }
  const filter = customerWhere(customer, 2, "i");
  return ctx.db.query<RecurringRow>(
    `SELECT r.id, r.company_id, r.template_invoice_id, r.frequency, r.next_run_at, r.is_active, r.auto_send, r.ends_at, r.last_invoice_id
       FROM ${table(ctx, "recurring_invoices")} r
       JOIN ${table(ctx, "invoices")} i ON i.id = r.template_invoice_id
      WHERE r.company_id = $1 AND ${filter.sql}
      ORDER BY r.next_run_at`,
    [companyId, ...filter.params],
  );
}

export async function getRecurring(ctx: PluginContext, id: string): Promise<RecurringRow | null> {
  const rows = await ctx.db.query<RecurringRow>(
    `SELECT ${RECURRING_COLUMNS}
       FROM ${table(ctx, "recurring_invoices")} WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function insertRecurring(ctx: PluginContext, row: RecurringRow): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "recurring_invoices")}
      (id, company_id, template_invoice_id, frequency, next_run_at, is_active, auto_send, ends_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [row.id, row.company_id, row.template_invoice_id, row.frequency, row.next_run_at, row.is_active, Boolean(row.auto_send), row.ends_at ?? null],
  );
}

export async function saveRecurring(ctx: PluginContext, row: RecurringRow): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "recurring_invoices")}
        SET next_run_at = $2, is_active = $3, last_invoice_id = COALESCE($4, last_invoice_id), updated_at = now()
      WHERE id = $1`,
    [row.id, row.next_run_at, row.is_active, row.last_invoice_id ?? null],
  );
}

export async function dueRecurring(ctx: PluginContext): Promise<RecurringRow[]> {
  return ctx.db.query<RecurringRow>(
    `SELECT ${RECURRING_COLUMNS}
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
  allocated_minor?: number | string | null;
  source?: string | null;
  source_key?: string | null;
  bank_tx_id?: string | null;
  pop_id?: string | null;
  currency?: string | null;
  customer_kind?: string | null;
  customer_ref?: string | null;
  fx_rate?: number | string | null;
  ledger_status?: string | null;
  journal_number?: string | null;
  created_by?: string | null;
  created_at?: unknown;
}

export const PAYMENT_COLUMNS = `id, company_id, invoice_id, amount_minor, method, reference, paid_at, allocated_minor, source, source_key,
            bank_tx_id, pop_id, currency, customer_kind, customer_ref, fx_rate, ledger_status, journal_number, created_by, created_at`;

export async function paymentsForInvoice(ctx: PluginContext, invoiceId: string): Promise<PaymentRow[]> {
  return ctx.db.query<PaymentRow>(
    `SELECT ${PAYMENT_COLUMNS}
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
  number?: string | null;
  currency?: string | null;
  customer_kind?: string | null;
  customer_ref?: string | null;
  issued_on?: unknown;
  pdf_key?: string | null;
  delivery_key?: string | null;
  delivery_status?: string | null;
  delivery_error?: string | null;
  mail_seq?: number | string | null;
  ledger_status?: string | null;
  journal_number?: string | null;
  created_by?: string | null;
}

const CREDIT_NOTE_COLUMNS = `id, company_id, invoice_id, amount_minor, reason, status, created_at, number, currency, customer_kind, customer_ref,
            issued_on::text AS issued_on, pdf_key, delivery_key, delivery_status, delivery_error, mail_seq, ledger_status, journal_number, created_by`;

export async function insertCreditNote(ctx: PluginContext, note: CreditNoteRow): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "credit_notes")} (id, company_id, invoice_id, amount_minor, reason, status, number, currency, customer_kind, customer_ref, issued_on, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      note.id,
      note.company_id,
      note.invoice_id,
      Number(note.amount_minor),
      note.reason,
      note.status,
      note.number ?? null,
      note.currency ?? null,
      note.customer_kind ?? null,
      note.customer_ref ?? null,
      note.issued_on ?? null,
      note.created_by ?? null,
    ],
  );
}

export async function getCreditNote(ctx: PluginContext, id: string): Promise<CreditNoteRow | null> {
  const rows = await ctx.db.query<CreditNoteRow>(`SELECT ${CREDIT_NOTE_COLUMNS} FROM ${table(ctx, "credit_notes")} WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/** Credit notes; with `customer`, only those against that customer's invoices. */
export async function listCreditNotes(ctx: PluginContext, companyId: string, customer: ClientScope = null): Promise<CreditNoteRow[]> {
  if (!customer) {
    return ctx.db.query<CreditNoteRow>(
      `SELECT ${CREDIT_NOTE_COLUMNS}
         FROM ${table(ctx, "credit_notes")} WHERE company_id = $1 ORDER BY created_at DESC`,
      [companyId],
    );
  }
  const filter = customerWhere(customer, 2, "i");
  return ctx.db.query<CreditNoteRow>(
    `SELECT n.id, n.company_id, n.invoice_id, n.amount_minor, n.reason, n.status, n.created_at, n.number, n.currency, n.customer_kind,
            n.customer_ref, n.issued_on::text AS issued_on, n.pdf_key, n.delivery_key, n.delivery_status, n.delivery_error, n.mail_seq, n.ledger_status,
            n.journal_number, n.created_by
       FROM ${table(ctx, "credit_notes")} n
       JOIN ${table(ctx, "invoices")} i ON i.id = n.invoice_id
      WHERE n.company_id = $1 AND ${filter.sql}
      ORDER BY n.created_at DESC`,
    [companyId, ...filter.params],
  );
}

/**
 * "As at today": the start of tomorrow (UTC). Money dated on or after it is
 * in the future and counts in no balance, total or chart until its day
 * comes; it is flagged instead. Accounting uses the same day (UTC), so the
 * two modules agree.
 */
export const AS_AT_CUTOFF_SQL = `((date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC')`;

/**
 * When one customer last paid, as at today (a payment dated later does not
 * count yet). A legacy invoice marked paid without a recorded payment counts
 * as paid when it was last updated.
 */
export async function customerLastPaidAt(ctx: PluginContext, companyId: string, customer: ClientRef): Promise<string | null> {
  const payments = customerWhere(customer, 2, "p");
  const invoices = customerWhere(customer, 2, "i");
  const rows = await ctx.db.query<{ at: unknown }>(
    `SELECT GREATEST(
              (SELECT max(p.paid_at) FROM ${table(ctx, "payments")} p WHERE p.company_id = $1 AND ${payments.sql} AND p.paid_at < ${AS_AT_CUTOFF_SQL}),
              (SELECT max(COALESCE(i.paid_at, i.updated_at)) FROM ${table(ctx, "invoices")} i
                WHERE i.company_id = $1 AND ${invoices.sql} AND i.status = 'paid'
                  AND NOT EXISTS (SELECT 1 FROM ${table(ctx, "payments")} x WHERE x.invoice_id = i.id))
            ) AS at`,
    [companyId, ...payments.params],
  );
  const at = rows[0]?.at;
  if (at == null || at === "") return null;
  const parsed = at instanceof Date ? at : new Date(String(at));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Company ids that have billing rows (jobs have no company scope). Quotes count: a company that only quoted still gets its "Drafts to send". */
export async function billingCompanyIds(ctx: PluginContext): Promise<string[]> {
  const rows = await ctx.db.query<{ company_id: string }>(
    `SELECT company_id FROM ${table(ctx, "invoices")}
      UNION SELECT company_id FROM ${table(ctx, "quotes")}
      UNION SELECT company_id FROM ${table(ctx, "bills")}
      UNION SELECT company_id FROM ${table(ctx, "expenses")}
      UNION SELECT company_id FROM ${table(ctx, "subscriptions")}`,
  );
  return [...new Set(rows.map((row) => row.company_id).filter(Boolean))];
}
