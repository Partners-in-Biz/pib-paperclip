import { randomUUID } from "node:crypto";
import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginContext,
  type PluginPerformActionContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import {
  asObject,
  getInvoice,
  getQuote,
  grantsForInvoice,
  insertExpense,
  insertGrant,
  insertInvoice,
  insertLine,
  insertQuote,
  insertQuoteLine,
  invoiceByApproval,
  linesFor,
  dueRecurring,
  getRecurring,
  insertRecurring,
  listExpenses,
  listInvoiceNumbers,
  listInvoices,
  listQuoteNumbers,
  listQuotes,
  listRecurring,
  markOverdue,
  saveRecurring,
  quoteLinesFor,
  saveQuoteStatus,
  saveTotalsAndStatus,
  type ExpenseRow,
  type InvoiceRow,
  type QuoteRow,
} from "./db.js";
import {
  assertAgentMaySend,
  assertFrequency,
  assertQuoteStatus,
  BillingError,
  buildInvoiceHtml,
  canSeeInvoice,
  createExpense,
  lineTotal,
  markPaid,
  markSent,
  nextNumber,
  nextRunDate,
  type InvoiceState,
} from "./domain.js";
import { BILLING_TOOLS } from "./tools.js";

let pluginCtx: PluginContext | null = null;

const plugin = definePlugin({
  async setup(ctx) {
    pluginCtx = ctx;
    for (const tool of BILLING_TOOLS) {
      ctx.tools.register(tool.name, tool, (params, run) => runTool(ctx, tool.name, params, run));
    }
    ctx.actions.register("billing.load", (_params, context) => load(ctx, context));
    ctx.actions.register("billing.create-invoice", (params, context) => createInvoice(ctx, context, params));
    ctx.actions.register("billing.add-line", (params, context) => addLine(ctx, context, params));
    ctx.actions.register("billing.request-send", (params, context) => requestDecision(ctx, context, params, "send"));
    ctx.actions.register("billing.request-pay", (params, context) => requestDecision(ctx, context, params, "pay"));
    ctx.actions.register("billing.create-quote", (params, context) => createQuote(ctx, context, params));
    ctx.actions.register("billing.add-quote-line", (params, context) => addQuoteLine(ctx, context, params));
    ctx.actions.register("billing.convert-quote", (params, context) => convertQuote(ctx, context, params));
    ctx.actions.register("billing.create-expense", (params, context) => createExpenseAction(ctx, context, params));
    ctx.actions.register("billing.create-recurring", (params, context) => createRecurringAction(ctx, context, params));
    ctx.actions.register("billing.list-recurring", (_params, context) => listRecurringAction(ctx, context));
    ctx.actions.register("billing.pause-recurring", (params, context) => setRecurringActive(ctx, context, params, false));
    ctx.actions.register("billing.resume-recurring", (params, context) => setRecurringActive(ctx, context, params, true));
    ctx.jobs.register("mark-overdue", () => markOverdue(ctx));
    ctx.jobs.register("run-recurring", () => runRecurring(ctx));
    ctx.events.on("issue.updated", (event) => onIssueDone(ctx, event.entityId, event.companyId));
    ctx.events.on("company.created", async (event) => {
      if (event.companyId) await safeReconcile(ctx, event.companyId);
    });
    await reconcileAll(ctx);
  },
  async onHealth() {
    return { status: "ok", message: "Billing plugin ready" };
  },
  async onApiRequest(input) {
    if (!pluginCtx) return { status: 503, body: { error: "Billing plugin is not ready" } };
    return acceptGrant(pluginCtx, input);
  },
});

export default plugin;
runWorker(plugin, import.meta.url);

async function runTool(ctx: PluginContext, name: string, params: unknown, run: ToolRunContext): Promise<ToolResult> {
  try {
    const body = objectParams(params);
    if (name === "create-invoice") return { content: "Draft invoice created", data: await createInvoice(ctx, toolContext(run), body) };
    if (name === "add-line") return { content: "Invoice line added", data: await addLine(ctx, toolContext(run), body) };
    if (name === "create-quote") return { content: "Draft quote created", data: await createQuote(ctx, toolContext(run), body) };
    if (name === "add-quote-line") return { content: "Quote line added", data: await addQuoteLine(ctx, toolContext(run), body) };
    if (name === "convert-quote") return { content: "Quote converted to invoice", data: await convertQuote(ctx, toolContext(run), body) };
    if (name === "create-expense") return { content: "Expense recorded", data: await createExpenseAction(ctx, toolContext(run), body) };
    if (name === "invoice-html") return { content: "Invoice HTML generated", data: await invoiceHtml(ctx, toolContext(run), body) };
    if (name === "create-recurring-invoice") return { content: "Recurring invoice scheduled", data: await createRecurringAction(ctx, toolContext(run), body) };
    if (name === "list-recurring-invoices") return { content: "Recurring invoices listed", data: await listRecurringAction(ctx, toolContext(run)) };
    if (name === "pause-recurring-invoice") return { content: "Recurring invoice paused", data: await setRecurringActive(ctx, toolContext(run), body, false) };
    if (name === "resume-recurring-invoice") return { content: "Recurring invoice resumed", data: await setRecurringActive(ctx, toolContext(run), body, true) };
    return { error: "Unknown billing tool" };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Billing tool failed" };
  }
}

