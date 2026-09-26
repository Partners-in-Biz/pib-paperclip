import { randomUUID } from "node:crypto";

export class BillingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingError";
  }
}

export interface InvoiceLine {
  quantity: number;
  unitAmountMinor: number;
}

export interface InvoiceState {
  status: "draft" | "sent" | "viewed" | "paid" | "overdue" | "cancelled";
  sender: Record<string, unknown>;
  customer: Record<string, unknown>;
  senderSnapshot: Record<string, unknown> | null;
  customerSnapshot: Record<string, unknown> | null;
  sentAt: string | null;
}

export function assertAgentMaySend(): never {
  throw new BillingError("Agents may draft invoices. They may not send them.");
}

export function lineTotal(lines: InvoiceLine[]): number {
  return lines.reduce((sum, line) => {
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      throw new BillingError("Quantity must be a positive integer");
    }
    if (!Number.isInteger(line.unitAmountMinor) || line.unitAmountMinor < 0) {
      throw new BillingError("Unit amount must be a non-negative integer in minor units");
    }
    return sum + line.quantity * line.unitAmountMinor;
  }, 0);
}

export function markSent<T extends InvoiceState>(invoice: T, now: string): T {
  if (invoice.status !== "draft") throw new BillingError("Only a draft invoice can be sent");
  return {
    ...invoice,
    status: "sent",
    senderSnapshot: invoice.sender,
    customerSnapshot: invoice.customer,
    sentAt: now,
  };
}

export function markPaid<T extends InvoiceState>(invoice: T): T {
  if (invoice.status !== "sent" && invoice.status !== "viewed" && invoice.status !== "overdue") {
    throw new BillingError("This invoice cannot be marked paid");
  }
  return { ...invoice, status: "paid" };
}

export function canSeeInvoice(
  viewerCompanyId: string,
  invoiceCompanyId: string,
  grants: Array<{ granteeCompanyId: string }>,
): boolean {
  if (viewerCompanyId === invoiceCompanyId) return true;
  return grants.some((grant) => grant.granteeCompanyId === viewerCompanyId);
}

export const QUOTE_STATUSES = ["draft", "sent", "accepted", "declined", "converted", "expired"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export interface QuoteState {
  status: QuoteStatus;
  sender: Record<string, unknown>;
  customer: Record<string, unknown>;
  validUntil: string | null;
  convertedInvoiceId: string | null;
}

export interface ExpenseDraft {
  id: string;
  companyId: string;
  description: string;
  amountMinor: number;
  currency: string;
  category: string;
  incurredOn: string | null;
}

export function assertQuoteStatus(value: string): QuoteStatus {
  if (!QUOTE_STATUSES.includes(value as QuoteStatus)) {
    throw new BillingError("Quote status must be draft, sent, accepted, declined, converted, or expired");
  }
  return value as QuoteStatus;
}

export function assertExpenseAmount(value: unknown): number {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(amount) || amount < 0) {
    throw new BillingError("Expense amount must be a non-negative integer in minor units");
  }
  return amount;
}

export function assertExpenseDescription(value: string): string {
  const description = value.trim();
  if (!description) throw new BillingError("Expense description is required");
  return description;
}

export function createExpense(input: {
  companyId: string;
  description: string;
  amountMinor: number;
  currency?: string;
  category?: string;
  incurredOn?: string | null;
  id?: string;
}): ExpenseDraft {
  return {
    id: input.id ?? randomUUID(),
    companyId: input.companyId,
    description: assertExpenseDescription(input.description),
    amountMinor: assertExpenseAmount(input.amountMinor),
    currency: (input.currency ?? "ZAR").trim().toUpperCase(),
    category: (input.category ?? "other").trim().toLowerCase() || "other",
    incurredOn: input.incurredOn ?? null,
  };
}

/**
 * Next sequential number for a document type. `existing` is the set of numbers
 * already used in this workspace. Produces e.g. INV-0007 or QTE-0003.
 */
