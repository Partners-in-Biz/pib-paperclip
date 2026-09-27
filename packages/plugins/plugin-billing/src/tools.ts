import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import { TAX_CODES } from "@partnersinbiz/pib-plugin-kit";

/**
 * Agent tools. Every parameter has a description, and an enum where the
 * values are fixed (a test checks this). Money is always an integer in cents
 * (minor units) in the document's currency. Agents draft and ask; a person
 * approves every send and every money change.
 */

const str = (description: string): JsonSchema => ({ type: "string", description });
const int = (description: string): JsonSchema => ({ type: "integer", description });
const bool = (description: string): JsonSchema => ({ type: "boolean", description });
const oneOf = (values: readonly string[], description: string): JsonSchema => ({ type: "string", enum: [...values], description });

const date = (what: string) => str(`${what}, YYYY-MM-DD.`);
const taxCode = oneOf(Object.keys(TAX_CODES), "VAT code: za_std_15 (15%), za_zero (zero-rated), za_exempt, za_out_of_scope (not VAT registered), za_export_zero (exports), za_capital_15 (capital goods at 15%).");
const client = str("The client: company:<crm company id> or contact:<crm contact id>. Never a name.");
const currency = str("3-letter currency code, e.g. ZAR. Default: the currency in Billing settings.");
const invoiceId = str("Billing invoice id (the id from create-invoice, list-open-invoices or an issue), not the invoice number.");
const quoteId = str("Billing quote id (the id from create-quote or list-quotes), not the quote number.");
const customerKind = oneOf(["company", "contact"], "The customer's CRM record type: company (a business) or contact (a person or sole trader).");
const customerRef = str("CRM id of that company or contact (look it up in the CRM first).");
const customerName = str("Only when Billing does not know the client yet (the error says so): the client's CRM name. Otherwise the name comes from the CRM.");
const customerEmail = str("Billing email for this document when the CRM has none.");
const senderName = str("Trading name to print instead of the business name in Billing settings. Leave out normally.");
const pricesIncludeVat = bool("true when line prices already include VAT. Default: Billing settings.");
const notes = str("Text printed at the bottom of the document (terms, thank-you note).");
const dealId = str("CRM deal id this belongs to (from the CRM deal or the Deal won issue), so the CRM and Billing stay linked.");
const lineDescription = str("What was sold, as the customer should read it.");
const quantity = int("Whole units, 1 or more.");
const unitAmountMinor = int("Price of one unit in cents (R 1,500.00 = 150000), excl. VAT unless the document has pricesIncludeVat.");
const sendTo = str("Comma-separated emails to send to instead of the client's billing contacts in the CRM.");
const period = oneOf(["monthly", "quarterly", "yearly"], "How often an invoice is made.");

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

