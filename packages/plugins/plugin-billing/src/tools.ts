import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import { TAX_CODES } from "@partnersinbiz/pib-plugin-kit";

const text = { type: "string" } satisfies JsonSchema;
const int = { type: "integer" } satisfies JsonSchema;
const bool = { type: "boolean" } satisfies JsonSchema;
const taxCode = { type: "string", enum: Object.keys(TAX_CODES), description: "VAT code: za_std_15 (15%), za_zero, za_exempt, za_out_of_scope, za_export_zero, za_capital_15" } satisfies JsonSchema;
const client = { type: "string", description: "company:<crm company id> or contact:<crm contact id>" } satisfies JsonSchema;

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

export const BILLING_TOOLS: PluginToolDeclaration[] = [
  {
    name: "create-invoice",
    displayName: "Create invoice",
    description: "Draft an invoice (numbered per client, e.g. LUM-001). Agents cannot send it.",
    parametersSchema: schema(["currency", "customerKind", "customerRef", "customerName"], {
      currency: text,
      customerKind: text,
      customerRef: text,
      customerName: text,
      customerEmail: text,
      senderName: text,
      dueAt: text,
      taxCode,
      pricesIncludeVat: bool,
      notes: text,
    }),
  },
  {
    name: "add-line",
    displayName: "Add invoice line",
    description: "Add a line to a draft invoice. Quantity and unit amount are integers (minor units). taxCode defaults to the invoice's VAT code.",
    parametersSchema: schema(["invoiceId", "description", "quantity", "unitAmountMinor"], {
      invoiceId: text,
      description: text,
      quantity: int,
      unitAmountMinor: int,
      taxCode,
    }),
  },
  {
    name: "update-line",
    displayName: "Change invoice line",
    description: "Change a line on a draft invoice (description, quantity, unit amount or VAT code).",
    parametersSchema: schema(["invoiceId", "lineId"], { invoiceId: text, lineId: text, description: text, quantity: int, unitAmountMinor: int, taxCode }),
  },
  {
    name: "remove-line",
    displayName: "Remove invoice line",
    description: "Remove a line from a draft invoice.",
    parametersSchema: schema(["invoiceId", "lineId"], { invoiceId: text, lineId: text }),
  },
  {
    name: "update-invoice",
    displayName: "Change invoice",
    description: "Change a draft invoice's due date, notes, recipients (sendTo, comma-separated emails) or VAT-inclusive pricing.",
    parametersSchema: schema(["invoiceId"], { invoiceId: text, dueAt: text, notes: text, sendTo: text, pricesIncludeVat: bool }),
  },
  {
    name: "invoice-detail",
    displayName: "Invoice detail",
    description: "An invoice with its lines, VAT per code, payments, credits, proofs of payment and email status.",
    parametersSchema: schema(["invoiceId"], { invoiceId: text }),
  },
  {
    name: "list-open-invoices",
    displayName: "List open invoices",
    description: "Invoices still owed (sent, partly paid, overdue, waiting on payment checks), optionally for one client.",
    parametersSchema: schema([], { client }),
  },
  {
    name: "create-quote",
    displayName: "Create quote",
    description: "Draft a quote (Q-LUM-001). Agents cannot send it. Convert it to an invoice when accepted.",
    parametersSchema: schema(["currency", "customerKind", "customerRef", "customerName"], {
      currency: text,
      customerKind: text,
      customerRef: text,
      customerName: text,
      customerEmail: text,
      senderName: text,
      validUntil: text,
      taxCode,
      pricesIncludeVat: bool,
      notes: text,
    }),
  },
  {
    name: "add-quote-line",
    displayName: "Add quote line",
    description: "Add a line to a draft quote. Quantity and unit amount are integers.",
    parametersSchema: schema(["quoteId", "description", "quantity", "unitAmountMinor"], {
      quoteId: text,
      description: text,
      quantity: int,
      unitAmountMinor: int,
      taxCode,
    }),
  },
  {
    name: "set-quote-status",
    displayName: "Set quote status",
    description: "Record the customer's answer: accepted, declined or expired.",
    parametersSchema: schema(["quoteId", "status"], { quoteId: text, status: { type: "string", enum: ["sent", "accepted", "declined", "expired"] } }),
  },
  {
    name: "convert-quote",
    displayName: "Convert quote to invoice",
    description: "Turn an accepted quote into a draft invoice, copying its lines (with descriptions and VAT codes) and customer.",
    parametersSchema: schema(["quoteId"], {
      quoteId: text,
    }),
  },
  {
    name: "create-expense",
    displayName: "Create expense",
    description: "Record a paid business expense (posted to the books). Amount is the total paid in minor units; vatMinor is the VAT on the receipt.",
    parametersSchema: schema(["description", "amountMinor"], {
      description: text,
      amountMinor: int,
      currency: text,
      category: text,
      incurredOn: text,
      vendor: text,
      vatMinor: int,
      vatClaimable: bool,
      taxCode,
      paidFrom: { type: "string", enum: ["bank", "card", "cash", "owner"] },
    }),
  },
  {
    name: "invoice-html",
    displayName: "Invoice HTML",
    description: "Return a self-contained, printable HTML invoice a person can open and save as PDF.",
    parametersSchema: schema(["invoiceId"], {
      invoiceId: text,
    }),
  },
  {
    name: "create-recurring-invoice",
    displayName: "Create recurring invoice",
    description: "Schedule a draft invoice to be re-created on a frequency (monthly, quarterly, yearly). New invoices stay drafts.",
    parametersSchema: schema(["templateInvoiceId", "frequency", "nextRunAt"], {
      templateInvoiceId: text,
      frequency: text,
      nextRunAt: text,
      endsAt: text,
    }),
  },
  {
    name: "list-recurring-invoices",
    displayName: "List recurring invoices",
    description: "Return the recurring invoice schedules for this workspace.",
    parametersSchema: schema([], {}),
  },
  {
    name: "pause-recurring-invoice",
    displayName: "Pause recurring invoice",
    description: "Stop a recurring schedule from creating new invoices.",
    parametersSchema: schema(["recurringId"], {
      recurringId: text,
    }),
  },
  {
    name: "resume-recurring-invoice",
    displayName: "Resume recurring invoice",
    description: "Re-enable a paused recurring schedule.",
    parametersSchema: schema(["recurringId"], {
      recurringId: text,
    }),
  },
  {
    name: "record-payment",
    displayName: "Record payment",
    description: "Record money received against a sent invoice. Partial payments leave it partly paid; an overpayment becomes customer credit. Pass paymentKey to make retries safe.",
    parametersSchema: schema(["invoiceId", "amountMinor"], {
      invoiceId: text,
      amountMinor: int,
      method: text,
      reference: text,
      paidAt: text,
      paymentKey: text,
    }),
  },
  {
    name: "invoice-payments",
    displayName: "Invoice payments",
    description: "Return the recorded payments for an invoice.",
    parametersSchema: schema(["invoiceId"], {
      invoiceId: text,
    }),
  },
  {
    name: "set-invoice-tax",
    displayName: "Set invoice tax",
    description: "Set one VAT rate (percentage) for the whole draft invoice; clears per-line VAT codes. The total is recomputed.",
    parametersSchema: schema(["invoiceId", "taxRate"], {
      invoiceId: text,
      taxRate: { type: "number" },
    }),
  },
  {
    name: "quote-html",
    displayName: "Quote HTML",
    description: "Return a self-contained, printable HTML quote a person can open and save as PDF.",
    parametersSchema: schema(["quoteId"], {
      quoteId: text,
    }),
  },
  {
    name: "create-credit-note",
    displayName: "Create credit note",
    description: "Issue a credit note (CN-LUM-001) against a sent invoice. It is applied to what the invoice owes; the rest stays with the customer as credit.",
    parametersSchema: schema(["invoiceId", "amountMinor"], {
      invoiceId: text,
      amountMinor: int,
      reason: text,
    }),
  },
  {
    name: "list-credit-notes",
    displayName: "List credit notes",
    description: "Return the credit notes for this workspace.",
    parametersSchema: schema([], {}),
  },
  {
    name: "customer-credit",
    displayName: "Customer credit",
    description: "A client's unused credit (overpayments and credit-note remainders).",
    parametersSchema: schema(["client"], { client }),
  },
  {
    name: "list-proofs-of-payment",
    displayName: "List proofs of payment",
    description: "Proofs of payment received by email or uploaded (pending, confirmed, rejected). Only a person confirms them.",
    parametersSchema: schema([], { status: { type: "string", enum: ["pending", "confirmed", "rejected"] } }),
  },
  {
    name: "create-bill",
    displayName: "Create supplier bill",
    description: "Draft a supplier's bill (accounts payable). Supplier is a CRM company/contact (supplierKind + supplierRef) or text (supplierName).",
    parametersSchema: schema(["supplierName"], {
      supplierKind: { type: "string", enum: ["company", "contact", "text"] },
      supplierRef: text,
      supplierName: text,
      supplierEmail: text,
      supplierReference: text,
      currency: text,
      issueDate: text,
      dueDate: text,
      category: text,
      notes: text,
      pricesIncludeVat: bool,
      taxCode,
    }),
  },
  {
    name: "add-bill-line",
    displayName: "Add bill line",
    description: "Add a line to a draft bill (amounts in minor units; prices include VAT unless the bill says otherwise).",
    parametersSchema: schema(["billId", "description", "unitAmountMinor"], { billId: text, description: text, quantity: int, unitAmountMinor: int, taxCode, category: text }),
  },
  {
    name: "request-bill-approval",
    displayName: "Request bill approval",
    description: "Open an approval issue for a draft bill. A person approves it; then it is posted and payable.",
    parametersSchema: schema(["billId"], { billId: text }),
  },
  {
    name: "list-bills",
    displayName: "List bills",
    description: "Suppliers' bills with status and what is still owed.",
    parametersSchema: schema([], {}),
  },
  {
    name: "start-timer",
    displayName: "Start timer",
    description: "Start a time entry (one running timer per person or agent).",
    parametersSchema: schema(["description"], { description: text, client, rateMinor: int, currency: text, billable: bool }),
  },
  {
    name: "stop-timer",
    displayName: "Stop timer",
    description: "Stop the running timer (or the given entry).",
    parametersSchema: schema([], { entryId: text }),
  },
  {
    name: "log-time",
    displayName: "Log time",
    description: "Log time worked by hand (minutes).",
    parametersSchema: schema(["description", "minutes"], { description: text, minutes: int, date: text, client, rateMinor: int, currency: text, billable: bool }),
  },
  {
    name: "list-time-entries",
    displayName: "List time entries",
    description: "Time entries, optionally one client's or only unbilled ones.",
    parametersSchema: schema([], { client, unbilled: bool }),
  },
  {
    name: "bill-time",
    displayName: "Bill time",
    description: "Add unbilled time entries to a draft invoice (one line each: hours × rate).",
    parametersSchema: schema(["invoiceId", "entryIds"], { invoiceId: text, entryIds: { type: "array", items: text } }),
  },
  {
    name: "create-retainer-plan",
    displayName: "Create retainer plan",
    description: "A retainer plan: name, price (minor units), period (monthly, quarterly, yearly), VAT code.",
    parametersSchema: schema(["name", "priceMinor"], { name: text, description: text, priceMinor: int, currency: text, period: { type: "string", enum: ["monthly", "quarterly", "yearly"] }, taxCode }),
  },
  {
    name: "create-subscription",
    displayName: "Create retainer subscription",
    description: "Put a client on a retainer (from a plan or a custom price). An invoice is drafted each period; a person sends it.",
    parametersSchema: schema(["client"], { client, planId: text, description: text, priceMinor: int, currency: text, period: { type: "string", enum: ["monthly", "quarterly", "yearly"] }, taxCode, startAt: text }),
  },
  {
    name: "list-retainers",
    displayName: "List retainers",
    description: "Retainer plans and subscriptions, optionally for one client.",
    parametersSchema: schema([], { client }),
  },
  {
    name: "billing-report",
    displayName: "Billing reports",
    description: "Revenue by month and client, aged debtors and creditors (0-30/31-60/61-90/90+), expense summary and MRR, in the reporting currency.",
    parametersSchema: schema([], { from: text, to: text }),
  },
];
