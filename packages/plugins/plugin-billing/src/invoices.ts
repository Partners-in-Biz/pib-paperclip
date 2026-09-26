/**
 * Invoices and quotes: drafting with per-line VAT codes, numbering, the
 * printable document, sending through the Mailbox after approval, voiding,
 * and recurring copies that keep every field.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { getCrmCompany, getCrmContact, listCrmContactsAtCompany, type MailAddress } from "@partnersinbiz/pib-plugin-kit";
import { invoiceBalance, iso, refreshInvoiceStatus } from "./balances.js";
import { defaultTaxCode, emailEnabled, loadBilling, privateR2, type BillingSettings } from "./config.js";
import {
  asArray,
  asObject,
  getInvoice,
  getQuote,
  grantsForInvoice,
  insertInvoice,
  insertLine,
  insertQuote,
  insertQuoteLine,
  linesFor,
  quoteLinesFor,
  saveLineAmounts,
  saveQuoteStatus,
  saveTotalsAndStatus,
  table,
  type InvoiceRow,
  type LineRow,
  type QuoteRow,
} from "./db.js";
import { docFileName, renderDocument, type DocKind, type DocView } from "./documents.js";
import { BillingError, canSeeInvoice, isOpenStatus, markSent, nextRunDate, type InvoiceState, type RecurringFrequency } from "./domain.js";
import { invoiceEmail, parseAddresses, queueMail, quoteEmail, type EmailContent, type MailKind } from "./mail.js";
import { assertTaxCode, computeDocument, isTaxCodeValue, type DocumentTotals } from "./money.js";
import { nextDocumentNumber } from "./numbering.js";
import { emitInvoiceItem } from "./openitems.js";
import { postInvoiceIssue, postInvoiceVoid } from "./posting.js";
import { documentKey, MAIL_LINK_SECONDS, presignGet, putObject } from "./storage.js";
import { actorLabel, currencyCode, integer, optionalBoolean, optionalDate, optionalString, requiredCompany, requiredString, requirePerson } from "./util.js";

// ── Parties ────────────────────────────────────────────────────────────────

export function senderFrom(settings: BillingSettings, override: string | undefined): Record<string, unknown> {
  const base = settings.sender && typeof settings.sender === "object" ? { ...settings.sender } : {};
  if (override) base.name = override;
  if (typeof base.name !== "string" || !base.name.trim()) base.name = "Partners in Biz";
  return base;
}

/** Customer name + details from the CRM projection, falling back to what the caller passed. */
export async function customerFrom(
  ctx: PluginContext,
  companyId: string,
  kind: "company" | "contact",
  ref: string,
  explicitName: string | undefined,
  explicitEmail?: string,
): Promise<Record<string, unknown>> {
  const customer: Record<string, unknown> = { refKind: kind, refId: ref };
  if (kind === "company") {
    const record = await getCrmCompany(ctx, ctx.db.namespace, companyId, ref).catch(() => null);
    if (record) customer.name = record.name;
  } else {
    const record = await getCrmContact(ctx, ctx.db.namespace, companyId, ref).catch(() => null);
    if (record) {
      customer.name = record.name;
      if (record.emails[0]) customer.email = record.emails[0];
    }
  }
  if (explicitName) customer.name = explicitName;
  if (explicitEmail) customer.email = explicitEmail;
  if (typeof customer.name !== "string" || !customer.name) {
    throw new BillingError("customerName is required (the customer is not in the CRM client list yet)");
  }
  return customer;
}

export function defaultDueAt(settings: BillingSettings, from = Date.now()): string | null {
  const days = Number(settings.defaultDueDays ?? 0);
  if (!Number.isFinite(days) || days <= 0) return null;
  return new Date(from + days * 86_400_000).toISOString();
}

export function defaultTax(settings: BillingSettings): number {
  const rate = Number(settings.defaultTaxRate ?? 0);
  return Number.isFinite(rate) && rate >= 0 && rate <= 100 ? rate : 0;
}

export function customerNameOf(value: unknown): string | null {
  const record = asObject(value);
  return typeof record.name === "string" ? record.name : null;
}

/** Who gets the email: the invoice's `send_to`, the customer's email, else billing contacts at the company. */
export async function recipientsFor(
  ctx: PluginContext,
  companyId: string,
  doc: { customer_kind: string; customer_ref: string; customer: unknown; customer_snapshot?: unknown; send_to?: unknown },
): Promise<MailAddress[]> {
  const explicit = parseAddresses(asArray(doc.send_to));
  if (explicit.length) return explicit;
  const customer = asObject(doc.customer_snapshot ?? doc.customer);
  const direct = parseAddresses(typeof customer.email === "string" ? customer.email : "");
  if (direct.length) return direct.map((a) => ({ ...a, name: typeof customer.name === "string" ? customer.name : null }));
  if (doc.customer_kind === "company") {
    const contacts = await listCrmContactsAtCompany(ctx, ctx.db.namespace, companyId, doc.customer_ref).catch(() => []);
    const withEmail = contacts.filter((c) => c.emails[0]);
    const billing = withEmail.filter((c) => c.tags.some((t) => /bill|account|financ|invoice/i.test(t)));
    const pick = (billing.length ? billing : withEmail).slice(0, 2);
    return pick.map((c) => ({ email: c.emails[0]!.toLowerCase(), name: c.name }));
  }
  if (doc.customer_kind === "contact") {
    const contact = await getCrmContact(ctx, ctx.db.namespace, companyId, doc.customer_ref).catch(() => null);
    if (contact?.emails[0]) return [{ email: contact.emails[0].toLowerCase(), name: contact.name }];
  }
  return [];
}

// ── Access ─────────────────────────────────────────────────────────────────

export async function requireInvoice(ctx: PluginContext, companyId: string, id: string): Promise<InvoiceRow> {
  const invoice = await getInvoice(ctx, id);
  if (!invoice) throw new BillingError("Invoice was not found");
  const grants = await grantsForInvoice(ctx, invoice.id);
  if (!canSeeInvoice(companyId, invoice.company_id, grants.map((grant) => ({ granteeCompanyId: grant.grantee_company_id })))) {
    throw new BillingError("Invoice is not visible");
  }
  return invoice;
}