function toolContext(run: ToolRunContext): PluginPerformActionContext {
  return {
    companyId: run.companyId,
    actor: { type: "agent", userId: null, agentId: run.agentId, runId: run.runId, companyId: run.companyId },
  };
}

async function load(ctx: PluginContext, context: PluginPerformActionContext) {
  const companyId = requiredCompany(context);
  const invoices = await listInvoices(ctx, companyId);
  const visible = [];
  for (const invoice of invoices) {
    const grants = await grantsForInvoice(ctx, invoice.id);
    if (canSeeInvoice(companyId, invoice.company_id, grants.map((grant) => ({ granteeCompanyId: grant.grantee_company_id })))) {
      visible.push(publicInvoice(invoice));
    }
  }
  const quotes = await listQuotes(ctx, companyId);
  const expenses = await listExpenses(ctx, companyId);
  const recurring = await listRecurring(ctx, companyId);
  return {
    invoices: visible,
    quotes: quotes.map(publicQuote),
    expenses: expenses.map(publicExpense),
    recurring: recurring.map(publicRecurring),
  };
}

async function createInvoice(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const currency = requiredString(params, "currency").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new BillingError("Currency must be a 3-letter code");
  const customerKind = requiredString(params, "customerKind");
  if (customerKind !== "company" && customerKind !== "contact") throw new BillingError("Customer is a company or a contact");
  const existingNumbers = await listInvoiceNumbers(ctx, companyId);
  const row: InvoiceRow = {
    id: randomUUID(),
    company_id: companyId,
    number: nextNumber("INV", existingNumbers),
    status: "draft",
    currency,
    customer_kind: customerKind,
    customer_ref: requiredString(params, "customerRef"),
    sender: { name: optionalString(params, "senderName") ?? "Workspace" },
    customer: { name: requiredString(params, "customerName"), refKind: customerKind, refId: requiredString(params, "customerRef") },
    sender_snapshot: null,
    customer_snapshot: null,
    total_minor: 0,
    due_at: optionalString(params, "dueAt") ?? null,
    approval_issue_id: null,
    pending_action: null,
    sent_at: null,
  };
  await insertInvoice(ctx, row);
  return publicInvoice(row);
}

async function addLine(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const invoice = await requireInvoice(ctx, companyId, requiredString(params, "invoiceId"));
  if (invoice.status !== "draft") throw new BillingError("Lines can only be added to a draft");
  const quantity = integer(params.quantity, "quantity");
  const unitAmountMinor = integer(params.unitAmountMinor, "unitAmountMinor");
  await insertLine(ctx, {
    companyId: invoice.company_id,
    invoiceId: invoice.id,
    description: requiredString(params, "description"),
    quantity,
    unitAmountMinor,
  });
  const lines = await linesFor(ctx, invoice.id);
  invoice.total_minor = lineTotal(lines.map((line) => ({
    quantity: Number(line.quantity),
    unitAmountMinor: Number(line.unit_amount_minor),
  })));
  await saveTotalsAndStatus(ctx, invoice);
  return publicInvoice(invoice);
}

async function requestDecision(
  ctx: PluginContext,
  context: PluginPerformActionContext,
  params: Record<string, unknown>,
  action: "send" | "pay",
) {
  if (context.actor.type === "agent") assertAgentMaySend();
  const companyId = requiredCompany(context);
  const invoice = await requireInvoice(ctx, companyId, requiredString(params, "invoiceId"));
  if (action === "send" && invoice.status !== "draft") throw new BillingError("Only a draft invoice can be sent");
  if (action === "pay" && invoice.status !== "sent" && invoice.status !== "viewed" && invoice.status !== "overdue") {
    throw new BillingError("This invoice cannot be marked paid");
  }
  const issue = await ctx.issues.create({
    companyId: invoice.company_id,
    title: action === "send" ? `Approve sending invoice ${invoice.number}` : `Approve payment of invoice ${invoice.number}`,
    description: `A person marks this issue done to ${action} invoice ${invoice.number}.`,
    status: "todo",
    originKind: "plugin:partnersinbiz.billing",
    originId: invoice.id,
  });
  invoice.approval_issue_id = issue.id;
  invoice.pending_action = action;
  await saveTotalsAndStatus(ctx, invoice);
  return { invoiceId: invoice.id, issueId: issue.id, pendingAction: action };
}