export const BILLING_TOOLS: PluginToolDeclaration[] = [
  // ── Invoices ─────────────────────────────────────────────────────────────
  {
    name: "create-invoice",
    displayName: "Create invoice",
    description: "Draft an invoice for a CRM client (numbered per client, e.g. LUM-001). Add lines next, then request-invoice-send. Returns the invoice id.",
    parametersSchema: schema(["currency", "customerKind", "customerRef"], {
      currency,
      customerKind,
      customerRef,
      customerName,
      customerEmail,
      senderName,
      dueAt: date("Due date. Default: today plus the due days in Billing settings"),
      taxCode: { ...taxCode, description: "VAT code for new lines (default from settings). za_std_15 (15%), za_zero, za_exempt, za_out_of_scope, za_export_zero, za_capital_15." },
      pricesIncludeVat,
      notes,
      dealId,
    }),
  },
  {
    name: "add-line",
    displayName: "Add invoice line",
    description: "Add a line to a draft invoice. Returns the new totals and the lineId.",
    parametersSchema: schema(["invoiceId", "description", "quantity", "unitAmountMinor"], {
      invoiceId,
      description: lineDescription,
      quantity,
      unitAmountMinor,
      taxCode: { ...taxCode, description: "VAT code for this line. Leave out to use the invoice's code." },
    }),
  },
  {
    name: "update-line",
    displayName: "Change invoice line",
    description: "Change a line on a draft invoice. Pass only what changes.",
    parametersSchema: schema(["invoiceId", "lineId"], {
      invoiceId,
      lineId: str("Line id (from invoice-detail or add-line)."),
      description: lineDescription,
      quantity,
      unitAmountMinor,
      taxCode: { ...taxCode, description: "New VAT code for this line." },
    }),
  },
  {
    name: "remove-line",
    displayName: "Remove invoice line",
    description: "Remove a line from a draft invoice (time billed on it becomes unbilled again).",
    parametersSchema: schema(["invoiceId", "lineId"], { invoiceId, lineId: str("Line id (from invoice-detail).") }),
  },
  {
    name: "update-invoice",
    displayName: "Change invoice",
    description: "Change an invoice's due date, notes, recipients or deal link; VAT-inclusive pricing only on a draft. Pass only what changes.",
    parametersSchema: schema(["invoiceId"], {
      invoiceId,
      dueAt: date("New due date"),
      notes,
      sendTo,
      pricesIncludeVat: bool("true when line prices include VAT (drafts only)."),
      dealId,
    }),
  },
  {
    name: "invoice-detail",
    displayName: "Invoice detail",
    description: "One invoice: status, lines, VAT per code, what is owed, payments, credits, proofs of payment, emails, reminders and recipients.",
    parametersSchema: schema(["invoiceId"], { invoiceId }),
  },
  {
    name: "list-open-invoices",
    displayName: "List open invoices",
    description: "Invoices still owed (sent, overdue, part paid, waiting on a payment check) with what each still owes.",
    parametersSchema: schema([], { client: { ...client, description: "Only this client's invoices: company:<crm id> or contact:<crm id>." } }),
  },
  {
    name: "request-invoice-send",
    displayName: "Request invoice send",
    description: "Ask for a draft invoice to be emailed. Opens an approval issue (the Reviewer checks first when there is one, then a person). When a person marks it done, Billing emails it with its PDF from the Mailbox. Asking again returns the open issue.",
    parametersSchema: schema(["invoiceId"], { invoiceId, sendTo }),
  },
  {
    name: "invoice-html",
    displayName: "Invoice HTML",
    description: "A printable HTML copy of an invoice (large). Use invoice-detail to read it; the Billing page has the real PDF.",
    parametersSchema: schema(["invoiceId"], { invoiceId }),
  },
  {
    name: "set-invoice-tax",
    displayName: "Set invoice tax",
    description: "Legacy: one flat VAT percentage for a whole draft. It clears every line's VAT code, so VAT201 can no longer split it. Normal invoices use taxCode per line instead; use this only when a person asks for a flat rate.",
    parametersSchema: schema(["invoiceId", "taxRate"], { invoiceId, taxRate: { type: "number", description: "VAT percentage for every line, 0 to 100 (15 = standard SA VAT)." } }),
  },
  {
    name: "invoice-payments",
    displayName: "Invoice payments",
    description: "The payments recorded on an invoice (amount, method, reference, date, source).",
    parametersSchema: schema(["invoiceId"], { invoiceId }),
  },

  // ── Quotes ───────────────────────────────────────────────────────────────
  {
    name: "create-quote",
    displayName: "Create quote",
    description: "Draft a quote for a CRM client (Q-LUM-001). Pass dealId when it is for a CRM deal. Add lines next, then request-quote-send.",
    parametersSchema: schema(["currency", "customerKind", "customerRef"], {
      currency,
      customerKind,
      customerRef,
      customerName,
      customerEmail,
      senderName,
      validUntil: date("Last day the quote is valid"),
      taxCode: { ...taxCode, description: "VAT code for new lines (default from settings)." },
      pricesIncludeVat,
      notes,
      dealId,
    }),
  },
  {
    name: "add-quote-line",
    displayName: "Add quote line",
    description: "Add a line to a draft quote. Returns the new totals and the lineId.",
    parametersSchema: schema(["quoteId", "description", "quantity", "unitAmountMinor"], {
      quoteId,
      description: lineDescription,
      quantity,
      unitAmountMinor,
      taxCode: { ...taxCode, description: "VAT code for this line. Leave out to use the quote's code." },
    }),
  },
  {
    name: "remove-quote-line",
    displayName: "Remove quote line",
    description: "Remove a line from a draft quote.",
    parametersSchema: schema(["quoteId", "lineId"], { quoteId, lineId: str("Quote line id (from quote-detail or add-quote-line).") }),
  },
  {
    name: "update-quote",
    displayName: "Change quote",
    description: "Change a quote's valid-until date, notes, recipients or deal link. Pass only what changes.",
    parametersSchema: schema(["quoteId"], { quoteId, validUntil: date("New last valid day"), notes, sendTo, dealId }),
  },
  {
    name: "quote-detail",
    displayName: "Quote detail",
    description: "One quote: status, lines, VAT, totals, deal, emails and recipients.",
    parametersSchema: schema(["quoteId"], { quoteId }),
  },
  {
    name: "list-quotes",
    displayName: "List quotes",
    description: "Quotes, newest first, optionally for one client, status or deal.",
    parametersSchema: schema([], {
      client: { ...client, description: "Only this client's quotes: company:<crm id> or contact:<crm id>." },
      status: oneOf(["draft", "sent", "accepted", "declined", "converted", "expired"], "Only quotes in this status."),
      dealId: str("Only quotes for this CRM deal id."),
    }),
  },
  {
    name: "request-quote-send",
    displayName: "Request quote send",
    description: "Ask for a draft (or re-send of a sent) quote to be emailed. Opens an approval issue (Reviewer first when there is one, then a person); a person's done emails it with its PDF. The email asks the customer to reply to accept. Asking again returns the open issue.",
    parametersSchema: schema(["quoteId"], { quoteId }),
  },
  {
    name: "set-quote-status",
    displayName: "Set quote status",
    description: "Record the customer's answer to a sent quote: accepted or declined; expired when its valid-until date passed. Accepting tells the CRM (its deal moves to won); then convert-quote.",
    parametersSchema: schema(["quoteId", "status"], { quoteId, status: oneOf(["accepted", "declined", "expired"], "accepted or declined (the customer's answer), or expired.") }),
  },
  {
    name: "convert-quote",
    displayName: "Convert quote to invoice",
    description: "Turn an accepted quote into a draft invoice with the same client, lines, VAT codes and deal. Then check it and request-invoice-send.",
    parametersSchema: schema(["quoteId"], { quoteId }),
  },
  {
    name: "quote-html",
    displayName: "Quote HTML",
    description: "A printable HTML copy of a quote (large). Use quote-detail to read it.",
    parametersSchema: schema(["quoteId"], { quoteId }),
  },

  // ── Money in (a person decides) ──────────────────────────────────────────
  {
    name: "request-payment-check",
    displayName: "Request payment check",
    description: "The customer says they paid (on a call, WhatsApp, a DM or an email Billing did not pick up): opens the same check a person does for an emailed proof of payment. The invoice waits on it; when the person marks it done the payment is recorded.",
    parametersSchema: schema(["invoiceId", "note"], {
      invoiceId,
      note: str("What the customer said or sent, and where (e.g. 'WhatsApp from Sipho: paid R 5,000 on Friday, ref LUM-001')."),
      amountMinor: int("Amount they say they paid, in cents."),
      paidOn: date("Day they say they paid"),
      reference: str("Payment reference they used, if known."),
      mailMessageId: str("Mailbox message id when the proof came by email, so the same email is never checked twice."),
    }),
  },
  {
    name: "record-payment",
    displayName: "Record payment",
    description: "Ask a person to record money received on a sent invoice. You never record it yourself: this opens a decision issue ('Record payment of R… on LUM-001?') and the payment is recorded when a person marks it done. Pass paymentKey so asking twice is safe.",
    parametersSchema: schema(["invoiceId", "amountMinor"], {
      invoiceId,
      amountMinor: int("Amount received in cents, in the invoice's currency."),
      method: oneOf(["eft", "card", "cash", "other"], "How it was paid. Default eft."),
      reference: str("Payment reference the customer used (usually the invoice number)."),
      paidAt: date("Day the money arrived. Default: the day a person records it"),
      paymentKey: str("Your own unique key for this payment (e.g. the bank line id), so asking twice never records it twice."),
    }),
  },
  {
    name: "create-credit-note",
    displayName: "Create credit note",
    description: "Ask a person to credit a sent invoice. Opens a decision issue; when a person marks it done the credit note is numbered (CN-LUM-001), applied to what the invoice owes (the rest stays with the customer as credit) and posted.",
    parametersSchema: schema(["invoiceId", "amountMinor"], {
      invoiceId,
      amountMinor: int("Credit in cents, VAT included."),
      reason: str("Why the customer is credited; printed on the credit note."),
    }),
  },
  {
    name: "list-credit-notes",
    displayName: "List credit notes",
    description: "All credit notes, newest first, with their invoice, amount and status.",
    parametersSchema: schema([], {}),
  },
  {
    name: "customer-credit",
    displayName: "Customer credit",
    description: "A client's unused credit (overpayments and credit-note remainders). A person applies it to an invoice on the Billing page.",
    parametersSchema: schema(["client"], { client }),
  },
  {
    name: "list-proofs-of-payment",
    displayName: "List proofs of payment",
    description: "Proofs of payment and payment checks (from email, uploads or agents). Only a person confirms or rejects them.",
    parametersSchema: schema([], { status: oneOf(["pending", "confirmed", "rejected"], "Only this status (pending = waiting for a person's check).") }),
  },
  {
    name: "request-reminder-send",
    displayName: "Request payment reminder",
    description: "Ask for the next payment reminder on an overdue invoice (the stage wording from Billing settings, with the PDF and EFT details). Opens an approval issue; a person's done sends it from the Mailbox. Refused when automatic reminders are on, the next stage is not due, all stages went out or the client is opted out (the message says what to do instead).",
    parametersSchema: schema(["invoiceId"], { invoiceId: str("Overdue invoice id (from the Overdue invoices issue or list-open-invoices).") }),
  },

  // ── Recurring and retainers ──────────────────────────────────────────────
  {
    name: "create-recurring-invoice",
    displayName: "Create recurring invoice",
    description: "Repeat an invoice: each period Billing copies it (every field and line) into a new draft and lists it in Drafts to send. Only a person can make them send themselves.",
    parametersSchema: schema(["templateInvoiceId", "frequency", "nextRunAt"], {
      templateInvoiceId: str("Invoice id to copy each period."),
      frequency: period,
      nextRunAt: date("Date of the first new invoice"),
      endsAt: date("Last date to make invoices. Leave out to repeat until paused"),
    }),
  },
  {
    name: "list-recurring-invoices",
    displayName: "List recurring invoices",
    description: "Recurring invoice schedules: the invoice copied, frequency, next date, active or paused.",
    parametersSchema: schema([], {}),
  },
  {
    name: "pause-recurring-invoice",
    displayName: "Pause recurring invoice",
    description: "Stop a recurring schedule from making new invoices.",
    parametersSchema: schema(["recurringId"], { recurringId: str("Recurring schedule id (from list-recurring-invoices).") }),
  },
  {
    name: "resume-recurring-invoice",
    displayName: "Resume recurring invoice",
    description: "Start a paused recurring schedule again.",
    parametersSchema: schema(["recurringId"], { recurringId: str("Recurring schedule id (from list-recurring-invoices).") }),
  },
  {
    name: "create-retainer-plan",
    displayName: "Create retainer plan",
    description: "A standard retainer (name, price, period, VAT code) to put clients on with create-subscription.",
    parametersSchema: schema(["name", "priceMinor"], {
      name: str("Plan name, e.g. Growth retainer."),
      description: str("What the plan includes."),
      priceMinor: int("Price per period in cents, excl. VAT."),
      currency,
      period,
      taxCode,
    }),
  },
  {
    name: "create-subscription",
    displayName: "Create retainer subscription",
    description: "Put a client on a retainer (a plan or a custom price). Each period Billing drafts the invoice and lists it in Drafts to send for you to request-invoice-send.",
    parametersSchema: schema(["client"], {
      client,
      planId: str("Plan id (from list-retainers); its price and period apply unless you pass them."),
      description: str("Line text on each invoice. Default: the plan name."),
      priceMinor: int("Price per period in cents, excl. VAT (required without a plan)."),
      currency,
      period,
      taxCode,
      startAt: date("Date of the first invoice. Default today"),
      customerName,
    }),
  },
  {
    name: "list-retainers",
    displayName: "List retainers",
    description: "Retainer plans and subscriptions (status, price, next invoice date), optionally for one client.",
    parametersSchema: schema([], { client: { ...client, description: "Only this client's subscriptions: company:<crm id> or contact:<crm id>." } }),
  },

  // ── Money out ────────────────────────────────────────────────────────────
  {
    name: "create-expense",
    displayName: "Create expense",
    description: "Record an expense PiB already paid (it is posted to the books at once). Amount is the total paid; vatMinor is the VAT on the receipt.",
    parametersSchema: schema(["description", "amountMinor"], {
      description: str("What was bought."),
      amountMinor: int("Total paid in cents, VAT included."),
      currency,
      category: str("Expense category from Billing settings (e.g. software, hosting). Leave out to let Billing pick."),
      incurredOn: date("Day of the expense. Default today"),
      vendor: str("Who was paid."),
      vatMinor: int("VAT on the receipt in cents (0 when none)."),
      vatClaimable: bool("true when the receipt is a valid tax invoice and PiB is VAT registered. Leave out to let Billing decide."),
      taxCode,
      paidFrom: oneOf(["bank", "card", "cash", "owner"], "Where the money came from: the business bank account, the business card, petty cash, or the owner's own pocket."),
    }),
  },
  {
    name: "create-bill",
    displayName: "Create supplier bill",
    description: "Draft a supplier's bill (money PiB owes). Add lines with add-bill-line, then request-bill-approval. You never pay bills.",
    parametersSchema: schema(["supplierName"], {
      supplierKind: oneOf(["company", "contact", "text"], "company or contact when the supplier is in the CRM (pass supplierRef too); text when it is not."),
      supplierRef: str("CRM id of the supplier company or contact."),
      supplierName: str("Supplier's name (filled from the CRM for CRM suppliers)."),
      supplierEmail: str("Supplier's billing email."),
      supplierReference: str("The supplier's own invoice number."),
      currency,
      issueDate: date("Date on the supplier's invoice"),
      dueDate: date("When it must be paid. Default: 30 days after issueDate"),
      category: str("Expense category from Billing settings for the bill's lines."),
      notes: str("Internal notes."),
      pricesIncludeVat: bool("Line amounts include VAT. Default true for bills."),
      taxCode: { ...taxCode, description: "Default VAT code for the bill's lines." },
    }),
  },
  {
    name: "add-bill-line",
    displayName: "Add bill line",
    description: "Add a line to a draft bill, as on the supplier's invoice.",
    parametersSchema: schema(["billId", "description", "unitAmountMinor"], {
      billId: str("Bill id (from create-bill or list-bills)."),
      description: str("The line as on the supplier's invoice."),
      quantity: int("Whole units. Default 1."),
      unitAmountMinor: int("Amount per unit in cents (VAT included unless the bill says otherwise)."),
      taxCode: { ...taxCode, description: "VAT code for this line. Default: the bill's." },
      category: str("Expense category for this line. Default: the bill's."),
    }),
  },
  {
    name: "request-bill-approval",
    displayName: "Request bill approval",
    description: "Ask a person to approve a draft bill. When they mark the issue done it is posted to the books and becomes payable.",
    parametersSchema: schema(["billId"], { billId: str("Draft bill id (from create-bill or list-bills).") }),
  },
  {
    name: "list-bills",
    displayName: "List bills",
    description: "Suppliers' bills with status, due date and what is still owed.",
    parametersSchema: schema([], {}),
  },

  // ── Time ─────────────────────────────────────────────────────────────────
  {
    name: "start-timer",
    displayName: "Start timer",
    description: "Start timing work (one running timer per agent or person).",
    parametersSchema: schema(["description"], {
      description: str("What you are working on."),
      client: { ...client, description: "The client the work is for: company:<crm id> or contact:<crm id>. Leave out for own work." },
      rateMinor: int("Hourly rate in cents. Default: Billing settings."),
      currency,
      billable: bool("false for work that is never invoiced. Default true."),
    }),
  },
  {
    name: "stop-timer",
    displayName: "Stop timer",
    description: "Stop your running timer (or the given entry).",
    parametersSchema: schema([], { entryId: str("Time entry id to stop. Default: your running timer.") }),
  },
  {
    name: "log-time",
    displayName: "Log time",
    description: "Log time already worked.",
    parametersSchema: schema(["description", "minutes"], {
      description: str("What was done."),
      minutes: int("Minutes worked."),
      date: date("Day worked. Default today"),
      client: { ...client, description: "The client the work is for: company:<crm id> or contact:<crm id>. Leave out for own work." },
      rateMinor: int("Hourly rate in cents. Default: Billing settings."),
      currency,
      billable: bool("false for work that is never invoiced. Default true."),
    }),
  },
  {
    name: "list-time-entries",
    displayName: "List time entries",
    description: "Time entries, optionally one client's or only billable time not on an invoice yet.",
    parametersSchema: schema([], {
      client: { ...client, description: "Only this client's time: company:<crm id> or contact:<crm id>." },
      unbilled: bool("true for billable time not on an invoice yet."),
    }),
  },
  {
    name: "bill-time",
    displayName: "Bill time",
    description: "Put unbilled time on a draft invoice: one line per entry (hours × rate). Time already on an invoice is skipped.",
    parametersSchema: schema(["invoiceId", "entryIds"], {
      invoiceId: str("Draft invoice id to add the time to."),
      entryIds: { type: "array", items: { type: "string", description: "Time entry id." }, description: "Time entry ids (from list-time-entries with unbilled true)." },
    }),
  },

  // ── Reports ──────────────────────────────────────────────────────────────
  {
    name: "billing-report",
    displayName: "Billing reports",
    description: "Revenue by month and client, aged debtors and creditors (0-30/31-60/61-90/90+ days), expenses by category and MRR/churn, in the reporting currency.",
    parametersSchema: schema([], { from: date("First day. Default: the start of the month 11 months ago"), to: date("Last day. Default today") }),
  },
];