/** Invoices shared by a partner are read-only for the partner. */
export async function requireOwnInvoice(ctx: PluginContext, companyId: string, id: string): Promise<InvoiceRow> {
  const invoice = await requireInvoice(ctx, companyId, id);
  if (invoice.company_id !== companyId) throw new BillingError("Only the company that issued this invoice can change it");
  return invoice;
}

export async function requireQuote(ctx: PluginContext, companyId: string, id: string): Promise<QuoteRow> {
  const quote = await getQuote(ctx, id);
  if (!quote) throw new BillingError("Quote was not found");
  if (quote.company_id !== companyId) throw new BillingError("Quote is not visible");
  return quote;
}

export function assertEditableInvoice(invoice: InvoiceRow): void {
  if (invoice.status !== "draft") throw new BillingError("Lines can only be added to a draft");
  if (invoice.delivery_status === "queued") throw new BillingError("This invoice is being sent. Wait for the email result, or mark it sent.");
}

// ── Totals ─────────────────────────────────────────────────────────────────

export function totalsOf(lines: LineRow[], doc: { prices_include_vat?: boolean | null; tax_rate: number | string }): DocumentTotals {
  return computeDocument(
    lines.map((line) => ({ quantity: Number(line.quantity), unitAmountMinor: Number(line.unit_amount_minor), taxCode: line.tax_code ?? null })),
    { pricesIncludeVat: Boolean(doc.prices_include_vat), taxRatePercent: Number(doc.tax_rate ?? 0) },
  );
}

/** Recompute line and document totals and store them. total_minor stays the VAT-inclusive total. */
export async function recomputeInvoice(ctx: PluginContext, invoice: InvoiceRow): Promise<DocumentTotals> {
  const lines = await linesFor(ctx, invoice.id);
  const totals = totalsOf(lines, invoice);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const amounts = totals.lines[i]!;
    if (Number(line.net_minor) !== amounts.netMinor || Number(line.vat_minor) !== amounts.vatMinor || Number(line.gross_minor) !== amounts.grossMinor) {
      await saveLineAmounts(ctx, "invoice_lines", line.id, amounts);
    }
  }
  invoice.total_minor = totals.totalMinor;
  invoice.subtotal_minor = totals.subtotalMinor;
  invoice.vat_minor = totals.vatMinor;
  await saveTotalsAndStatus(ctx, invoice);
  return totals;
}

export async function recomputeQuote(ctx: PluginContext, quote: QuoteRow): Promise<DocumentTotals> {
  const lines = await quoteLinesFor(ctx, quote.id);
  const totals = totalsOf(lines, quote);
  for (let i = 0; i < lines.length; i += 1) {
    const amounts = totals.lines[i]!;
    const line = lines[i]!;
    if (Number(line.net_minor) !== amounts.netMinor || Number(line.vat_minor) !== amounts.vatMinor || Number(line.gross_minor) !== amounts.grossMinor) {
      await saveLineAmounts(ctx, "quote_lines", line.id, amounts);
    }
  }
  quote.total_minor = totals.totalMinor;
  quote.subtotal_minor = totals.subtotalMinor;
  quote.vat_minor = totals.vatMinor;
  await saveQuoteStatus(ctx, quote);
  return totals;
}

function lineTaxCode(params: Record<string, unknown>, fallback: string | null | undefined): string | null {
  const raw = params.taxCode;
  if (raw == null || raw === "") return fallback && isTaxCodeValue(fallback) ? fallback : null;
  return assertTaxCode(raw);
}

// ── Invoices ───────────────────────────────────────────────────────────────

export async function createInvoice(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const currency = currencyCode(requiredString(params, "currency"));
  const customerKind = requiredString(params, "customerKind");
  if (customerKind !== "company" && customerKind !== "contact") throw new BillingError("Customer is a company or a contact");
  const { settings } = await loadBilling(ctx, companyId);
  const customerRef = requiredString(params, "customerRef");
  const customer = await customerFrom(ctx, companyId, customerKind, customerRef, optionalString(params, "customerName"), optionalString(params, "customerEmail"));
  const pricesIncludeVat = optionalBoolean(params, "pricesIncludeVat") ?? Boolean(settings.pricesIncludeVat);
  const taxCode = params.taxCode != null && params.taxCode !== "" ? assertTaxCode(params.taxCode) : defaultTaxCode(settings);
  const row: InvoiceRow = {
    id: randomUUID(),
    company_id: companyId,
    number: await nextDocumentNumber(ctx, companyId, "invoice", { kind: customerKind, ref: customerRef, name: String(customer.name) }, settings),
    status: "draft",
    currency,
    customer_kind: customerKind,
    customer_ref: customerRef,
    sender: senderFrom(settings, optionalString(params, "senderName")),
    customer,
    sender_snapshot: null,
    customer_snapshot: null,
    total_minor: 0,
    tax_rate: defaultTax(settings),
    due_at: optionalDate(params, "dueAt") ?? defaultDueAt(settings),
    approval_issue_id: null,
    pending_action: null,
    sent_at: null,
    default_tax_code: taxCode,
    prices_include_vat: pricesIncludeVat,
    notes: optionalString(params, "notes") ?? null,
    send_to: params.sendTo != null ? parseAddresses(params.sendTo) : null,
  };
  await insertInvoice(ctx, row);
  return publicInvoice(row);
}

export async function addLine(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const invoice = await requireOwnInvoice(ctx, companyId, requiredString(params, "invoiceId"));
  assertEditableInvoice(invoice);
  const quantity = integer(params.quantity, "quantity");
  const unitAmountMinor = integer(params.unitAmountMinor, "unitAmountMinor");
  if (quantity < 1) throw new BillingError("Quantity must be a positive integer");
  if (unitAmountMinor < 0) throw new BillingError("Unit amount must be a non-negative integer in minor units");
  const lineId = await insertLine(ctx, {
    companyId: invoice.company_id,
    invoiceId: invoice.id,
    description: requiredString(params, "description"),
    quantity,
    unitAmountMinor,
    taxCode: lineTaxCode(params, invoice.default_tax_code),
  });
  await recomputeInvoice(ctx, invoice);
  return { ...publicInvoice(invoice), lineId };
}