async function onIssueDone(ctx: PluginContext, issueId: string | undefined, companyId: string) {
  if (!issueId) return;
  const issue = await ctx.issues.get(issueId, companyId);
  if (!issue || issue.status !== "done") return;
  const invoice = await invoiceByApproval(ctx, issue.id);
  if (!invoice || !invoice.pending_action) return;
  const state = toState(invoice);
  if (invoice.pending_action === "send") {
    const sent = markSent(state, new Date().toISOString());
    invoice.status = sent.status;
    invoice.sender_snapshot = sent.senderSnapshot;
    invoice.customer_snapshot = sent.customerSnapshot;
    invoice.sent_at = sent.sentAt;
  } else if (invoice.pending_action === "pay") {
    invoice.status = markPaid(state).status;
  }
  invoice.pending_action = null;
  await saveTotalsAndStatus(ctx, invoice);
}

async function acceptGrant(ctx: PluginContext, input: PluginApiRequestInput) {
  if (input.routeKey !== "invoice-grant") return { status: 404, body: { error: "Not found" } };
  try {
    const body = asObject(input.body);
    const invoiceId = String(body.invoiceId ?? "").trim();
    const granteeCompanyId = String(body.granteeCompanyId ?? "").trim();
    if (!invoiceId || !granteeCompanyId) return { status: 400, body: { error: "invoiceId and granteeCompanyId are required" } };
    const invoice = await getInvoice(ctx, invoiceId);
    if (!invoice || invoice.company_id !== input.companyId) return { status: 404, body: { error: "Invoice was not found" } };
    await insertGrant(ctx, { companyId: invoice.company_id, invoiceId, granteeCompanyId });
    return { status: 200, body: { ok: true, invoiceId, granteeCompanyId } };
  } catch (error) {
    return { status: 400, body: { error: error instanceof Error ? error.message : "Grant failed" } };
  }
}

async function createQuote(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const currency = requiredString(params, "currency").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new BillingError("Currency must be a 3-letter code");
  const customerKind = requiredString(params, "customerKind");
  if (customerKind !== "company" && customerKind !== "contact") throw new BillingError("Customer is a company or a contact");
  const existingNumbers = await listQuoteNumbers(ctx, companyId);
  const row: QuoteRow = {
    id: randomUUID(),
    company_id: companyId,
    number: nextNumber("QTE", existingNumbers),
    status: "draft",
    currency,
    customer_kind: customerKind,
    customer_ref: requiredString(params, "customerRef"),
    sender: { name: optionalString(params, "senderName") ?? "Workspace" },
    customer: { name: requiredString(params, "customerName"), refKind: customerKind, refId: requiredString(params, "customerRef") },
    total_minor: 0,
    valid_until: optionalString(params, "validUntil") ?? null,
    converted_invoice_id: null,
  };
  await insertQuote(ctx, row);
  return publicQuote(row);
}

async function addQuoteLine(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const quote = await requireQuote(ctx, companyId, requiredString(params, "quoteId"));
  if (quote.status !== "draft") throw new BillingError("Lines can only be added to a draft quote");
  const quantity = integer(params.quantity, "quantity");
  const unitAmountMinor = integer(params.unitAmountMinor, "unitAmountMinor");
  await insertQuoteLine(ctx, {
    companyId: quote.company_id,
    quoteId: quote.id,
    description: requiredString(params, "description"),
    quantity,
    unitAmountMinor,
  });
  const lines = await quoteLinesFor(ctx, quote.id);
  quote.total_minor = lineTotal(lines.map((line) => ({
    quantity: Number(line.quantity),
    unitAmountMinor: Number(line.unit_amount_minor),
  })));
  await saveQuoteStatus(ctx, quote);
  return publicQuote(quote);
}

