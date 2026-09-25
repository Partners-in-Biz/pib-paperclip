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