export async function updateLine(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const invoice = await requireOwnInvoice(ctx, companyId, requiredString(params, "invoiceId"));
  assertEditableInvoice(invoice);
  const lineId = requiredString(params, "lineId");
  const line = (await linesFor(ctx, invoice.id)).find((l) => l.id === lineId);
  if (!line) throw new BillingError("Line was not found");
  const quantity = params.quantity == null ? Number(line.quantity) : integer(params.quantity, "quantity");
  const unit = params.unitAmountMinor == null ? Number(line.unit_amount_minor) : integer(params.unitAmountMinor, "unitAmountMinor");
  if (quantity < 1 || unit < 0) throw new BillingError("Quantity must be positive and the unit amount not negative");
  const description = optionalString(params, "description") ?? line.description;
  const taxCode = "taxCode" in params ? (params.taxCode == null || params.taxCode === "" ? null : assertTaxCode(params.taxCode)) : line.tax_code ?? null;
  await ctx.db.execute(
    `UPDATE ${table(ctx, "invoice_lines")} SET description = $3, quantity = $4, unit_amount_minor = $5, tax_code = $6 WHERE id = $1 AND invoice_id = $2`,
    [lineId, invoice.id, description, quantity, unit, taxCode],
  );
  await recomputeInvoice(ctx, invoice);
  return publicInvoice(invoice);
}

export async function removeLine(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const invoice = await requireOwnInvoice(ctx, companyId, requiredString(params, "invoiceId"));
  assertEditableInvoice(invoice);
  const lineId = requiredString(params, "lineId");
  // A line billed from a time entry releases the entry.
  await ctx.db.execute(`UPDATE ${table(ctx, "time_entries")} SET invoice_id = NULL, bill_token = NULL, updated_at = now() WHERE invoice_id = $1 AND id IN (SELECT time_entry_id FROM ${table(ctx, "invoice_lines")} WHERE id = $2)`, [invoice.id, lineId]);
  await ctx.db.execute(`DELETE FROM ${table(ctx, "invoice_lines")} WHERE id = $1 AND invoice_id = $2`, [lineId, invoice.id]);
  await recomputeInvoice(ctx, invoice);
  return publicInvoice(invoice);
}

export async function updateInvoice(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const invoice = await requireOwnInvoice(ctx, companyId, requiredString(params, "invoiceId"));
  const draftOnly = ["currency", "pricesIncludeVat", "defaultTaxCode", "customerName"].some((key) => key in params);
  if (draftOnly) assertEditableInvoice(invoice);
  if (invoice.status === "cancelled") throw new BillingError("This invoice is cancelled");
  const dueAt = "dueAt" in params ? optionalDate(params, "dueAt") ?? null : iso(invoice.due_at);
  const notes = "notes" in params ? optionalString(params, "notes") ?? null : invoice.notes ?? null;
  const sendTo = "sendTo" in params ? parseAddresses(params.sendTo) : parseAddresses(asArray(invoice.send_to));
  const currency = "currency" in params ? currencyCode(params.currency) : invoice.currency;
  const pricesIncludeVat = optionalBoolean(params, "pricesIncludeVat") ?? Boolean(invoice.prices_include_vat);
  const defaultCode = "defaultTaxCode" in params ? (params.defaultTaxCode ? assertTaxCode(params.defaultTaxCode) : null) : invoice.default_tax_code ?? null;
  const customer = asObject(invoice.customer);
  if (optionalString(params, "customerName")) customer.name = optionalString(params, "customerName");
  await ctx.db.execute(
    `UPDATE ${table(ctx, "invoices")}
        SET due_at = $2, notes = $3, send_to = $4::jsonb, currency = $5, prices_include_vat = $6, default_tax_code = $7, customer = $8::jsonb, updated_at = now()
      WHERE id = $1`,
    [invoice.id, dueAt, notes, JSON.stringify(sendTo), currency, pricesIncludeVat, defaultCode, JSON.stringify(customer)],
  );
  const fresh = (await getInvoice(ctx, invoice.id))!;
  if (fresh.status === "draft") await recomputeInvoice(ctx, fresh);
  else {
    await refreshInvoiceStatus(ctx, fresh.id);
    await emitInvoiceItem(ctx, fresh.id);
  }
  return publicInvoice((await getInvoice(ctx, invoice.id))!);
}

/**
 * The 0.2 "one VAT rate for the whole invoice" tool: sets the rate and clears
 * per-line codes so the rate applies to every line (legacy totals).
 */
export async function setInvoiceTax(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>, rate: number) {
  const companyId = requiredCompany(context);
  const invoice = await requireOwnInvoice(ctx, companyId, requiredString(params, "invoiceId"));
  if (invoice.status !== "draft") throw new BillingError("Tax can only be set on a draft invoice");
  invoice.tax_rate = rate;
  invoice.default_tax_code = null;
  await ctx.db.execute(`UPDATE ${table(ctx, "invoice_lines")} SET tax_code = NULL WHERE invoice_id = $1`, [invoice.id]);
  await recomputeInvoice(ctx, invoice);
  return { invoiceId: invoice.id, taxRate: rate, totalMinor: Number(invoice.total_minor) };
}

export function publicInvoice(invoice: InvoiceRow) {
  return {
    id: invoice.id,
    number: invoice.number,
    status: invoice.status,
    currency: invoice.currency,
    customerKind: invoice.customer_kind,
    customerRef: invoice.customer_ref,
    customerName: customerNameOf(invoice.customer_snapshot ?? invoice.customer),
    taxRate: Number(invoice.tax_rate ?? 0),
    defaultTaxCode: invoice.default_tax_code ?? null,
    pricesIncludeVat: Boolean(invoice.prices_include_vat),
    dueAt: iso(invoice.due_at),
    sentAt: iso(invoice.sent_at),
    paidAt: iso(invoice.paid_at),
    subtotalMinor: Number(invoice.subtotal_minor ?? 0),
    vatMinor: Number(invoice.vat_minor ?? 0),
    totalMinor: Number(invoice.total_minor),
    pendingAction: invoice.pending_action,
    approvalIssueId: invoice.approval_issue_id,
    deliveryStatus: invoice.delivery_status ?? null,
    deliveryError: invoice.delivery_error ?? null,
    ledgerStatus: invoice.ledger_status ?? null,
    ledgerError: invoice.ledger_error ?? null,
    journalNumber: invoice.issue_journal ?? null,
    notes: invoice.notes ?? null,
    sendTo: parseAddresses(asArray(invoice.send_to)),
    recurringId: invoice.recurring_id ?? null,
    subscriptionId: invoice.subscription_id ?? null,
  };
}

