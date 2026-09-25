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
  number: string;
  status: string;
  currency: string;
  sender: Record<string, unknown>;
  customer: Record<string, unknown>;
  lines: InvoiceHtmlLine[];
  dueAt: string | null;
}

function money(amountMinor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(amountMinor / 100);
  } catch {
    return `${currency} ${(amountMinor / 100).toFixed(0)}`;
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
export function buildInvoiceHtml(input: InvoiceHtmlInput): string {
  const senderName = esc(input.sender.name ?? "Workspace");
  const customerName = esc(input.customer.name ?? "Customer");
  const total = input.lines.reduce((sum, line) => sum + line.quantity * line.unitAmountMinor, 0);
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
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Invoice ${esc(input.number)}</title>
<style>
  body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1a1a1a; margin: 0; padding: 40px; }
  .wrap { max-width: 720px; margin: 0 auto; }
  header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #111; padding-bottom: 16px; }
  h1 { font-size: 22px; margin: 0; }
  .meta { text-align: right; font-size: 13px; color: #555; }
  .parties { display: flex; justify-content: space-between; gap: 24px; margin: 24px 0; }
  .party h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #888; margin: 0 0 6px; }
  .party p { margin: 0; font-size: 14px; line-height: 1.5; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #888; border-bottom: 1px solid #ddd; padding: 8px; }
  td { padding: 10px 8px; border-bottom: 1px solid #eee; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .total { text-align: right; font-size: 18px; font-weight: 700; margin-top: 16px; }
  .status { display: inline-block; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; padding: 3px 10px; border-radius: 999px; background: #eee; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>Invoice ${esc(input.number)}</h1>
      <div class="status">${esc(input.status)}</div>
    </div>
    <div class="meta">
      <div>${senderName}</div>
      ${input.dueAt ? `<div>Due ${esc(input.dueAt)}</div>` : ""}
    </div>
  </header>
  <div class="parties">
    <div class="party"><h3>From</h3><p>${senderName}</p></div>
    <div class="party"><h3>To</h3><p>${customerName}</p></div>
  </div>
  <table>
    <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Amount</th></tr></thead>
    <tbody>
        ${rows}
    </tbody>
  </table>
  <div class="total">Total ${money(total, input.currency)}</div>
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