async function convertQuote(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const quote = await requireQuote(ctx, companyId, requiredString(params, "quoteId"));
  if (quote.status !== "accepted") throw new BillingError("Only an accepted quote can be converted to an invoice");
  const existingNumbers = await listInvoiceNumbers(ctx, companyId);
  const invoice: InvoiceRow = {
    id: randomUUID(),
    company_id: quote.company_id,
    number: nextNumber("INV", existingNumbers),
    status: "draft",
    currency: quote.currency,
    customer_kind: quote.customer_kind,
    customer_ref: quote.customer_ref,
    sender: asObject(quote.sender),
    customer: asObject(quote.customer),
    sender_snapshot: null,
    customer_snapshot: null,
    total_minor: Number(quote.total_minor),
    due_at: null,
    approval_issue_id: null,
    pending_action: null,
    sent_at: null,
  };
  await insertInvoice(ctx, invoice);
  const lines = await quoteLinesFor(ctx, quote.id);
  for (const line of lines) {
    await insertLine(ctx, {
      companyId: quote.company_id,
      invoiceId: invoice.id,
      description: "Converted from quote",
      quantity: Number(line.quantity),
      unitAmountMinor: Number(line.unit_amount_minor),
    });
  }
  quote.status = "converted";
  quote.converted_invoice_id = invoice.id;
  await saveQuoteStatus(ctx, quote);
  return { quote: publicQuote(quote), invoice: publicInvoice(invoice) };
}

async function createExpenseAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const expense = createExpense({
    companyId,
    description: requiredString(params, "description"),
    amountMinor: integer(params.amountMinor, "amountMinor"),
    currency: optionalString(params, "currency"),
    category: optionalString(params, "category"),
    incurredOn: optionalString(params, "incurredOn") ?? null,
  });
  const row: ExpenseRow = {
    id: expense.id,
    company_id: expense.companyId,
    description: expense.description,
    amount_minor: expense.amountMinor,
    currency: expense.currency,
    category: expense.category,
    incurred_on: expense.incurredOn,
  };
  await insertExpense(ctx, row);
  return publicExpense(row);
}

async function requireQuote(ctx: PluginContext, companyId: string, id: string): Promise<QuoteRow> {
  const quote = await getQuote(ctx, id);
  if (!quote) throw new BillingError("Quote was not found");
  if (quote.company_id !== companyId) throw new BillingError("Quote is not visible");
  return quote;
}

function publicQuote(quote: QuoteRow) {
  return {
    id: quote.id,
    number: quote.number,
    status: quote.status,
    currency: quote.currency,
    customerKind: quote.customer_kind,
    customerRef: quote.customer_ref,
    totalMinor: Number(quote.total_minor),
    validUntil: quote.valid_until == null ? null : String(quote.valid_until),
    convertedInvoiceId: quote.converted_invoice_id,
  };
}

function publicExpense(expense: ExpenseRow) {
  return {
    id: expense.id,
    description: expense.description,
    amountMinor: Number(expense.amount_minor),
    currency: expense.currency,
    category: expense.category,
    incurredOn: expense.incurred_on == null ? null : String(expense.incurred_on),
  };
}

async function invoiceHtml(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const invoice = await requireInvoice(ctx, companyId, requiredString(params, "invoiceId"));
  const lines = await linesFor(ctx, invoice.id);
  return {
    invoiceId: invoice.id,
    html: buildInvoiceHtml({
      number: invoice.number,
      status: invoice.status,
      currency: invoice.currency,
      sender: asObject(invoice.sender),
      customer: asObject(invoice.customer),
      lines: lines.map((line) => ({
        description: "Line item",
        quantity: Number(line.quantity),
        unitAmountMinor: Number(line.unit_amount_minor),
      })),
      dueAt: invoice.due_at == null ? null : String(invoice.due_at),
    }),
  };
}

async function createRecurringAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const template = await requireInvoice(ctx, companyId, requiredString(params, "templateInvoiceId"));
  const frequency = assertFrequency(requiredString(params, "frequency"));
  const nextRunAt = requiredString(params, "nextRunAt");
  if (Number.isNaN(Date.parse(nextRunAt))) throw new BillingError("nextRunAt must be a time");
  const row = {
    id: randomUUID(),
    company_id: companyId,
    template_invoice_id: template.id,
    frequency,
    next_run_at: nextRunAt,
    is_active: true,
  };
  await insertRecurring(ctx, row);
  return publicRecurring(row);
}

async function listRecurringAction(ctx: PluginContext, context: PluginPerformActionContext) {
  const companyId = requiredCompany(context);
  const rows = await listRecurring(ctx, companyId);
  return rows.map(publicRecurring);
}

async function setRecurringActive(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>, active: boolean) {
  const companyId = requiredCompany(context);
  const row = await getRecurring(ctx, requiredString(params, "recurringId"));
  if (!row || row.company_id !== companyId) throw new BillingError("Recurring schedule was not found");
  row.is_active = active;
  await saveRecurring(ctx, row);
  return publicRecurring(row);
}