// ── Quotes ─────────────────────────────────────────────────────────────────

export async function createQuote(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const currency = currencyCode(requiredString(params, "currency"));
  const customerKind = requiredString(params, "customerKind");
  if (customerKind !== "company" && customerKind !== "contact") throw new BillingError("Customer is a company or a contact");
  const { settings } = await loadBilling(ctx, companyId);
  const customerRef = requiredString(params, "customerRef");
  const customer = await customerFrom(ctx, companyId, customerKind, customerRef, optionalString(params, "customerName"), optionalString(params, "customerEmail"));
  const row: QuoteRow = {
    id: randomUUID(),
    company_id: companyId,
    number: await nextDocumentNumber(ctx, companyId, "quote", { kind: customerKind, ref: customerRef, name: String(customer.name) }, settings),
    status: "draft",
    currency,
    customer_kind: customerKind,
    customer_ref: customerRef,
    sender: senderFrom(settings, optionalString(params, "senderName")),
    customer,
    total_minor: 0,
    tax_rate: defaultTax(settings),
    valid_until: optionalDate(params, "validUntil") ?? null,
    converted_invoice_id: null,
    default_tax_code: params.taxCode ? assertTaxCode(params.taxCode) : defaultTaxCode(settings),
    prices_include_vat: optionalBoolean(params, "pricesIncludeVat") ?? Boolean(settings.pricesIncludeVat),
    notes: optionalString(params, "notes") ?? null,
  };
  await insertQuote(ctx, row);
  return publicQuote(row);
}

function assertEditableQuote(quote: QuoteRow): void {
  if (quote.status !== "draft") throw new BillingError("Lines can only be added to a draft quote");
  if (quote.delivery_status === "queued") throw new BillingError("This quote is being sent");
}

export async function addQuoteLine(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const quote = await requireQuote(ctx, companyId, requiredString(params, "quoteId"));
  assertEditableQuote(quote);
  const quantity = integer(params.quantity, "quantity");
  const unitAmountMinor = integer(params.unitAmountMinor, "unitAmountMinor");
  if (quantity < 1 || unitAmountMinor < 0) throw new BillingError("Quantity must be positive and the unit amount not negative");
  const lineId = await insertQuoteLine(ctx, {
    companyId: quote.company_id,
    quoteId: quote.id,
    description: requiredString(params, "description"),
    quantity,
    unitAmountMinor,
    taxCode: lineTaxCode(params, quote.default_tax_code),
  });
  await recomputeQuote(ctx, quote);
  return { ...publicQuote(quote), lineId };
}

export async function updateQuoteLine(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const quote = await requireQuote(ctx, companyId, requiredString(params, "quoteId"));
  assertEditableQuote(quote);
  const lineId = requiredString(params, "lineId");
  const line = (await quoteLinesFor(ctx, quote.id)).find((l) => l.id === lineId);
  if (!line) throw new BillingError("Line was not found");
  const quantity = params.quantity == null ? Number(line.quantity) : integer(params.quantity, "quantity");
  const unit = params.unitAmountMinor == null ? Number(line.unit_amount_minor) : integer(params.unitAmountMinor, "unitAmountMinor");
  if (quantity < 1 || unit < 0) throw new BillingError("Quantity must be positive and the unit amount not negative");
  const taxCode = "taxCode" in params ? (params.taxCode ? assertTaxCode(params.taxCode) : null) : line.tax_code ?? null;
  await ctx.db.execute(
    `UPDATE ${table(ctx, "quote_lines")} SET description = $3, quantity = $4, unit_amount_minor = $5, tax_code = $6 WHERE id = $1 AND quote_id = $2`,
    [lineId, quote.id, optionalString(params, "description") ?? line.description, quantity, unit, taxCode],
  );
  await recomputeQuote(ctx, quote);
  return publicQuote(quote);
}

export async function removeQuoteLine(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const quote = await requireQuote(ctx, companyId, requiredString(params, "quoteId"));
  assertEditableQuote(quote);
  await ctx.db.execute(`DELETE FROM ${table(ctx, "quote_lines")} WHERE id = $1 AND quote_id = $2`, [requiredString(params, "lineId"), quote.id]);
  await recomputeQuote(ctx, quote);
  return publicQuote(quote);
}

export async function updateQuote(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const quote = await requireQuote(ctx, companyId, requiredString(params, "quoteId"));
  if (quote.status !== "draft" && ["currency", "pricesIncludeVat", "defaultTaxCode"].some((k) => k in params)) throw new BillingError("Only a draft quote can change");
  await ctx.db.execute(
    `UPDATE ${table(ctx, "quotes")}
        SET valid_until = $2, notes = $3, send_to = $4::jsonb, currency = $5, prices_include_vat = $6, default_tax_code = $7, updated_at = now()
      WHERE id = $1`,
    [
      quote.id,
      "validUntil" in params ? optionalDate(params, "validUntil") ?? null : iso(quote.valid_until),
      "notes" in params ? optionalString(params, "notes") ?? null : quote.notes ?? null,
      JSON.stringify("sendTo" in params ? parseAddresses(params.sendTo) : parseAddresses(asArray(quote.send_to))),
      "currency" in params ? currencyCode(params.currency) : quote.currency,
      optionalBoolean(params, "pricesIncludeVat") ?? Boolean(quote.prices_include_vat),
      "defaultTaxCode" in params ? (params.defaultTaxCode ? assertTaxCode(params.defaultTaxCode) : null) : quote.default_tax_code ?? null,
    ],
  );
  const fresh = (await getQuote(ctx, quote.id))!;
  if (fresh.status === "draft") await recomputeQuote(ctx, fresh);
  return publicQuote(fresh);
}