export function nextNumber(prefix: string, existing: string[]): string {
  let max = 0;
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  for (const number of existing) {
    const match = re.exec(number);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}-${String(max + 1).padStart(4, "0")}`;
}

export interface InvoiceHtmlLine {
  description: string;
  quantity: number;
  unitAmountMinor: number;
}

export interface InvoiceHtmlInput {
  /** "Invoice" (default) or "Quote". */
  kind?: "Invoice" | "Quote";
  issuedAt?: string | null;
  taxRate?: number;
  /** EFT/bank details printed under the total. */
  payment?: Record<string, unknown> | null;
  notes?: string | null;
  number: string;
  status: string;
  currency: string;
  sender: Record<string, unknown>;
  customer: Record<string, unknown>;
  lines: InvoiceHtmlLine[];
  dueAt: string | null;
}

/** Minor units as money in the document's currency, e.g. `ZAR 12,400.00`. Used on printed invoices and summaries. */
export function formatMoney(amountMinor: number, currency: string): string {
  return money(amountMinor, currency);
}

function money(amountMinor: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amountMinor / 100);
  } catch {
    return `${currency} ${(amountMinor / 100).toFixed(2)}`;
  }
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build a self-contained, printable HTML invoice. A person can open it in a
 * browser and save as PDF. No external assets, so it works offline.
 */
const SENDER_FIELDS: Array<[string, string]> = [
  ["address", ""],
  ["email", ""],
  ["phone", ""],
  ["vatNumber", "VAT no. "],
  ["registrationNumber", "Reg. no. "],
];

const PAYMENT_FIELDS: Array<[string, string]> = [
  ["bankName", "Bank"],
  ["accountName", "Account name"],
  ["accountNumber", "Account number"],
  ["branchCode", "Branch code"],
  ["accountType", "Account type"],
  ["swift", "SWIFT"],
];

function partyLines(party: Record<string, unknown>, fallbackName: string): string {
  const lines = [`<strong>${esc(party.name ?? fallbackName)}</strong>`];
  for (const [key, prefix] of SENDER_FIELDS) {
    const value = party[key];
    if (typeof value === "string" && value.trim()) {
      lines.push(esc(`${prefix}${value.trim()}`).replace(/\n/g, "<br />"));
    }
  }
  return lines.join("<br />");
}

/**
 * Build a self-contained, printable HTML invoice or quote. A person can open it
 * in a browser and save as PDF. No external assets, so it works offline.
 */
export function buildInvoiceHtml(input: InvoiceHtmlInput): string {
  const kind = input.kind ?? "Invoice";
  const senderName = esc(input.sender.name ?? "Workspace");
  const subtotal = input.lines.reduce((sum, line) => sum + line.quantity * line.unitAmountMinor, 0);
  const taxRate = Number(input.taxRate ?? 0);
  const { taxMinor, totalMinor } = totalWithTax(subtotal, taxRate);
  const rows = input.lines
    .map((line) => {
      const lineTotal = line.quantity * line.unitAmountMinor;
      return `<tr>
        <td>${esc(line.description)}</td>
        <td class="num">${line.quantity}</td>
        <td class="num">${money(line.unitAmountMinor, input.currency)}</td>
        <td class="num">${money(lineTotal, input.currency)}</td>
      </tr>`;
    })
    .join("\n        ");
  const payment = input.payment ?? null;
  const paymentRows = payment
    ? PAYMENT_FIELDS.filter(([key]) => typeof payment[key] === "string" && String(payment[key]).trim())
        .map(([key, label]) => `<tr><th>${esc(label)}</th><td>${esc(payment[key])}</td></tr>`)
        .join("")
    : "";
  const reference = kind === "Invoice" ? `<tr><th>Reference</th><td>${esc(input.number)}</td></tr>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${kind} ${esc(input.number)}</title>
<style>
  body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1a1a1a; margin: 0; padding: 40px; }
  .wrap { max-width: 720px; margin: 0 auto; }
  header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #111; padding-bottom: 16px; }
  h1 { font-size: 22px; margin: 0; }
  .meta { text-align: right; font-size: 13px; color: #555; line-height: 1.6; }
  .parties { display: flex; justify-content: space-between; gap: 24px; margin: 24px 0; }
  .party h3, .pay h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #888; margin: 0 0 6px; }
  .party p { margin: 0; font-size: 14px; line-height: 1.5; }
  table.lines { width: 100%; border-collapse: collapse; font-size: 14px; }
  table.lines th { text-align: left; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #888; border-bottom: 1px solid #ddd; padding: 8px; }
  table.lines td { padding: 10px 8px; border-bottom: 1px solid #eee; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .totals { margin-left: auto; margin-top: 16px; font-size: 14px; border-collapse: collapse; }
  .totals td { padding: 4px 8px; }
  .totals .grand td { font-size: 18px; font-weight: 700; border-top: 2px solid #111; padding-top: 8px; }
  .pay { margin-top: 32px; font-size: 13px; }
  .pay table { border-collapse: collapse; }
  .pay th { text-align: left; color: #666; font-weight: 500; padding: 2px 16px 2px 0; }
  .notes { margin-top: 24px; font-size: 13px; color: #444; white-space: pre-wrap; }
  .status { display: inline-block; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; padding: 3px 10px; border-radius: 999px; background: #eee; }
  @media print { body { padding: 0; } .status { display: none; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>${kind} ${esc(input.number)}</h1>
      <div class="status">${esc(input.status)}</div>
    </div>
    <div class="meta">
      <div>${senderName}</div>
      ${input.issuedAt ? `<div>Issued ${esc(input.issuedAt.slice(0, 10))}</div>` : ""}
      ${input.dueAt ? `<div>${kind === "Quote" ? "Valid until" : "Due"} ${esc(String(input.dueAt).slice(0, 10))}</div>` : ""}
    </div>
  </header>
  <div class="parties">
    <div class="party"><h3>From</h3><p>${partyLines(input.sender, "Workspace")}</p></div>
    <div class="party"><h3>To</h3><p>${partyLines(input.customer, "Customer")}</p></div>
  </div>
  <table class="lines">
    <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Amount</th></tr></thead>
    <tbody>
        ${rows}
    </tbody>
  </table>
  <table class="totals">
    <tr><td>Subtotal</td><td class="num">${money(subtotal, input.currency)}</td></tr>
    ${taxRate > 0 ? `<tr><td>VAT ${esc(taxRate)}%</td><td class="num">${money(taxMinor, input.currency)}</td></tr>` : ""}
    <tr class="grand"><td>Total</td><td class="num">${money(totalMinor, input.currency)}</td></tr>
  </table>
  ${kind === "Invoice" && paymentRows ? `<div class="pay"><h3>Payment details (EFT)</h3><table>${paymentRows}${reference}</table></div>` : ""}
  ${input.notes ? `<div class="notes">${esc(input.notes)}</div>` : ""}
</div>
</body>
</html>`;
}

export const RECURRING_FREQUENCIES = ["monthly", "quarterly", "yearly"] as const;
export type RecurringFrequency = (typeof RECURRING_FREQUENCIES)[number];

export function assertFrequency(value: string): RecurringFrequency {
  if (!RECURRING_FREQUENCIES.includes(value as RecurringFrequency)) {
    throw new BillingError("Frequency must be monthly, quarterly, or yearly");
  }
  return value as RecurringFrequency;
}

/** Advance a run date by one period of the given frequency. */
export function nextRunDate(from: Date, frequency: RecurringFrequency): Date {
  const next = new Date(from);
  if (frequency === "monthly") next.setUTCMonth(next.getUTCMonth() + 1);
  else if (frequency === "quarterly") next.setUTCMonth(next.getUTCMonth() + 3);
  else next.setUTCFullYear(next.getUTCFullYear() + 1);
  return next;
}

export interface PaymentDraft {
  id: string;
  companyId: string;
  invoiceId: string;
  amountMinor: number;
  method: string;
  reference: string | null;
  paidAt: string;
}

export function assertPaymentAmount(value: unknown): number {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new BillingError("Payment amount must be a positive integer in minor units");
  }
  return amount;
}

export function createPayment(input: {
  companyId: string;
  invoiceId: string;
  amountMinor: number;
  method?: string;
  reference?: string | null;
  paidAt?: string;
  id?: string;
}): PaymentDraft {
  return {
    id: input.id ?? randomUUID(),
    companyId: input.companyId,
    invoiceId: input.invoiceId,
    amountMinor: assertPaymentAmount(input.amountMinor),
    method: (input.method ?? "bank").trim().toLowerCase() || "bank",
    reference: input.reference?.trim() || null,
    paidAt: input.paidAt ?? new Date().toISOString(),
  };
}

export function assertTaxRate(value: unknown): number {
  const rate = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    throw new BillingError("Tax rate must be a percentage between 0 and 100");
  }
  return rate;
}

export function totalWithTax(subtotalMinor: number, taxRate: number): { taxMinor: number; totalMinor: number } {
  const taxMinor = Math.round(subtotalMinor * (taxRate / 100));
  return { taxMinor, totalMinor: subtotalMinor + taxMinor };
}

export interface CreditNoteDraft {
  id: string;
  companyId: string;
  invoiceId: string;
  amountMinor: number;
  reason: string;
  status: "issued" | "applied";
}

export function createCreditNote(input: {
  companyId: string;
  invoiceId: string;
  amountMinor: number;
  reason?: string;
  id?: string;
}): CreditNoteDraft {
  const amount = typeof input.amountMinor === "number" ? input.amountMinor : Number(input.amountMinor);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new BillingError("Credit amount must be a positive integer in minor units");
  }
  return {
    id: input.id ?? randomUUID(),
    companyId: input.companyId,
    invoiceId: input.invoiceId,
    amountMinor: amount,
    reason: (input.reason ?? "").trim(),
    status: "issued",
  };
}

/** What the CRM client workspace shows for Billing (`GET /client-summary`). */
export interface ClientSummary {
  headline: string;
  stats: Array<{ label: string; value: string | number; tone?: "ok" | "warn" | "bad" }>;
}

export interface SummaryInvoice {
  status: string;
  currency: string;
  totalMinor: number;
  paidMinor: number;
  creditedMinor: number;
  dueAt: string | null;
  lastPaidAt: string | null;
}

const OPEN_INVOICE_STATUSES = new Set(["sent", "viewed", "overdue"]);

/** What the customer still owes on a sent invoice: total less payments and credits, never below zero. */
export function outstandingMinor(invoice: Pick<SummaryInvoice, "status" | "totalMinor" | "paidMinor" | "creditedMinor">): number {
  if (!OPEN_INVOICE_STATUSES.has(invoice.status)) return 0;
  return Math.max(0, invoice.totalMinor - invoice.paidMinor - invoice.creditedMinor);
}

/** Overdue by status, or past due before the hourly overdue job has caught up. */
export function isOverdueInvoice(invoice: SummaryInvoice, now: Date): boolean {
  if (outstandingMinor(invoice) <= 0) return false;
  if (invoice.status === "overdue") return true;
  const due = invoice.dueAt ? Date.parse(invoice.dueAt) : Number.NaN;
  return Number.isFinite(due) && due < now.getTime();
}

/**
 * One client's billing at a glance: outstanding per currency, overdue
 * invoices, open quotes (draft or sent) and the last payment date.
 */
export function clientBillingSummary(input: {
  invoices: SummaryInvoice[];
  quotes: Array<{ status: string }>;
  now: Date;
  defaultCurrency?: string;
}): ClientSummary {
  const owed = new Map<string, number>();
  for (const invoice of input.invoices) {
    const amount = outstandingMinor(invoice);
    if (amount > 0) owed.set(invoice.currency, (owed.get(invoice.currency) ?? 0) + amount);
  }
  const outstanding = [...owed.entries()].map(([currency, amount]) => formatMoney(amount, currency)).join(" + ");
  const overdue = input.invoices.filter((invoice) => isOverdueInvoice(invoice, input.now)).length;
  const openQuotes = input.quotes.filter((quote) => quote.status === "draft" || quote.status === "sent").length;
  const lastPaid = input.invoices
    .map((invoice) => invoice.lastPaidAt)
    .filter((value): value is string => Boolean(value) && Number.isFinite(Date.parse(value!)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
  const currency = input.invoices[0]?.currency ?? input.defaultCurrency ?? "ZAR";
  const headline = outstanding
    ? `${outstanding} outstanding`
    : input.invoices.length > 0
      ? "Nothing outstanding"
      : "No invoices";
  return {
    headline,
    stats: [
      { label: "Outstanding", value: outstanding || formatMoney(0, currency), ...(outstanding ? {} : input.invoices.length > 0 ? { tone: "ok" as const } : {}) },
      { label: "Overdue invoices", value: overdue, tone: overdue > 0 ? "bad" : "ok" },
      { label: "Open quotes", value: openQuotes },
      { label: "Last paid", value: lastPaid ? new Date(Date.parse(lastPaid)).toISOString().slice(0, 10) : "Never" },
    ],
  };
}