async function runRecurring(ctx: PluginContext) {
  const due = await dueRecurring(ctx);
  for (const schedule of due) {
    try {
      const template = await getInvoice(ctx, schedule.template_invoice_id);
      if (!template) {
        schedule.is_active = false;
        await saveRecurring(ctx, schedule);
        continue;
      }
      const existingNumbers = await listInvoiceNumbers(ctx, schedule.company_id);
      const invoice: InvoiceRow = {
        id: randomUUID(),
        company_id: schedule.company_id,
        number: nextNumber("INV", existingNumbers),
        status: "draft",
        currency: template.currency,
        customer_kind: template.customer_kind,
        customer_ref: template.customer_ref,
        sender: asObject(template.sender),
        customer: asObject(template.customer),
        sender_snapshot: null,
        customer_snapshot: null,
        total_minor: Number(template.total_minor),
        due_at: null,
        approval_issue_id: null,
        pending_action: null,
        sent_at: null,
      };
      await insertInvoice(ctx, invoice);
      const lines = await linesFor(ctx, template.id);
      for (const line of lines) {
        await insertLine(ctx, {
          companyId: schedule.company_id,
          invoiceId: invoice.id,
          description: "Recurring line",
          quantity: Number(line.quantity),
          unitAmountMinor: Number(line.unit_amount_minor),
        });
      }
      schedule.next_run_at = nextRunDate(new Date(), schedule.frequency as "monthly" | "quarterly" | "yearly").toISOString();
      await saveRecurring(ctx, schedule);
    } catch (error) {
      ctx.logger.error("Recurring invoice failed", {
        scheduleId: schedule.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function publicRecurring(row: { id: string; company_id: string; template_invoice_id: string; frequency: string; next_run_at: unknown; is_active: boolean }) {
  return {
    id: row.id,
    templateInvoiceId: row.template_invoice_id,
    frequency: row.frequency,
    nextRunAt: row.next_run_at == null ? null : String(row.next_run_at),
    isActive: row.is_active,
  };
}

async function requireInvoice(ctx: PluginContext, companyId: string, id: string): Promise<InvoiceRow> {
  const invoice = await getInvoice(ctx, id);
  if (!invoice) throw new BillingError("Invoice was not found");
  const grants = await grantsForInvoice(ctx, invoice.id);
  if (!canSeeInvoice(companyId, invoice.company_id, grants.map((grant) => ({ granteeCompanyId: grant.grantee_company_id })))) {
    throw new BillingError("Invoice is not visible");
  }
  return invoice;
}

function toState(invoice: InvoiceRow): InvoiceState {
  return {
    status: invoice.status,
    sender: asObject(invoice.sender),
    customer: asObject(invoice.customer),
    senderSnapshot: invoice.sender_snapshot == null ? null : asObject(invoice.sender_snapshot),
    customerSnapshot: invoice.customer_snapshot == null ? null : asObject(invoice.customer_snapshot),
    sentAt: invoice.sent_at == null ? null : String(invoice.sent_at),
  };
}

function publicInvoice(invoice: InvoiceRow) {
  return {
    id: invoice.id,
    number: invoice.number,
    status: invoice.status,
    currency: invoice.currency,
    customerKind: invoice.customer_kind,
    customerRef: invoice.customer_ref,
    totalMinor: Number(invoice.total_minor),
    pendingAction: invoice.pending_action,
    approvalIssueId: invoice.approval_issue_id,
  };
}

function requiredCompany(context: PluginPerformActionContext): string {
  if (!context.companyId) throw new BillingError("Company is required");
  return context.companyId;
}

function objectParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BillingError("Parameters must be an object");
  return value as Record<string, unknown>;
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) throw new BillingError(`${key} is required`);
  return value.trim();
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") throw new BillingError(`${key} must be a string`);
  return value.trim();
}

function integer(value: unknown, key: string): number {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(amount)) throw new BillingError(`${key} must be an integer`);
  return amount;
}

async function reconcileAll(ctx: PluginContext) {
  try {
    const companies = await ctx.companies.list({ limit: 100 });
    for (const company of companies) await safeReconcile(ctx, company.id);
  } catch (error) {
    ctx.logger.info("Billing skill reconcile deferred", { error: error instanceof Error ? error.message : String(error) });
  }
}

async function safeReconcile(ctx: PluginContext, companyId: string) {
  try {
    await ctx.skills.managed.reconcile("invoice-draft", companyId);
  } catch (error) {
    ctx.logger.info("Billing skill reconcile skipped", { companyId, error: error instanceof Error ? error.message : String(error) });
  }
}