const QUOTE_MOVES: Record<string, string[]> = {
  draft: ["sent", "accepted", "declined", "expired"],
  sent: ["accepted", "declined", "expired"],
  accepted: ["declined"],
  declined: ["accepted"],
  expired: ["accepted", "sent"],
};

export async function setQuoteStatus(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const quote = await requireQuote(ctx, companyId, requiredString(params, "quoteId"));
  const status = requiredString(params, "status");
  if (!(QUOTE_MOVES[quote.status] ?? []).includes(status)) throw new BillingError(`A ${quote.status} quote cannot become ${status}`);
  quote.status = status;
  if (status === "sent" && !quote.sent_at) quote.sent_at = new Date().toISOString();
  await saveQuoteStatus(ctx, quote);
  return publicQuote(quote);
}

export async function convertQuote(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const quote = await requireQuote(ctx, companyId, requiredString(params, "quoteId"));
  if (quote.status !== "accepted") throw new BillingError("Only an accepted quote can be converted to an invoice");
  const { settings } = await loadBilling(ctx, companyId);
  const customer = asObject(quote.customer);
  const invoice: InvoiceRow = {
    id: randomUUID(),
    company_id: quote.company_id,
    number: await nextDocumentNumber(ctx, companyId, "invoice", { kind: quote.customer_kind, ref: quote.customer_ref, name: String(customer.name ?? quote.customer_ref) }, settings),
    status: "draft",
    currency: quote.currency,
    customer_kind: quote.customer_kind,
    customer_ref: quote.customer_ref,
    sender: asObject(quote.sender),
    customer,
    sender_snapshot: null,
    customer_snapshot: null,
    total_minor: Number(quote.total_minor),
    tax_rate: Number(quote.tax_rate ?? 0),
    due_at: defaultDueAt(settings),
    approval_issue_id: null,
    pending_action: null,
    sent_at: null,
    default_tax_code: quote.default_tax_code ?? null,
    prices_include_vat: Boolean(quote.prices_include_vat),
    notes: quote.notes ?? null,
    subtotal_minor: Number(quote.subtotal_minor ?? 0),
    vat_minor: Number(quote.vat_minor ?? 0),
    send_to: asArray(quote.send_to),
    quote_id: quote.id,
  };
  await insertInvoice(ctx, invoice);
  for (const line of await quoteLinesFor(ctx, quote.id)) {
    await insertLine(ctx, {
      companyId: quote.company_id,
      invoiceId: invoice.id,
      description: line.description,
      quantity: Number(line.quantity),
      unitAmountMinor: Number(line.unit_amount_minor),
      taxCode: line.tax_code ?? null,
    });
  }
  await recomputeInvoice(ctx, invoice);
  quote.status = "converted";
  quote.converted_invoice_id = invoice.id;
  await saveQuoteStatus(ctx, quote);
  return { quote: publicQuote(quote), invoice: publicInvoice(invoice) };
}

export function publicQuote(quote: QuoteRow) {
  return {
    id: quote.id,
    number: quote.number,
    status: quote.status,
    currency: quote.currency,
    customerKind: quote.customer_kind,
    customerRef: quote.customer_ref,
    customerName: customerNameOf(quote.customer),
    subtotalMinor: Number(quote.subtotal_minor ?? 0),
    vatMinor: Number(quote.vat_minor ?? 0),
    totalMinor: Number(quote.total_minor),
    validUntil: iso(quote.valid_until),
    convertedInvoiceId: quote.converted_invoice_id,
    defaultTaxCode: quote.default_tax_code ?? null,
    pricesIncludeVat: Boolean(quote.prices_include_vat),
    notes: quote.notes ?? null,
    pendingAction: quote.pending_action ?? null,
    approvalIssueId: quote.approval_issue_id ?? null,
    deliveryStatus: quote.delivery_status ?? null,
    deliveryError: quote.delivery_error ?? null,
    sendTo: parseAddresses(asArray(quote.send_to)),
  };
}

// ── Printable views ────────────────────────────────────────────────────────

function lineViews(lines: LineRow[], totals: DocumentTotals): DocView["lines"] {
  return lines.map((line, i) => {
    const amounts = totals.lines[i]!;
    return {
      description: line.description,
      quantity: Number(line.quantity),
      unitAmountMinor: Number(line.unit_amount_minor),
      taxCode: amounts.taxCode,
      rateBp: amounts.rateBp,
      netMinor: amounts.netMinor,
      vatMinor: amounts.vatMinor,
      grossMinor: amounts.grossMinor,
    };
  });
}

export async function invoiceView(ctx: PluginContext, invoice: InvoiceRow, settings: BillingSettings): Promise<DocView> {
  const lines = await linesFor(ctx, invoice.id);
  const totals = totalsOf(lines, invoice);
  const balance = await invoiceBalance(ctx, invoice.id);
  const sender = asObject(invoice.sender_snapshot ?? invoice.sender);
  const payment = asObject(sender.payment ?? settings.payment ?? {});
  return {
    kind: "invoice",
    number: invoice.number,
    status: invoice.status,
    currency: invoice.currency,
    issuedAt: iso(invoice.sent_at) ?? new Date().toISOString(),
    dueAt: iso(invoice.due_at),
    sender,
    customer: asObject(invoice.customer_snapshot ?? invoice.customer),
    lines: lineViews(lines, totals),
    groups: totals.groups,
    subtotalMinor: totals.subtotalMinor,
    vatMinor: totals.vatMinor,
    totalMinor: totals.totalMinor,
    pricesIncludeVat: Boolean(invoice.prices_include_vat),
    legacy: totals.legacy,
    paidMinor: balance?.state.paidMinor ?? 0,
    creditedMinor: (balance?.state.creditedMinor ?? 0) + (balance?.state.writtenOffMinor ?? 0),
    outstandingMinor: invoice.status === "draft" ? totals.totalMinor : balance?.outstandingMinor ?? totals.totalMinor,
    payment: Object.keys(payment).length ? payment : null,
    notes: invoice.notes ?? settings.invoiceNotes ?? null,
  };
}

export async function quoteView(ctx: PluginContext, quote: QuoteRow, settings: BillingSettings): Promise<DocView> {
  const lines = await quoteLinesFor(ctx, quote.id);
  const totals = totalsOf(lines, quote);
  return {
    kind: "quote",
    number: quote.number,
    status: quote.status,
    currency: quote.currency,
    issuedAt: iso(quote.sent_at) ?? iso(quote.created_at) ?? new Date().toISOString(),
    dueAt: iso(quote.valid_until),
    sender: asObject(quote.sender),
    customer: asObject(quote.customer),
    lines: lineViews(lines, totals),
    groups: totals.groups,
    subtotalMinor: totals.subtotalMinor,
    vatMinor: totals.vatMinor,
    totalMinor: totals.totalMinor,
    pricesIncludeVat: Boolean(quote.prices_include_vat),
    legacy: totals.legacy,
    notes: quote.notes ?? null,
    payment: null,
  };
}

// ── Sending ────────────────────────────────────────────────────────────────

/** Freeze sender (with today's EFT details) and customer at send time. */
function freeze(invoice: { sender: unknown; customer: unknown }, settings: BillingSettings) {
  const sender = { ...asObject(invoice.sender) };
  for (const [key, value] of Object.entries(asObject(settings.sender))) {
    if (key !== "name" && typeof value === "string" && value.trim() && !sender[key]) sender[key] = value;
  }
  if (settings.payment && typeof settings.payment === "object") sender.payment = { ...settings.payment };
  return { sender, customer: { ...asObject(invoice.customer) } };
}

/** Render the PDF and store it privately; returns a 7-day link for the Mailbox, or null without R2. */
async function storePdf(ctx: PluginContext, companyId: string, kind: DocKind, docId: string, view: DocView, settings: BillingSettings, resolver: Awaited<ReturnType<typeof loadBilling>>["resolver"]) {
  const r2 = await privateR2(resolver, settings).catch(() => null);
  if (!r2) return null;
  const bytes = await renderDocument(view);
  const filename = docFileName(view);
  const key = documentKey(r2, companyId, kind, filename, "pdf");
  await putObject(r2, key, bytes, "application/pdf");
  const tableName = kind === "invoice" ? "invoices" : kind === "quote" ? "quotes" : "credit_notes";
  await ctx.db.execute(`UPDATE ${table(ctx, tableName)} SET pdf_key = $2${kind === "invoice" ? ", pdf_at = now()" : ""} WHERE id = $1`, [docId, key]);
  return { url: presignGet(r2, key, MAIL_LINK_SECONDS, filename), filename, bytes: bytes.byteLength };
}

/** The invoice is out: status sent, journal posted, open item shared. Safe to call twice. */
export async function markInvoiceSent(ctx: PluginContext, invoiceId: string, sentAt: string | null, delivery: "sent" | "manual", settings: BillingSettings): Promise<InvoiceRow | null> {
  const invoice = await getInvoice(ctx, invoiceId);
  if (!invoice) return null;
  if (invoice.status === "draft") {
    const state: InvoiceState = {
      status: invoice.status,
      sender: asObject(invoice.sender),
      customer: asObject(invoice.customer),
      senderSnapshot: invoice.sender_snapshot == null ? null : asObject(invoice.sender_snapshot),
      customerSnapshot: invoice.customer_snapshot == null ? null : asObject(invoice.customer_snapshot),
      sentAt: null,
    };
    const sent = markSent(state, sentAt ?? new Date().toISOString());
    await ctx.db.execute(
      `UPDATE ${table(ctx, "invoices")}
          SET status = 'sent', sent_at = $2, sender_snapshot = COALESCE(sender_snapshot, $3::jsonb), customer_snapshot = COALESCE(customer_snapshot, $4::jsonb),
              delivery_status = $5, delivery_error = NULL, pending_action = NULL, updated_at = now()
        WHERE id = $1 AND status = 'draft'`,
      [invoice.id, sent.sentAt, JSON.stringify(sent.senderSnapshot), JSON.stringify(sent.customerSnapshot), delivery],
    );
  } else {
    await ctx.db.execute(`UPDATE ${table(ctx, "invoices")} SET delivery_status = $2, delivery_error = NULL, updated_at = now() WHERE id = $1`, [invoice.id, delivery]);
  }
  const fresh = await getInvoice(ctx, invoice.id);
  if (!fresh) return null;
  if (fresh.status !== "draft" && fresh.status !== "cancelled") {
    await postInvoiceIssue(ctx, fresh, settings);
    await refreshInvoiceStatus(ctx, fresh.id);
    await emitInvoiceItem(ctx, fresh.id);
  }
  return getInvoice(ctx, invoice.id);
}

export interface SendOutcome {
  mode: "queued" | "manual";
  key?: string;
  to?: MailAddress[];
  attached: boolean;
  note?: string;
}

/**
 * The send approval is done: freeze the invoice, attach the PDF (private R2)
 * and queue the email; without email (turned off, or no address) it is
 * marked sent as before.
 */
export async function startInvoiceSend(ctx: PluginContext, invoiceId: string, createdBy: string | null): Promise<SendOutcome> {
  const invoice = await getInvoice(ctx, invoiceId);
  if (!invoice) throw new BillingError("Invoice was not found");
  if (invoice.status !== "draft") throw new BillingError("Only a draft invoice can be sent");
  const { settings, resolver } = await loadBilling(ctx, invoice.company_id);
  const frozen = freeze(invoice, settings);
  await ctx.db.execute(
    `UPDATE ${table(ctx, "invoices")} SET sender_snapshot = $2::jsonb, customer_snapshot = $3::jsonb, updated_at = now() WHERE id = $1`,
    [invoice.id, JSON.stringify(frozen.sender), JSON.stringify(frozen.customer)],
  );
  invoice.sender_snapshot = frozen.sender;
  invoice.customer_snapshot = frozen.customer;
  const to = emailEnabled(settings) ? await recipientsFor(ctx, invoice.company_id, invoice) : [];
  if (!emailEnabled(settings) || to.length === 0) {
    await markInvoiceSent(ctx, invoice.id, null, "manual", settings);
    return { mode: "manual", attached: false, note: emailEnabled(settings) ? "No email address for this customer; marked sent without email." : "Email is off in Billing settings; marked sent." };
  }
  const view = await invoiceView(ctx, { ...invoice, status: "sent", sent_at: new Date().toISOString() }, settings);
  const pdf = await storePdf(ctx, invoice.company_id, "invoice", invoice.id, view, settings, resolver);
  const content = invoiceEmail(view, { hasAttachment: Boolean(pdf), signature: settings.email?.signature });
  const seq = Number(invoice.mail_seq ?? 0) + 1;
  const key = await queueDoc(ctx, invoice.company_id, "invoice", invoice.id, seq, to, content, pdf, settings, invoice, createdBy);
  await ctx.db.execute(
    `UPDATE ${table(ctx, "invoices")} SET delivery_key = $2, delivery_status = 'queued', delivery_error = NULL, mail_seq = $3, pending_action = NULL, updated_at = now() WHERE id = $1`,
    [invoice.id, key, seq],
  );
  return { mode: "queued", key, to, attached: Boolean(pdf), note: pdf ? undefined : "Add the private R2 bucket in Billing settings to attach PDFs." };
}

async function queueDoc(
  ctx: PluginContext,
  companyId: string,
  kind: MailKind,
  docId: string,
  seq: number,
  to: MailAddress[],
  content: EmailContent,
  pdf: { url: string; filename: string; bytes: number } | null,
  settings: BillingSettings,
  doc: { customer_kind: string; customer_ref: string },
  createdBy: string | null,
): Promise<string> {
  return queueMail(ctx, companyId, {
    kind,
    docId,
    seq,
    to,
    cc: parseAddresses(settings.email?.cc ?? ""),
    bcc: parseAddresses(settings.email?.bcc ?? ""),
    from: settings.email?.from?.trim() || null,
    content,
    attachments: pdf ? [{ url: pdf.url, filename: pdf.filename, mime: "application/pdf", bytes: pdf.bytes }] : [],
    clientKind: doc.customer_kind,
    clientRef: doc.customer_ref,
    createdBy,
  });
}

export async function startQuoteSend(ctx: PluginContext, quoteId: string, createdBy: string | null): Promise<SendOutcome> {
  const quote = await getQuote(ctx, quoteId);
  if (!quote) throw new BillingError("Quote was not found");
  const { settings, resolver } = await loadBilling(ctx, quote.company_id);
  const to = emailEnabled(settings) ? await recipientsFor(ctx, quote.company_id, quote) : [];
  if (!emailEnabled(settings) || to.length === 0) {
    quote.status = quote.status === "draft" ? "sent" : quote.status;
    quote.sent_at = quote.sent_at ?? new Date().toISOString();
    quote.pending_action = null;
    await saveQuoteStatus(ctx, quote);
    return { mode: "manual", attached: false, note: "Marked sent without email." };
  }
  const view = await quoteView(ctx, { ...quote, status: "sent" }, settings);
  const pdf = await storePdf(ctx, quote.company_id, "quote", quote.id, view, settings, resolver);
  const seq = Number(quote.mail_seq ?? 0) + 1;
  const key = await queueDoc(ctx, quote.company_id, "quote", quote.id, seq, to, quoteEmail(view, { hasAttachment: Boolean(pdf), signature: settings.email?.signature }), pdf, settings, quote, createdBy);
  await ctx.db.execute(
    `UPDATE ${table(ctx, "quotes")} SET delivery_key = $2, delivery_status = 'queued', delivery_error = NULL, mail_seq = $3, pending_action = NULL, updated_at = now() WHERE id = $1`,
    [quote.id, key, seq],
  );
  return { mode: "queued", key, to, attached: Boolean(pdf) };
}

/** A person marks a draft invoice sent without email (sent by hand or on WhatsApp). */
export async function markSentAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  requirePerson(context, "marking an invoice sent");
  const companyId = requiredCompany(context);
  const invoice = await requireOwnInvoice(ctx, companyId, requiredString(params, "invoiceId"));
  if (invoice.status !== "draft") throw new BillingError("Only a draft invoice can be marked sent");
  const { settings } = await loadBilling(ctx, companyId);
  const frozen = freeze(invoice, settings);
  await ctx.db.execute(`UPDATE ${table(ctx, "invoices")} SET sender_snapshot = $2::jsonb, customer_snapshot = $3::jsonb WHERE id = $1`, [invoice.id, JSON.stringify(frozen.sender), JSON.stringify(frozen.customer)]);
  const fresh = await markInvoiceSent(ctx, invoice.id, null, "manual", settings);
  return publicInvoice(fresh!);
}

/** Send again after a failure (new outbox key) or re-send a sent document. */
export async function retrySend(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const createdBy = requirePerson(context, "sending");
  const companyId = requiredCompany(context);
  const kind = requiredString(params, "kind");
  if (kind === "invoice") {
    const invoice = await requireOwnInvoice(ctx, companyId, requiredString(params, "id"));
    if (invoice.delivery_status === "queued") throw new BillingError("This invoice is already being sent");
    if (invoice.status === "draft") return startInvoiceSend(ctx, invoice.id, createdBy);
    if (invoice.status === "cancelled") throw new BillingError("This invoice is cancelled");
    const { settings, resolver } = await loadBilling(ctx, companyId);
    const to = "sendTo" in params ? parseAddresses(params.sendTo) : await recipientsFor(ctx, companyId, invoice);
    if (to.length === 0) throw new BillingError("Add an email address for this customer first");
    const view = await invoiceView(ctx, invoice, settings);
    const pdf = await storePdf(ctx, companyId, "invoice", invoice.id, view, settings, resolver);
    const seq = Number(invoice.mail_seq ?? 0) + 1;
    const key = await queueDoc(ctx, companyId, "invoice", invoice.id, seq, to, invoiceEmail(view, { hasAttachment: Boolean(pdf), signature: settings.email?.signature }), pdf, settings, invoice, createdBy);
    await ctx.db.execute(`UPDATE ${table(ctx, "invoices")} SET delivery_key = $2, delivery_status = 'queued', delivery_error = NULL, mail_seq = $3 WHERE id = $1`, [invoice.id, key, seq]);
    return { mode: "queued", key, to, attached: Boolean(pdf) };
  }
  if (kind === "quote") {
    const quote = await requireQuote(ctx, companyId, requiredString(params, "id"));
    if (quote.delivery_status === "queued") throw new BillingError("This quote is already being sent");
    return startQuoteSend(ctx, quote.id, createdBy);
  }
  throw new BillingError("kind must be invoice or quote");
}

// ── Void ───────────────────────────────────────────────────────────────────

export async function cancelInvoice(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  requirePerson(context, "cancelling an invoice");
  const companyId = requiredCompany(context);
  const invoice = await requireOwnInvoice(ctx, companyId, requiredString(params, "invoiceId"));
  if (invoice.status === "cancelled") return publicInvoice(invoice);
  const balance = await invoiceBalance(ctx, invoice.id);
  if (balance && (balance.state.paidMinor > 0 || balance.state.creditedMinor > 0)) {
    throw new BillingError("This invoice has payments or credit. Issue a credit note instead of cancelling it.");
  }
  if (invoice.delivery_status === "queued") throw new BillingError("This invoice is being sent. Wait for the email result first.");
  const reason = optionalString(params, "reason") ?? null;
  const wasIssued = invoice.status !== "draft";
  await ctx.db.execute(
    `UPDATE ${table(ctx, "invoices")} SET status = 'cancelled', cancelled_at = now(), void_reason = $2, pending_action = NULL, updated_at = now() WHERE id = $1`,
    [invoice.id, reason],
  );
  if (wasIssued) {
    const { settings } = await loadBilling(ctx, companyId);
    await postInvoiceVoid(ctx, invoice, settings);
    await emitInvoiceItem(ctx, invoice.id);
  }
  return publicInvoice((await getInvoice(ctx, invoice.id))!);
}

// ── PDF download ───────────────────────────────────────────────────────────

/** Live PDF (base64) for preview/download; plus a link to the copy that was emailed, when stored. */
export async function documentPdf(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const kind = requiredString(params, "kind") as DocKind;
  const id = requiredString(params, "id");
  const { settings, resolver } = await loadBilling(ctx, companyId);
  let view: DocView;
  let storedKey: string | null = null;
  if (kind === "invoice") {
    const invoice = await requireInvoice(ctx, companyId, id);
    view = await invoiceView(ctx, invoice, settings);
    storedKey = invoice.pdf_key ?? null;
  } else if (kind === "quote") {
    const quote = await requireQuote(ctx, companyId, id);
    view = await quoteView(ctx, quote, settings);
    storedKey = quote.pdf_key ?? null;
  } else {
    throw new BillingError("kind must be invoice or quote (credit notes use credit-note-pdf)");
  }
  const bytes = await renderDocument(view);
  const filename = docFileName(view);
  let sentCopyUrl: string | null = null;
  if (storedKey) {
    const r2 = await privateR2(resolver, settings).catch(() => null);
    if (r2) sentCopyUrl = presignGet(r2, storedKey, 900, filename);
  }
  return { filename, mime: "application/pdf", base64: Buffer.from(bytes).toString("base64"), sentCopyUrl };
}

// ── Recurring ──────────────────────────────────────────────────────────────

/**
 * A new draft copied from a template invoice, keeping every field: sender,
 * customer, currency, VAT rate and codes, VAT-inclusive pricing, notes,
 * recipients, lines with descriptions and codes, and the due-date offset.
 */
export function copyInvoiceFields(template: InvoiceRow, overrides: Partial<InvoiceRow> & Pick<InvoiceRow, "id" | "number">, now = new Date()): InvoiceRow {
  const created = Date.parse(String(iso(template.sent_at) ?? iso(template.created_at) ?? ""));
  const due = Date.parse(String(iso(template.due_at) ?? ""));
  const offset = Number.isFinite(created) && Number.isFinite(due) && due > created ? due - created : null;
  return {
    company_id: template.company_id,
    status: "draft",
    currency: template.currency,
    customer_kind: template.customer_kind,
    customer_ref: template.customer_ref,
    sender: asObject(template.sender),
    customer: asObject(template.customer),
    sender_snapshot: null,
    customer_snapshot: null,
    total_minor: Number(template.total_minor),
    tax_rate: Number(template.tax_rate ?? 0),
    due_at: offset != null ? new Date(now.getTime() + offset).toISOString() : null,
    approval_issue_id: null,
    pending_action: null,
    sent_at: null,
    default_tax_code: template.default_tax_code ?? null,
    prices_include_vat: Boolean(template.prices_include_vat),
    notes: template.notes ?? null,
    subtotal_minor: Number(template.subtotal_minor ?? 0),
    vat_minor: Number(template.vat_minor ?? 0),
    send_to: asArray(template.send_to),
    ...overrides,
  };
}

export async function copyLines(ctx: PluginContext, fromInvoiceId: string, toInvoiceId: string, companyId: string): Promise<void> {
  for (const line of await linesFor(ctx, fromInvoiceId)) {
    await insertLine(ctx, {
      companyId,
      invoiceId: toInvoiceId,
      description: line.description,
      quantity: Number(line.quantity),
      unitAmountMinor: Number(line.unit_amount_minor),
      taxCode: line.tax_code ?? null,
    });
  }
}

/**
 * Advance from the scheduled date, not from "now", so a late run does not
 * drift the schedule; a run that is several periods behind catches up one
 * period per run.
 */
export function advanceSchedule(scheduled: Date, frequency: RecurringFrequency): Date {
  return nextRunDate(scheduled, frequency);
}

export function describePeriod(start: Date, period: string): string {
  const end = nextRunDate(start, (period === "quarterly" || period === "yearly" ? period : "monthly") as RecurringFrequency);
  end.setUTCDate(end.getUTCDate() - 1);
  return `${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)}`;
}

export { actorLabel, isOpenStatus };
