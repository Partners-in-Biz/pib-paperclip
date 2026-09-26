import { randomUUID } from "node:crypto";
import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginApiResponse,
  type PluginContext,
  type PluginEvent,
  type PluginPerformActionContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import {
  configSaved,
  correctDecision,
  createSkillSyncer,
  createWorkIssue,
  listCrmClients,
  parseClientParam,
  PIB_PLUGINS,
  redeliver,
  registerCrmProjection,
  registerModuleWatch,
  rememberPluginUiBase,
  resolveCrmClient,
  retryOutbox,
  SETUP_STATUS_ROUTE,
  TAX_CODES,
  toolFail,
  toolOk,
  type ClientRef,
} from "@partnersinbiz/pib-plugin-kit";
import { customerCredit, invoiceBalance, invoiceBalances, iso, type InvoiceBalance } from "./balances.js";
import { BANK_MATCHED_EVENT } from "./bank.js";
import {
  anthropicConfig,
  billingSettings,
  dunningStages,
  emailEnabled,
  expenseCategories,
  jevFor,
  ledgerEnabled,
  loadBilling,
  privateR2,
  r2Configured,
  reportingCurrency,
} from "./config.js";
import {
  approveBillAction,
  addBillLine,
  attachBillFile,
  billDetail,
  cancelBill,
  createBill,
  createExpenseAction,
  fileUrl,
  listBills,
  payBill,
  publicExpense,
  receiptToExpense,
  removeBillLine,
  requestBillApproval,
  updateBill,
  updateExpense,
  uploadUrl,
  voidExpense,
} from "./costs.js";
import { createCreditNoteAction, creditNotePdf, publicCreditNote, sendCreditNote, sendStatement, statementPdf } from "./credits.js";
import {
  asObject,
  billingCompanyIds,
  customerInvoiceBalances,
  dueRecurring,
  getExpense,
  getInvoice,
  getRecurring,
  insertGrant,
  insertInvoice,
  insertRecurring,
  linesFor,
  listCreditNotes,
  listExpenses,
  listInvoices,
  listQuotes,
  listRecurring,
  markOverdue,
  paymentsForInvoice,
  saveRecurring,
  saveTotalsAndStatus,
  table,
  type InvoiceRow,
} from "./db.js";
import { clientBillingSummary, assertAgentMaySend, assertFrequency, assertTaxRate, BillingError, buildInvoiceHtml, canSeeInvoice, type ClientSummary } from "./domain.js";
import { claimReminder, plannedReminders, reminderVars, setReminderStatus } from "./dunning.js";
import { docFileName, renderDocument } from "./documents.js";
import { refreshDailyRates } from "./fx.js";
import { markFailedDeliveries, MAIL_RECEIVED_EVENT, MAIL_RESULT_EVENT, onBankMatchedEvent, onIssueUpdated, onLedgerPostResult, onMailReceived, onMailResult } from "./inbound.js";
import {
  addLine,
  addQuoteLine,
  advanceSchedule,
  cancelInvoice,
  convertQuote,
  copyInvoiceFields,
  copyLines,
  createInvoice,
  createQuote,
  customerNameOf,
  documentPdf,
  invoiceView,
  markSentAction,
  publicInvoice,
  publicQuote,
  quoteView,
  recipientsFor,
  recomputeInvoice,
  removeLine,
  removeQuoteLine,
  requireInvoice,
  requireOwnInvoice,
  requireQuote,
  retrySend,
  setInvoiceTax,
  setQuoteStatus,
  startInvoiceSend,
  updateInvoice,
  updateLine,
  updateQuote,
  updateQuoteLine,
} from "./invoices.js";
import { deliveriesFor, failStaleDeliveries, parseAddresses, queueMail, reminderEmail } from "./mail.js";
import { nextDocumentNumber } from "./numbering.js";
import { emitOpenItems } from "./openitems.js";
import { confirmPop, getPop, listPops, recordPop, rejectPop } from "./pop.js";
import { LEDGER_RESULT_EVENT } from "./posting.js";
import { buildReports } from "./reporting.js";
import { createPlan, createSubscription, listRetainers, runSubscriptions, setSubscriptionStatus, updatePlan } from "./retainers.js";
import { applyCustomerCredit, settle, writeOff } from "./settle.js";
import { billingOn, knownCompanyIds, publishAllSetupStatus, setupStatus } from "./setup.js";
import { SKILLS } from "./skills.js";
import { documentKey, MAIL_LINK_SECONDS, presignGet, putObject, assertOwnKey } from "./storage.js";
import { billTime, deleteTimeEntry, listTime, logTime, startTimer, stopTimer } from "./time.js";
import { BILLING_TOOLS } from "./tools.js";
import {
  actorLabel,
  dayOf,
  errorMessage,
  integer,
  isoOrNull,
  objectParams,
  optionalBoolean,
  optionalDate,
  optionalInteger,
  optionalString,
  readClientScope,
  requiredCompany,
  requiredString,
  requirePerson,
  toolContext,
} from "./util.js";

let pluginCtx: PluginContext | null = null;
let skillSync: ReturnType<typeof createSkillSyncer> | null = null;

type Handler = (ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) => Promise<unknown>;

/** Action key (UI) → handler. Tools reuse the same handlers. */
const ACTIONS: Record<string, Handler> = {
  "billing.load": (ctx, context, params) => load(ctx, context, params),
  "billing.invoice-html": (ctx, context, params) => invoiceHtml(ctx, context, params),
  "billing.quote-html": (ctx, context, params) => quoteHtml(ctx, context, params),
  "billing.create-invoice": createInvoice,
  "billing.add-line": addLine,
  "billing.update-line": updateLine,
  "billing.remove-line": removeLine,
  "billing.update-invoice": updateInvoice,
  "billing.invoice-detail": (ctx, context, params) => invoiceDetail(ctx, context, params),
  "billing.request-send": (ctx, context, params) => requestDecision(ctx, context, params, "send"),
  "billing.request-pay": (ctx, context, params) => requestDecision(ctx, context, params, "pay"),
  "billing.mark-sent": markSentAction,
  "billing.retry-send": retrySend,
  "billing.cancel-invoice": cancelInvoice,
  "billing.document-pdf": documentPdf,
  "billing.create-quote": createQuote,
  "billing.add-quote-line": addQuoteLine,
  "billing.update-quote-line": updateQuoteLine,
  "billing.remove-quote-line": removeQuoteLine,
  "billing.update-quote": updateQuote,
  "billing.quote-detail": (ctx, context, params) => quoteDetail(ctx, context, params),
  "billing.set-quote-status": setQuoteStatus,
  "billing.request-quote-send": (ctx, context, params) => requestQuoteSend(ctx, context, params),
  "billing.convert-quote": convertQuote,
  "billing.create-expense": createExpenseAction,
  "billing.update-expense": updateExpense,
  "billing.void-expense": voidExpense,
  "billing.receipt-to-expense": receiptToExpense,
  "billing.receipt-file": async (ctx, context, params) => {
    const companyId = requiredCompany(context);
    const expense = await getExpense(ctx, requiredString(params, "expenseId"));
    if (!expense || expense.company_id !== companyId) throw new BillingError("Expense was not found");
    return fileUrl(ctx, companyId, expense.receipt_key ?? null, expense.receipt_name ?? null);
  },
  "billing.upload-url": uploadUrl,
  "billing.create-recurring": (ctx, context, params) => createRecurringAction(ctx, context, params),
  "billing.list-recurring": (ctx, context) => listRecurringAction(ctx, context),
  "billing.pause-recurring": (ctx, context, params) => setRecurringActive(ctx, context, params, false),
  "billing.resume-recurring": (ctx, context, params) => setRecurringActive(ctx, context, params, true),
  "billing.update-recurring": (ctx, context, params) => updateRecurring(ctx, context, params),
  "billing.record-payment": (ctx, context, params) => recordPayment(ctx, context, params),
  "billing.invoice-payments": (ctx, context, params) => invoicePayments(ctx, context, params),
  "billing.set-invoice-tax": (ctx, context, params) => setInvoiceTax(ctx, context, params, assertTaxRate(params.taxRate)),
  "billing.create-credit-note": createCreditNoteAction,
  "billing.list-credit-notes": (ctx, context) => listCreditNotesAction(ctx, context),
  "billing.credit-note-pdf": creditNotePdf,
  "billing.send-credit-note": sendCreditNote,
  "billing.statement-pdf": statementPdf,
  "billing.send-statement": sendStatement,
  "billing.apply-credit": async (ctx, context, params) => {
    const createdBy = requirePerson(context, "applying credit");
    const sourceKind = requiredString(params, "sourceKind");
    if (sourceKind !== "credit_note" && sourceKind !== "payment") throw new BillingError("sourceKind is credit_note or payment");
    return applyCustomerCredit(ctx, { companyId: requiredCompany(context), invoiceId: requiredString(params, "invoiceId"), sourceKind, sourceId: requiredString(params, "sourceId"), amountMinor: optionalInteger(params, "amountMinor") ?? null, createdBy });
  },
  "billing.write-off": async (ctx, context, params) => {
    const createdBy = requirePerson(context, "writing off an invoice");
    const companyId = requiredCompany(context);
    await requireOwnInvoice(ctx, companyId, requiredString(params, "invoiceId"));
    return writeOff(ctx, { companyId, invoiceId: requiredString(params, "invoiceId"), reason: optionalString(params, "reason") ?? null, createdBy }, await billingSettings(ctx, companyId));
  },
  "billing.pops": async (ctx, context, params) => {
    const companyId = requiredCompany(context);
    return (await listPops(ctx, companyId, { status: optionalString(params, "status") })).map((pop) => publicPop(pop));
  },
  "billing.register-pop": (ctx, context, params) => registerPop(ctx, context, params),
  "billing.confirm-pop": async (ctx, context, params) => {
    const createdBy = requirePerson(context, "confirming a payment");
    const companyId = requiredCompany(context);
    const result = await confirmPop(ctx, {
      companyId,
      popId: requiredString(params, "popId"),
      invoiceId: optionalString(params, "invoiceId") ?? null,
      amountMinor: optionalInteger(params, "amountMinor") ?? null,
      paidAt: optionalDate(params, "paidAt") ?? null,
      reference: optionalString(params, "reference") ?? null,
      createdBy,
    }, await billingSettings(ctx, companyId));
    await closePopIssue(ctx, companyId, requiredString(params, "popId"));
    return result;
  },
  "billing.reject-pop": async (ctx, context, params) => {
    const reviewedBy = requirePerson(context, "rejecting a proof of payment");
    const companyId = requiredCompany(context);
    const result = await rejectPop(ctx, { companyId, popId: requiredString(params, "popId"), reason: optionalString(params, "reason") ?? null, reviewedBy });
    await closePopIssue(ctx, companyId, requiredString(params, "popId"), "cancelled");
    return result;
  },
  "billing.pop-file": async (ctx, context, params) => {
    const companyId = requiredCompany(context);
    const pop = await getPop(ctx, requiredString(params, "popId"));
    if (!pop || pop.company_id !== companyId) throw new BillingError("Proof of payment was not found");
    return fileUrl(ctx, companyId, pop.file_key, pop.file_name);
  },
  "billing.create-bill": createBill,
  "billing.add-bill-line": addBillLine,
  "billing.remove-bill-line": removeBillLine,
  "billing.update-bill": updateBill,
  "billing.bill-detail": async (ctx, context, params) => billDetail(ctx, requiredCompany(context), requiredString(params, "billId")),
  "billing.approve-bill": approveBillAction,
  "billing.request-bill-approval": requestBillApproval,
  "billing.pay-bill": payBill,
  "billing.cancel-bill": cancelBill,
  "billing.attach-bill-file": attachBillFile,
  "billing.bill-file": async (ctx, context, params) => {
    const companyId = requiredCompany(context);
    const detail = await billDetail(ctx, companyId, requiredString(params, "billId"));
    const rows = await ctx.db.query<{ file_key: string | null; file_name: string | null }>(`SELECT file_key, file_name FROM ${table(ctx, "bills")} WHERE id = $1`, [detail.id]);
    return fileUrl(ctx, companyId, rows[0]?.file_key ?? null, rows[0]?.file_name ?? null);
  },
  "billing.start-timer": startTimer,
  "billing.stop-timer": stopTimer,
  "billing.log-time": logTime,
  "billing.list-time": async (ctx, context, params) => {
    const scope = readClientScope(params) ?? null;
    return listTime(ctx, requiredCompany(context), { customerKind: scope?.kind, customerRef: scope?.id, unbilled: optionalBoolean(params, "unbilled") });
  },
  "billing.delete-time-entry": deleteTimeEntry,
  "billing.bill-time": billTime,
  "billing.create-plan": createPlan,
  "billing.update-plan": updatePlan,
  "billing.create-subscription": createSubscription,
  "billing.set-subscription-status": setSubscriptionStatus,
  "billing.retainers": async (ctx, context, params) => listRetainers(ctx, requiredCompany(context), readClientScope(params) ?? null),
  "billing.reports": (ctx, context, params) => reportsAction(ctx, context, params),
  "billing.dunning": (ctx, context, params) => dunningStatus(ctx, context, params),
  "billing.set-dunning-optout": (ctx, context, params) => setDunningOptOut(ctx, context, params),
  "billing.run-dunning": async (ctx, context) => {
    requirePerson(context, "sending reminders");
    return runDunningFor(ctx, requiredCompany(context), true);
  },
  "billing.customer-credit": async (ctx, context, params) => {
    const scope = readClientScope(params);
    if (!scope) throw new BillingError("client is required");
    return customerCredit(ctx, requiredCompany(context), scope.kind, scope.id);
  },
  "billing.retry-ledger": async (ctx, context, params) => {
    requirePerson(context, "re-posting a journal");
    const key = requiredString(params, "key");
    if (!key.startsWith("billing:")) throw new BillingError("Unknown journal key");
    return { retried: await retryOutbox(ctx, key) };
  },
  "billing.correct-decision": async (ctx, context, params) => {
    const userId = requirePerson(context, "correcting a decision");
    return { ok: await correctDecision(ctx, requiredCompany(context), requiredString(params, "decisionId"), requiredString(params, "correctedTo"), userId) };
  },
};

const plugin = definePlugin({
  async setup(ctx) {
    pluginCtx = ctx;
    skillSync = createSkillSyncer(ctx, SKILLS);
    registerCrmProjection(ctx, ctx.db.namespace, { companies: true, contacts: true });
    registerModuleWatch(ctx);
    for (const tool of BILLING_TOOLS) {
      ctx.tools.register(tool.name, tool, (params, run) => {
        void skillSync?.ensure(run.companyId);
        return runTool(ctx, tool.name, params, run);
      });
    }
    for (const [key, handler] of Object.entries(ACTIONS)) {
      ctx.actions.register(key, (params, context) => {
        if (context.companyId && key === "billing.load") void skillSync?.ensure(context.companyId);
        return handler(ctx, context, params ?? {});
      });
    }
    ctx.actions.register("billing.sync-skills", async (_params, context) => ({ results: await skillSync?.force(requiredCompany(context)) }));

    ctx.jobs.register("mark-overdue", () => markOverdueJob(ctx));
    ctx.jobs.register("run-recurring", () => runRecurring(ctx));
    ctx.jobs.register("redeliver", () => redeliverJob(ctx));
    ctx.jobs.register("emit-open-items", () => emitOpenItemsJob(ctx, 1800));
    ctx.jobs.register("emit-open-items-all", () => emitOpenItemsJob(ctx, null));
    ctx.jobs.register("dunning", () => dunningJob(ctx));
    ctx.jobs.register("fx-rates", () => fxJob(ctx));

    const guard = (label: string, fn: (event: PluginEvent) => Promise<void>) => async (event: PluginEvent) => {
      try {
        await fn(event);
      } catch (error) {
        ctx.logger.error(`Billing ${label} failed`, { error: errorMessage(error) });
        throw error;
      }
    };
    ctx.events.on("issue.updated", guard("issue update", (event) => onIssueUpdated(ctx, event.entityId, event.companyId)));
    ctx.events.on("plugin.partnersinbiz.partners.grant.revoked", (event) => onPartnerGrantRevoked(ctx, event.companyId, event.payload));
    ctx.events.on(MAIL_RESULT_EVENT, guard("mail result", (event) => onMailResult(ctx, event)));
    ctx.events.on(MAIL_RECEIVED_EVENT, guard("inbound mail", (event) => onMailReceived(ctx, event)));
    ctx.events.on(LEDGER_RESULT_EVENT, guard("ledger result", (event) => onLedgerPostResult(ctx, event)));
    ctx.events.on(BANK_MATCHED_EVENT, guard("bank match", (event) => onBankMatchedEvent(ctx, event)));
    ctx.events.on("company.created", async (event) => {
      if (event.companyId) await skillSync?.ensure(event.companyId);
    });
  },
  async onHealth() {
    return { status: "ok", message: "Billing plugin ready" };
  },
  async onApiRequest(input) {
    if (!pluginCtx) return { status: 503, body: { error: "Billing plugin is not ready" } };
    if (input.routeKey === "client-summary") return clientSummaryRoute(pluginCtx, input);
    if (input.routeKey === SETUP_STATUS_ROUTE.routeKey) return setupStatusRoute(pluginCtx, input);
    return acceptGrant(pluginCtx, input);
  },
});

export default plugin;
runWorker(plugin, import.meta.url);

// ── Tools ──────────────────────────────────────────────────────────────────

const TOOL_ACTIONS: Record<string, { action: string; message: string; person?: boolean }> = {
  "create-invoice": { action: "billing.create-invoice", message: "Draft invoice created" },
  "add-line": { action: "billing.add-line", message: "Invoice line added" },
  "update-line": { action: "billing.update-line", message: "Invoice line changed" },
  "remove-line": { action: "billing.remove-line", message: "Invoice line removed" },
  "update-invoice": { action: "billing.update-invoice", message: "Invoice changed" },
  "invoice-detail": { action: "billing.invoice-detail", message: "Invoice loaded" },
  "create-quote": { action: "billing.create-quote", message: "Draft quote created" },
  "add-quote-line": { action: "billing.add-quote-line", message: "Quote line added" },
  "convert-quote": { action: "billing.convert-quote", message: "Quote converted to invoice" },
  "set-quote-status": { action: "billing.set-quote-status", message: "Quote status changed" },
  "create-expense": { action: "billing.create-expense", message: "Expense recorded" },
  "invoice-html": { action: "billing.invoice-html", message: "Invoice HTML generated" },
  "create-recurring-invoice": { action: "billing.create-recurring", message: "Recurring invoice scheduled" },
  "list-recurring-invoices": { action: "billing.list-recurring", message: "Recurring invoices listed" },
  "pause-recurring-invoice": { action: "billing.pause-recurring", message: "Recurring invoice paused" },
  "resume-recurring-invoice": { action: "billing.resume-recurring", message: "Recurring invoice resumed" },
  "record-payment": { action: "billing.record-payment", message: "Payment recorded" },
  "invoice-payments": { action: "billing.invoice-payments", message: "Payments listed" },
  "set-invoice-tax": { action: "billing.set-invoice-tax", message: "Invoice tax set" },
  "quote-html": { action: "billing.quote-html", message: "Quote HTML generated" },
  "create-credit-note": { action: "billing.create-credit-note", message: "Credit note created" },
  "list-credit-notes": { action: "billing.list-credit-notes", message: "Credit notes listed" },
  "list-open-invoices": { action: "billing.open-invoices", message: "Open invoices listed" },
  "list-proofs-of-payment": { action: "billing.pops", message: "Proofs of payment listed" },
  "create-bill": { action: "billing.create-bill", message: "Draft bill created" },
  "add-bill-line": { action: "billing.add-bill-line", message: "Bill line added" },
  "request-bill-approval": { action: "billing.request-bill-approval", message: "Bill approval issue opened" },
  "list-bills": { action: "billing.list-bills", message: "Bills listed" },
  "start-timer": { action: "billing.start-timer", message: "Timer started" },
  "stop-timer": { action: "billing.stop-timer", message: "Timer stopped" },
  "log-time": { action: "billing.log-time", message: "Time logged" },
  "list-time-entries": { action: "billing.list-time", message: "Time entries listed" },
  "bill-time": { action: "billing.bill-time", message: "Time added to the invoice" },
  "create-retainer-plan": { action: "billing.create-plan", message: "Retainer plan created" },
  "create-subscription": { action: "billing.create-subscription", message: "Retainer subscription created" },
  "list-retainers": { action: "billing.retainers", message: "Retainers listed" },
  "billing-report": { action: "billing.reports", message: "Billing reports built" },
  "customer-credit": { action: "billing.customer-credit", message: "Customer credit listed" },
};

ACTIONS["billing.open-invoices"] = async (ctx, context, params) => {
  const companyId = requiredCompany(context);
  const scope = readClientScope(params) ?? null;
  const open = await invoiceBalances(ctx, companyId, { openOnly: true, customerKind: scope?.kind, customerRef: scope?.id });
  return open.map(balanceOut);
};
ACTIONS["billing.list-bills"] = async (ctx, context) => listBills(ctx, requiredCompany(context));

/** Tool results are always objects (MCP structuredContent): lists as `{ items }`, errors as `{ ok: false, error }`. */
async function runTool(ctx: PluginContext, name: string, params: unknown, run: ToolRunContext): Promise<ToolResult> {
  try {
    const body = objectParams(params);
    const entry = TOOL_ACTIONS[name];
    const handler = entry ? ACTIONS[entry.action] : undefined;
    if (!entry || !handler) return toolFail("Unknown billing tool");
    return toolOk(entry.message, await handler(ctx, toolContext(run), body));
  } catch (error) {
    return toolFail(error instanceof Error ? error.message : "Billing tool failed");
  }
}

// ── Page snapshot ──────────────────────────────────────────────────────────

export function balanceOut(balance: InvoiceBalance) {
  return {
    ...publicInvoice(balance.invoice),
    paidMinor: balance.state.paidMinor,
    creditedMinor: balance.state.creditedMinor,
    writtenOffMinor: balance.state.writtenOffMinor,
    outstandingMinor: balance.outstandingMinor,
    pendingPops: balance.state.pendingPops,
  };
}

function publicPop(pop: Awaited<ReturnType<typeof listPops>>[number], numbers?: Map<string, string>) {
  return {
    id: pop.id,
    invoiceId: pop.invoice_id,
    invoiceNumber: pop.invoice_id ? numbers?.get(pop.invoice_id) ?? null : null,
    source: pop.source,
    matchBasis: pop.match_basis,
    status: pop.status,
    amountMinor: pop.amount_minor == null ? null : Number(pop.amount_minor),
    reference: pop.reference,
    fromEmail: pop.from_email,
    fromName: pop.from_name,
    subject: pop.subject,
    snippet: pop.snippet,
    hasFile: Boolean(pop.file_key),
    fileName: pop.file_name,
    attachments: Array.isArray(pop.attachments) ? pop.attachments : [],
    issueId: pop.issue_id,
    paymentId: pop.payment_id,
    rejectReason: pop.reject_reason,
    receivedAt: iso(pop.received_at),
  };
}

/**
 * The Billing page. Without `client` it is PiB's whole book. With `client`
 * (a CRM company or contact) it is that customer's invoices, quotes,
 * recurring schedules, credit notes, proofs of payment, time and retainers —
 * no bills or expenses (they are PiB's own costs).
 */
async function load(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown> = {}) {
  const companyId = requiredCompany(context);
  // The page reports /_plugins/<installation uuid>/ui/ so Setup can link to the settings page.
  await rememberPluginUiBase(ctx, params.uiBase);
  const scope = readClientScope(params) ?? null;
  const invoices = await listInvoices(ctx, companyId, scope);
  const own = await invoiceBalances(ctx, companyId, scope ? { customerKind: scope.kind, customerRef: scope.id } : {});
  const byId = new Map(own.map((b) => [b.invoice.id, b]));
  const visible = [];
  for (const invoice of invoices) {
    const balance = byId.get(invoice.id);
    if (balance) {
      visible.push(balanceOut(balance));
      continue;
    }
    // Shared by a partner company (read-only here).
    const grants = await ctx.db.query<{ grantee_company_id: string }>(`SELECT grantee_company_id FROM ${table(ctx, "invoice_grants")} WHERE invoice_id = $1`, [invoice.id]);
    if (canSeeInvoice(companyId, invoice.company_id, grants.map((grant) => ({ granteeCompanyId: grant.grantee_company_id })))) {
      visible.push({ ...publicInvoice(invoice), paidMinor: 0, creditedMinor: 0, writtenOffMinor: 0, outstandingMinor: 0, pendingPops: 0, shared: true });
    }
  }
  const numbers = new Map(own.map((b) => [b.invoice.id, b.invoice.number]));
  const quotes = await listQuotes(ctx, companyId, scope);
  const expenses = scope ? [] : await listExpenses(ctx, companyId);
  const recurring = await listRecurring(ctx, companyId, scope);
  const creditNotes = await listCreditNotes(ctx, companyId, scope);
  const { settings } = await loadBilling(ctx, companyId);
  const clients = scope ? [] : await listCrmClients(ctx, ctx.db.namespace, companyId).catch(() => []);
  const pops = (await listPops(ctx, companyId, scope ? { invoiceIds: own.map((b) => b.invoice.id) } : {})).map((pop) => publicPop(pop, numbers));
  const time = await listTime(ctx, companyId, scope ? { customerKind: scope.kind, customerRef: scope.id } : {});
  const retainers = await listRetainers(ctx, companyId, scope);
  const optedOut = scope
    ? (await ctx.db.query(`SELECT 1 AS x FROM ${table(ctx, "dunning_optouts")} WHERE company_id = $1 AND customer_kind = $2 AND customer_ref = $3`, [companyId, scope.kind, scope.id])).length > 0
    : false;
  return {
    settingsSaved: Object.keys(settings).length > 0,
    defaults: {
      currency: settings.defaultCurrency ?? "ZAR",
      taxRate: Number(settings.defaultTaxRate ?? 0),
      taxCode: settings.defaultTaxCode ?? null,
      senderName: String(asObject(settings.sender).name ?? "Partners in Biz"),
      pricesIncludeVat: Boolean(settings.pricesIncludeVat),
      reportingCurrency: reportingCurrency(settings),
      hourlyRateMinor: Math.max(0, Math.floor(Number(settings.defaultHourlyRateMinor ?? 0))),
    },
    features: {
      email: emailEnabled(settings),
      r2: r2Configured(settings),
      // Presence only: resolving secrets on every page load would eat the host's 30/min limit.
      receipts: settings.anthropic?.extractReceipts !== false && Boolean(settings.anthropic?.apiKey),
      jev: settings.jev?.enabled !== false && Boolean(settings.jev?.apiKey),
      ledger: ledgerEnabled(settings),
      dunning: settings.dunning?.enabled === true,
      numbering: settings.numbering?.mode === "sequential" ? "sequential" : "client",
    },
    taxCodes: Object.entries(TAX_CODES).map(([code, info]) => ({ code, label: info.label, rate: info.rate })),
    expenseCategories: expenseCategories(settings),
    client: scope ? await clientDetails(ctx, companyId, scope, [...invoices, ...quotes]) : null,
    clients: clients.map((client) => ({ kind: client.kind, id: client.id, name: client.name, email: client.email })),
    invoices: visible,
    quotes: quotes.map(publicQuote),
    expenses: expenses.map(publicExpense),
    bills: scope ? [] : await listBills(ctx, companyId),
    recurring: recurring.map(publicRecurring),
    creditNotes: creditNotes.map((note) => publicCreditNote(note, numbers.get(note.invoice_id))),
    pops,
    time,
    retainers,
    customerCredit: scope ? await customerCredit(ctx, companyId, scope.kind, scope.id) : [],
    dunningOptOut: optedOut,
  };
}

/** The workspace header's client. `found: false` when the CRM projection does not know it (yet). */
async function clientDetails(ctx: PluginContext, companyId: string, scope: ClientRef, documents: Array<{ customer: unknown }>) {
  const client = await resolveCrmClient(ctx, ctx.db.namespace, companyId, scope).catch(() => null);
  const billedAs = documents.map((doc) => customerNameOf(doc.customer)).find((name): name is string => Boolean(name)) ?? null;
  return {
    kind: scope.kind,
    id: scope.id,
    name: client?.name ?? billedAs,
    detail: client?.email ?? client?.domain ?? null,
    found: Boolean(client),
  };
}

async function invoiceDetail(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const invoice = await requireInvoice(ctx, companyId, requiredString(params, "invoiceId"));
  const { settings } = await loadBilling(ctx, companyId);
  const view = await invoiceView(ctx, invoice, settings);
  const balance = await invoiceBalance(ctx, invoice.id);
  const lines = await linesFor(ctx, invoice.id);
  const payments = await paymentsForInvoice(ctx, invoice.id);
  const applications = await ctx.db.query<{ id: string; source_kind: string; source_id: string; amount_minor: string | number; created_at: unknown }>(
    `SELECT id, source_kind, source_id, amount_minor, created_at FROM ${table(ctx, "credit_applications")} WHERE invoice_id = $1 ORDER BY created_at`,
    [invoice.id],
  );
  const notes = await ctx.db.query<Parameters<typeof publicCreditNote>[0]>(
    `SELECT id, company_id, invoice_id, amount_minor, reason, status, created_at, number, currency, customer_kind, customer_ref, issued_on::text AS issued_on, pdf_key,
            delivery_key, delivery_status, delivery_error, mail_seq, ledger_status, journal_number, created_by
       FROM ${table(ctx, "credit_notes")} WHERE invoice_id = $1 ORDER BY created_at`,
    [invoice.id],
  );
  const pops = await listPops(ctx, companyId, { invoiceIds: [invoice.id] });
  const deliveries = await deliveriesFor(ctx, invoice.company_id, "invoice", invoice.id);
  const reminders = await ctx.db.query<{ stage: number; status: string; created_at: unknown; error: string | null }>(
    `SELECT stage, status, created_at, error FROM ${table(ctx, "reminders")} WHERE invoice_id = $1 ORDER BY stage`,
    [invoice.id],
  );
  const recipients = await recipientsFor(ctx, invoice.company_id, invoice);
  return {
    invoice: balance ? balanceOut(balance) : publicInvoice(invoice),
    readOnly: invoice.company_id !== companyId,
    lines: lines.map((line, i) => ({
      id: line.id,
      description: line.description,
      quantity: Number(line.quantity),
      unitAmountMinor: Number(line.unit_amount_minor),
      taxCode: line.tax_code ?? null,
      netMinor: view.lines[i]?.netMinor ?? 0,
      vatMinor: view.lines[i]?.vatMinor ?? 0,
      grossMinor: view.lines[i]?.grossMinor ?? 0,
      fromTime: Boolean(line.time_entry_id),
    })),
    groups: view.groups,
    legacyVat: view.legacy,
    payments: payments.map((p) => ({
      id: p.id,
      amountMinor: Number(p.amount_minor),
      allocatedMinor: Number(p.allocated_minor ?? p.amount_minor),
      creditMinor: Math.max(0, Number(p.amount_minor) - Number(p.allocated_minor ?? p.amount_minor)),
      method: p.method,
      reference: p.reference,
      source: p.source ?? "manual",
      bankTxId: p.bank_tx_id ?? null,
      paidAt: isoOrNull(p.paid_at),
      ledgerStatus: p.ledger_status ?? null,
      journalNumber: p.journal_number ?? null,
    })),
    credits: applications.map((a) => ({ id: a.id, sourceKind: a.source_kind, sourceId: a.source_id, amountMinor: Number(a.amount_minor), createdAt: iso(a.created_at) })),
    creditNotes: notes.map((n) => publicCreditNote(n, invoice.number)),
    pops: pops.map((pop) => publicPop(pop)),
    deliveries: deliveries.map((d) => ({ key: d.key, status: d.status, error: d.error, subject: d.subject, recipients: d.recipients, sentAt: iso(d.sent_at), createdAt: iso(d.created_at) })),
    reminders: reminders.map((r) => ({ stage: Number(r.stage) + 1, status: r.status, createdAt: iso(r.created_at), error: r.error })),
    recipients,
    customerCredit: await customerCredit(ctx, invoice.company_id, invoice.customer_kind, invoice.customer_ref),
    ledgerKey: `billing:invoice:${invoice.id}:issue`,
  };
}

async function quoteDetail(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const quote = await requireQuote(ctx, companyId, requiredString(params, "quoteId"));
  const { settings } = await loadBilling(ctx, companyId);
  const view = await quoteView(ctx, quote, settings);
  const lines = await ctx.db.query<{ id: string; description: string; quantity: number; unit_amount_minor: string | number; tax_code: string | null }>(
    `SELECT id, description, quantity, unit_amount_minor, tax_code FROM ${table(ctx, "quote_lines")} WHERE quote_id = $1 ORDER BY created_at, id`,
    [quote.id],
  );
  return {
    quote: publicQuote(quote),
    lines: lines.map((line, i) => ({ id: line.id, description: line.description, quantity: Number(line.quantity), unitAmountMinor: Number(line.unit_amount_minor), taxCode: line.tax_code, netMinor: view.lines[i]?.netMinor ?? 0, vatMinor: view.lines[i]?.vatMinor ?? 0, grossMinor: view.lines[i]?.grossMinor ?? 0 })),
    groups: view.groups,
    legacyVat: view.legacy,
    deliveries: (await deliveriesFor(ctx, companyId, "quote", quote.id)).map((d) => ({ key: d.key, status: d.status, error: d.error, subject: d.subject, sentAt: iso(d.sent_at), createdAt: iso(d.created_at) })),
    recipients: await recipientsFor(ctx, companyId, quote),
  };
}

// ── Approvals ──────────────────────────────────────────────────────────────

async function requestDecision(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>, action: "send" | "pay") {
  if (context.actor.type === "agent") assertAgentMaySend();
  const companyId = requiredCompany(context);
  const invoice = await requireOwnInvoice(ctx, companyId, requiredString(params, "invoiceId"));
  if (action === "send" && invoice.status !== "draft") throw new BillingError("Only a draft invoice can be sent");
  if (action === "send" && invoice.delivery_status === "queued") throw new BillingError("This invoice is already being sent");
  if (action === "send" && Number(invoice.total_minor) <= 0) throw new BillingError("Add a line before sending the invoice");
  const balance = await invoiceBalance(ctx, invoice.id);
  if (action === "pay" && (!balance || balance.outstandingMinor <= 0 || invoice.status === "draft")) {
    throw new BillingError("This invoice cannot be marked paid");
  }
  const { settings } = await loadBilling(ctx, companyId);
  if (action === "send" && "sendTo" in params) {
    await ctx.db.execute(`UPDATE ${table(ctx, "invoices")} SET send_to = $2::jsonb WHERE id = $1`, [invoice.id, JSON.stringify(parseAddresses(params.sendTo))]);
    invoice.send_to = parseAddresses(params.sendTo);
  }
  const recipients = action === "send" && emailEnabled(settings) ? await recipientsFor(ctx, companyId, invoice) : [];
  const amount = balance ? balance.outstandingMinor : Number(invoice.total_minor);
  const money = new Intl.NumberFormat("en-ZA", { style: "currency", currency: invoice.currency }).format(amount / 100);
  const issue = await createWorkIssue(ctx, {
    companyId: invoice.company_id,
    title: action === "send" ? `Approve sending invoice ${invoice.number}` : `Approve payment of invoice ${invoice.number}`,
    description: action === "send"
      ? recipients.length
        ? `Open invoice ${invoice.number} on the Billing page and check it. Mark this issue done to email it (with the PDF) to ${recipients.map((r) => r.email).join(", ")} from the Mailbox. The plugin records it as sent when the email goes out, and freezes the sender and customer details.`
        : `Open invoice ${invoice.number} on the Billing page and check it. There is no email address for this customer${emailEnabled(settings) ? "" : " (email is off in settings)"}, so mark this issue done after you have sent it yourself. The plugin then records it as sent and freezes the sender and customer details.`
      : `Confirm the payment of ${money} for invoice ${invoice.number} has cleared (EFT proof and the bank statement), then mark this issue done. The plugin then records the payment and the invoice is paid.`,
    originKind: `plugin:${PIB_PLUGINS.billing}`,
    originId: invoice.id,
    ...(settings.reviewerUserId ? { assigneeUserId: settings.reviewerUserId } : {}),
  });
  invoice.approval_issue_id = issue.id;
  invoice.pending_action = action;
  await saveTotalsAndStatus(ctx, invoice);
  return { invoiceId: invoice.id, issueId: issue.id, pendingAction: action, recipients };
}

async function requestQuoteSend(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  if (context.actor.type === "agent") assertAgentMaySend();
  const companyId = requiredCompany(context);
  const quote = await requireQuote(ctx, companyId, requiredString(params, "quoteId"));
  if (quote.status !== "draft" && quote.status !== "sent") throw new BillingError("Only a draft or sent quote can be emailed");
  if (Number(quote.total_minor) <= 0) throw new BillingError("Add a line before sending the quote");
  const { settings } = await loadBilling(ctx, companyId);
  const recipients = emailEnabled(settings) ? await recipientsFor(ctx, companyId, quote) : [];
  const issue = await createWorkIssue(ctx, {
    companyId,
    title: `Approve sending quote ${quote.number}`,
    description: recipients.length
      ? `Check quote ${quote.number} on the Billing page, then mark this issue done to email it (with the PDF) to ${recipients.map((r) => r.email).join(", ")}.`
      : `Check quote ${quote.number} on the Billing page. There is no email address for this customer, so mark this issue done after you have sent it yourself.`,
    originKind: `plugin:${PIB_PLUGINS.billing}`,
    originId: quote.id,
    ...(settings.reviewerUserId ? { assigneeUserId: settings.reviewerUserId } : {}),
  });
  await ctx.db.execute(`UPDATE ${table(ctx, "quotes")} SET approval_issue_id = $2, pending_action = 'send', updated_at = now() WHERE id = $1`, [quote.id, issue.id]);
  return { quoteId: quote.id, issueId: issue.id, recipients };
}

// ── Payments ───────────────────────────────────────────────────────────────

/** `record-payment` now goes through settle(): partial, top-up and overpayment are handled; idempotent by paymentKey. */
async function recordPayment(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const invoice = await requireOwnInvoice(ctx, companyId, requiredString(params, "invoiceId"));
  const key = optionalString(params, "paymentKey");
  const result = await settle(ctx, {
    companyId,
    invoiceId: invoice.id,
    amountMinor: integer(params.amountMinor, "amountMinor"),
    sourceKey: `manual:${key ?? randomUUID()}`,
    source: "manual",
    method: optionalString(params, "method") ?? "bank",
    reference: optionalString(params, "reference") ?? null,
    paidAt: optionalString(params, "paidAt") ?? null,
    createdBy: actorLabel(context),
  }, await billingSettings(ctx, companyId));
  for (const popId of result.confirmedPopIds) await closePopIssue(ctx, companyId, popId);
  return {
    id: result.paymentId,
    invoiceId: invoice.id,
    amountMinor: result.amountMinor,
    allocatedMinor: result.allocatedMinor,
    creditMinor: result.creditMinor,
    outstandingMinor: result.outstandingMinor,
    invoiceStatus: result.status,
    method: optionalString(params, "method")?.toLowerCase() ?? "bank",
    reference: optionalString(params, "reference") ?? null,
    paidAt: optionalString(params, "paidAt") ?? new Date().toISOString(),
    repeat: result.repeat,
  };
}

async function invoicePayments(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const invoice = await requireInvoice(ctx, companyId, requiredString(params, "invoiceId"));
  const rows = await paymentsForInvoice(ctx, invoice.id);
  return rows.map((row) => ({
    id: row.id,
    amountMinor: Number(row.amount_minor),
    allocatedMinor: Number(row.allocated_minor ?? row.amount_minor),
    method: row.method,
    reference: row.reference,
    source: row.source ?? "manual",
    paidAt: row.paid_at == null ? null : String(row.paid_at instanceof Date ? row.paid_at.toISOString() : row.paid_at),
  }));
}

async function registerPop(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const invoice = await requireOwnInvoice(ctx, companyId, requiredString(params, "invoiceId"));
  const key = requiredString(params, "key");
  const { settings, resolver } = await loadBilling(ctx, companyId);
  const r2 = await privateR2(resolver, settings);
  if (!r2) throw new BillingError("The private R2 bucket is not configured");
  assertOwnKey(r2, companyId, key, "pop");
  const recorded = await recordPop(ctx, {
    companyId,
    invoiceId: invoice.id,
    source: "upload",
    basis: "upload",
    amountMinor: optionalInteger(params, "amountMinor") ?? null,
    reference: optionalString(params, "reference") ?? null,
    fileKey: key,
    fileName: optionalString(params, "fileName") ?? null,
    fileMime: optionalString(params, "mime") ?? null,
    subject: `Uploaded proof of payment for ${invoice.number}`,
    createdBy: actorLabel(context),
  }, settings);
  return recorded;
}

async function closePopIssue(ctx: PluginContext, companyId: string, popId: string, status: "done" | "cancelled" = "done") {
  const pop = await getPop(ctx, popId);
  if (!pop?.issue_id) return;
  await ctx.db.execute(`UPDATE ${table(ctx, "decision_issues")} SET status = 'resolved', resolved_at = now() WHERE issue_id = $1 AND status = 'open'`, [pop.issue_id]);
  try {
    await ctx.issues.update(pop.issue_id, { status }, companyId);
  } catch (error) {
    ctx.logger.info("Could not close the POP issue", { popId, error: errorMessage(error) });
  }
}

// ── Printable HTML (0.2 tools) ─────────────────────────────────────────────

async function invoiceHtml(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const invoice = await requireInvoice(ctx, companyId, requiredString(params, "invoiceId"));
  const { settings } = await loadBilling(ctx, companyId);
  const view = await invoiceView(ctx, invoice, settings);
  return {
    invoiceId: invoice.id,
    html: buildInvoiceHtml({
      kind: "Invoice",
      number: invoice.number,
      status: invoice.status,
      currency: invoice.currency,
      sender: view.sender,
      customer: view.customer,
      lines: view.lines.map((line) => ({ description: line.description, quantity: line.quantity, unitAmountMinor: line.unitAmountMinor })),
      taxRate: view.legacy ? Number(invoice.tax_rate ?? 0) : 0,
      totals: view.legacy ? undefined : { subtotalMinor: view.subtotalMinor, vatMinor: view.vatMinor, totalMinor: view.totalMinor },
      payment: view.payment ?? null,
      notes: view.notes ?? null,
      issuedAt: invoice.sent_at == null ? null : String(iso(invoice.sent_at)),
      dueAt: iso(invoice.due_at),
    }),
  };
}

async function quoteHtml(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const quote = await requireQuote(ctx, companyId, requiredString(params, "quoteId"));
  const { settings } = await loadBilling(ctx, companyId);
  const view = await quoteView(ctx, quote, settings);
  return {
    quoteId: quote.id,
    html: buildInvoiceHtml({
      kind: "Quote",
      number: quote.number,
      status: quote.status,
      currency: quote.currency,
      sender: view.sender,
      customer: view.customer,
      lines: view.lines.map((line) => ({ description: line.description, quantity: line.quantity, unitAmountMinor: line.unitAmountMinor })),
      taxRate: view.legacy ? Number(quote.tax_rate ?? 0) : 0,
      totals: view.legacy ? undefined : { subtotalMinor: view.subtotalMinor, vatMinor: view.vatMinor, totalMinor: view.totalMinor },
      dueAt: iso(quote.valid_until),
    }),
  };
}

// ── Recurring ──────────────────────────────────────────────────────────────

async function createRecurringAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const template = await requireOwnInvoice(ctx, companyId, requiredString(params, "templateInvoiceId"));
  const frequency = assertFrequency(requiredString(params, "frequency"));
  const nextRunAt = requiredString(params, "nextRunAt");
  if (Number.isNaN(Date.parse(nextRunAt))) throw new BillingError("nextRunAt must be a time");
  const autoSend = optionalBoolean(params, "autoSend") ?? false;
  if (autoSend) requirePerson(context, "turning on automatic sending");
  const row = {
    id: randomUUID(),
    company_id: companyId,
    template_invoice_id: template.id,
    frequency,
    next_run_at: new Date(nextRunAt).toISOString(),
    is_active: true,
    auto_send: autoSend,
    ends_at: optionalDate(params, "endsAt") ?? null,
  };
  await insertRecurring(ctx, row);
  return publicRecurring(row);
}

async function listRecurringAction(ctx: PluginContext, context: PluginPerformActionContext) {
  const companyId = requiredCompany(context);
  return (await listRecurring(ctx, companyId)).map(publicRecurring);
}

async function setRecurringActive(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>, active: boolean) {
  const companyId = requiredCompany(context);
  const row = await getRecurring(ctx, requiredString(params, "recurringId"));
  if (!row || row.company_id !== companyId) throw new BillingError("Recurring schedule was not found");
  row.is_active = active;
  await saveRecurring(ctx, row);
  return publicRecurring(row);
}

async function updateRecurring(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const row = await getRecurring(ctx, requiredString(params, "recurringId"));
  if (!row || row.company_id !== companyId) throw new BillingError("Recurring schedule was not found");
  const autoSend = optionalBoolean(params, "autoSend");
  if (autoSend) requirePerson(context, "turning on automatic sending");
  await ctx.db.execute(
    `UPDATE ${table(ctx, "recurring_invoices")} SET auto_send = $2, ends_at = $3, frequency = $4, updated_at = now() WHERE id = $1`,
    [row.id, autoSend ?? Boolean(row.auto_send), "endsAt" in params ? optionalDate(params, "endsAt") ?? null : row.ends_at ?? null, params.frequency ? assertFrequency(String(params.frequency)) : row.frequency],
  );
  return publicRecurring((await getRecurring(ctx, row.id))!);
}

function publicRecurring(row: { id: string; company_id: string; template_invoice_id: string; frequency: string; next_run_at: unknown; is_active: boolean; auto_send?: boolean | null; ends_at?: unknown; last_invoice_id?: string | null }) {
  return {
    id: row.id,
    templateInvoiceId: row.template_invoice_id,
    frequency: row.frequency,
    nextRunAt: iso(row.next_run_at),
    isActive: row.is_active,
    autoSend: Boolean(row.auto_send),
    endsAt: iso(row.ends_at),
    lastInvoiceId: row.last_invoice_id ?? null,
  };
}

/** Job: a new invoice from each due schedule (every field copied), then retainer subscriptions. */
async function runRecurring(ctx: PluginContext) {
  const due = await dueRecurring(ctx);
  const on = moduleCache(ctx);
  for (const schedule of due) {
    try {
      // Billing switched off for the company: leave the schedule as it is.
      if (!(await on(schedule.company_id))) continue;
      const template = await getInvoice(ctx, schedule.template_invoice_id);
      const scheduled = new Date(String(iso(schedule.next_run_at)));
      if (!template) {
        schedule.is_active = false;
        await saveRecurring(ctx, schedule);
        continue;
      }
      const endsAt = iso(schedule.ends_at);
      if (endsAt && Date.parse(endsAt) < scheduled.getTime()) {
        schedule.is_active = false;
        await saveRecurring(ctx, schedule);
        continue;
      }
      const key = `recurring:${schedule.id}:${scheduled.toISOString().slice(0, 10)}`;
      const existing = await ctx.db.query<{ id: string }>(`SELECT id FROM ${table(ctx, "invoices")} WHERE recurring_key = $1`, [key]);
      let createdId: string | null = null;
      if (!existing[0]) {
        const settings = await billingSettings(ctx, schedule.company_id);
        const customer = asObject(template.customer);
        const invoice: InvoiceRow = copyInvoiceFields(template, {
          id: randomUUID(),
          number: await nextDocumentNumber(ctx, schedule.company_id, "invoice", { kind: template.customer_kind, ref: template.customer_ref, name: String(customer.name ?? template.customer_ref) }, settings),
          recurring_id: schedule.id,
          recurring_key: key,
        });
        if ((await insertInvoice(ctx, invoice)) > 0) {
          await copyLines(ctx, template.id, invoice.id, schedule.company_id);
          await recomputeInvoice(ctx, invoice);
          createdId = invoice.id;
        }
      }
      schedule.next_run_at = advanceSchedule(scheduled, schedule.frequency as "monthly" | "quarterly" | "yearly").toISOString();
      schedule.last_invoice_id = createdId ?? schedule.last_invoice_id ?? null;
      await saveRecurring(ctx, schedule);
      if (createdId && schedule.auto_send && (await configSaved(ctx, schedule.company_id))) {
        await startInvoiceSend(ctx, createdId, "recurring schedule");
      }
    } catch (error) {
      ctx.logger.error("Recurring invoice failed", { scheduleId: schedule.id, error: errorMessage(error) });
    }
  }
  for (const companyId of await billingCompanyIds(ctx)) {
    try {
      if (!(await on(companyId))) continue;
      await runSubscriptions(ctx, companyId);
    } catch (error) {
      ctx.logger.info("Retainer run skipped", { companyId, error: errorMessage(error) });
    }
  }
}

async function listCreditNotesAction(ctx: PluginContext, context: PluginPerformActionContext) {
  const companyId = requiredCompany(context);
  const rows = await listCreditNotes(ctx, companyId);
  return rows.map((note) => ({ ...publicCreditNote(note), createdAt: note.created_at == null ? null : String(iso(note.created_at)) }));
}

// ── Reports ────────────────────────────────────────────────────────────────

async function reportsAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const to = optionalString(params, "to") ?? new Date().toISOString().slice(0, 10);
  const from = optionalString(params, "from") ?? `${new Date(Date.UTC(new Date(to).getUTCFullYear(), new Date(to).getUTCMonth() - 11, 1)).toISOString().slice(0, 7)}-01`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new BillingError("from and to must be dates (YYYY-MM-DD)");
  return buildReports(ctx, companyId, await billingSettings(ctx, companyId), { from, to });
}

// ── Dunning ────────────────────────────────────────────────────────────────

async function dunningStatus(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const settings = await billingSettings(ctx, companyId);
  const { stages, balances, plans } = await plannedReminders(ctx, companyId, settings);
  const byId = new Map(balances.map((b) => [b.invoice.id, b]));
  const optouts = await ctx.db.query<{ customer_kind: string; customer_ref: string; reason: string | null }>(
    `SELECT customer_kind, customer_ref, reason FROM ${table(ctx, "dunning_optouts")} WHERE company_id = $1`,
    [companyId],
  );
  const recent = await ctx.db.query<{ invoice_id: string; stage: number; status: string; created_at: unknown; error: string | null }>(
    `SELECT r.invoice_id, r.stage, r.status, r.created_at, r.error FROM ${table(ctx, "reminders")} r WHERE r.company_id = $1 ORDER BY r.created_at DESC LIMIT 100`,
    [companyId],
  );
  const numbers = new Map((await invoiceBalances(ctx, companyId)).map((b) => [b.invoice.id, b.invoice.number]));
  void params;
  return {
    enabled: settings.dunning?.enabled === true,
    stages,
    next: plans.map((plan) => ({ invoiceId: plan.invoiceId, number: byId.get(plan.invoiceId)?.invoice.number ?? "", stage: plan.stage + 1, daysOverdue: plan.daysOverdue })),
    optOuts: optouts.map((o) => ({ kind: o.customer_kind, id: o.customer_ref, reason: o.reason })),
    recent: recent.map((r) => ({ invoiceId: r.invoice_id, number: numbers.get(r.invoice_id) ?? "", stage: Number(r.stage) + 1, status: r.status, createdAt: iso(r.created_at), error: r.error })),
  };
}

async function setDunningOptOut(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const scope = readClientScope(params);
  if (!scope) throw new BillingError("client is required");
  const optOut = optionalBoolean(params, "optOut") ?? true;
  if (optOut) {
    await ctx.db.execute(
      `INSERT INTO ${table(ctx, "dunning_optouts")} (company_id, customer_kind, customer_ref, reason, created_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (company_id, customer_kind, customer_ref) DO UPDATE SET reason = EXCLUDED.reason`,
      [companyId, scope.kind, scope.id, optionalString(params, "reason") ?? null, actorLabel(context)],
    );
  } else {
    await ctx.db.execute(`DELETE FROM ${table(ctx, "dunning_optouts")} WHERE company_id = $1 AND customer_kind = $2 AND customer_ref = $3`, [companyId, scope.kind, scope.id]);
  }
  return { client: scope, optOut };
}

/** Send today's reminders for one company. `force` runs even when the schedule is off (a person pressed "Send now"). */
async function runDunningFor(ctx: PluginContext, companyId: string, force = false) {
  const { settings, resolver } = await loadBilling(ctx, companyId);
  if (!force && settings.dunning?.enabled !== true) return { sent: 0, skipped: 0, reason: "Reminders are off" };
  if (!emailEnabled(settings)) return { sent: 0, skipped: 0, reason: "Email is off" };
  const { stages, balances, plans } = await plannedReminders(ctx, companyId, settings);
  const byId = new Map(balances.map((b) => [b.invoice.id, b]));
  const r2 = settings.dunning?.attachInvoice === false ? null : await privateR2(resolver, settings).catch(() => null);
  let sent = 0;
  let skipped = 0;
  for (const plan of plans) {
    const balance = byId.get(plan.invoiceId);
    const stage = stages[plan.stage];
    if (!balance || !stage) continue;
    const reminderId = await claimReminder(ctx, companyId, plan);
    if (!reminderId) continue;
    try {
      const to = await recipientsFor(ctx, companyId, balance.invoice);
      if (to.length === 0) {
        await setReminderStatus(ctx, reminderId, "skipped", { error: "No email address for this customer" });
        skipped += 1;
        continue;
      }
      const vars = reminderVars(balance, plan.daysOverdue, settings);
      const payment = asObject(asObject(balance.invoice.sender_snapshot).payment ?? settings.payment ?? {});
      const content = reminderEmail(stage, vars, Object.keys(payment).length ? payment : null, balance.invoice.number);
      let attachments: Array<{ url: string; filename: string; mime: string; bytes: number }> = [];
      if (r2) {
        const view = await invoiceView(ctx, balance.invoice, settings);
        const bytes = await renderDocument(view);
        const filename = docFileName(view);
        const key = documentKey(r2, companyId, "invoice", filename, "pdf");
        await putObject(r2, key, bytes, "application/pdf");
        attachments = [{ url: presignGet(r2, key, MAIL_LINK_SECONDS, filename), filename, mime: "application/pdf", bytes: bytes.byteLength }];
      }
      const deliveryKey = await queueMail(ctx, companyId, {
        kind: "reminder",
        docId: balance.invoice.id,
        seq: plan.stage + 1,
        to,
        cc: parseAddresses(settings.email?.cc ?? ""),
        from: settings.email?.from?.trim() || null,
        content,
        attachments,
        clientKind: balance.invoice.customer_kind,
        clientRef: balance.invoice.customer_ref,
        threadId: null,
        createdBy: "dunning",
      });
      await setReminderStatus(ctx, reminderId, "queued", { deliveryKey });
      sent += 1;
    } catch (error) {
      await setReminderStatus(ctx, reminderId, "failed", { error: errorMessage(error) });
    }
  }
  return { sent, skipped };
}

// ── Jobs ───────────────────────────────────────────────────────────────────

/** Companies scheduled jobs work for: settings saved and the Billing module not switched off. */
async function companiesWithSettings(ctx: PluginContext): Promise<string[]> {
  const out: string[] = [];
  for (const companyId of await billingCompanyIds(ctx).catch(() => [])) {
    if ((await configSaved(ctx, companyId)) && (await billingOn(ctx, companyId))) out.push(companyId);
  }
  return out;
}

/** Memoised module switch per job run. */
function moduleCache(ctx: PluginContext): (companyId: string) => Promise<boolean> {
  const seen = new Map<string, Promise<boolean>>();
  return (companyId) => {
    let hit = seen.get(companyId);
    if (!hit) {
      hit = billingOn(ctx, companyId);
      seen.set(companyId, hit);
    }
    return hit;
  };
}

/** Hourly: overdue invoices (not for companies with Billing off), then the setup status for the Setup plugin. */
async function markOverdueJob(ctx: PluginContext) {
  const off: string[] = [];
  for (const companyId of await knownCompanyIds(ctx).catch(() => [] as string[])) {
    if (!(await billingOn(ctx, companyId))) off.push(companyId);
  }
  await markOverdue(ctx, off);
  await publishAllSetupStatus(ctx);
}

async function redeliverJob(ctx: PluginContext) {
  await redeliver(ctx);
  const failed = await failStaleDeliveries(ctx);
  await markFailedDeliveries(ctx, failed);
}

async function emitOpenItemsJob(ctx: PluginContext, sinceSeconds: number | null) {
  for (const companyId of await companiesWithSettings(ctx)) {
    try {
      await emitOpenItems(ctx, companyId, sinceSeconds);
    } catch (error) {
      ctx.logger.info("Open item broadcast skipped", { companyId, error: errorMessage(error) });
    }
  }
}

async function dunningJob(ctx: PluginContext) {
  for (const companyId of await companiesWithSettings(ctx)) {
    try {
      await runDunningFor(ctx, companyId, false);
    } catch (error) {
      ctx.logger.info("Reminders skipped", { companyId, error: errorMessage(error) });
    }
  }
}

async function fxJob(ctx: PluginContext) {
  const bases = new Set<string>(["ZAR"]);
  for (const companyId of await companiesWithSettings(ctx)) bases.add(reportingCurrency(await billingSettings(ctx, companyId)));
  await refreshDailyRates(ctx, [...bases]);
}

// ── API routes ─────────────────────────────────────────────────────────────

async function setupStatusRoute(ctx: PluginContext, input: PluginApiRequestInput): Promise<PluginApiResponse> {
  if (!input.companyId) return { status: 400, body: { error: "companyId is required" } };
  try {
    return { status: 200, body: await setupStatus(ctx, input.companyId) };
  } catch (error) {
    ctx.logger.info("Billing setup status failed", { error: errorMessage(error) });
    return { status: 500, body: { error: error instanceof Error ? error.message : "Setup status failed" } };
  }
}

async function clientSummaryRoute(ctx: PluginContext, input: PluginApiRequestInput): Promise<PluginApiResponse> {
  try {
    const scope = parseClientParam(`${firstQuery(input.query.kind)}:${firstQuery(input.query.id)}`);
    if (!scope) return { status: 400, body: { error: "kind (company or contact) and a valid id are required" } };
    return { status: 200, body: await clientSummary(ctx, input.companyId, scope) };
  } catch (error) {
    ctx.logger.info("Billing client summary failed", { error: errorMessage(error) });
    return { status: 500, body: { error: error instanceof Error ? error.message : "Summary failed" } };
  }
}

async function clientSummary(ctx: PluginContext, companyId: string, scope: ClientRef): Promise<ClientSummary> {
  const [balances, quotes, settings] = await Promise.all([
    customerInvoiceBalances(ctx, companyId, scope),
    listQuotes(ctx, companyId, scope),
    billingSettings(ctx, companyId),
  ]);
  return clientBillingSummary({
    invoices: balances.map((row) => ({
      status: row.status,
      currency: row.currency,
      totalMinor: Number(row.total_minor),
      paidMinor: Number(row.paid_minor ?? 0),
      creditedMinor: Number(row.credited_minor ?? 0),
      dueAt: isoOrNull(row.due_at),
      lastPaidAt: isoOrNull(row.last_paid_at),
    })),
    quotes: quotes.map((quote) => ({ status: quote.status })),
    now: new Date(),
    defaultCurrency: settings.defaultCurrency,
  });
}

function firstQuery(value: string | string[] | undefined): string {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? first.trim() : "";
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

/** A partner grant was revoked: drop the invoice share written when it was accepted. */
async function onPartnerGrantRevoked(ctx: PluginContext, companyId: string, payload: unknown) {
  const body = asObject(payload);
  if (body.recordType !== "invoice") return;
  const invoiceId = String(body.recordId ?? "");
  const granteeCompanyId = String(body.granteeCompanyId ?? "");
  if (!companyId || !invoiceId || !granteeCompanyId) return;
  try {
    await ctx.db.execute(
      `DELETE FROM ${table(ctx, "invoice_grants")} WHERE company_id = $1 AND invoice_id = $2 AND grantee_company_id = $3`,
      [companyId, invoiceId, granteeCompanyId],
    );
  } catch (error) {
    ctx.logger.error("Billing partner share removal failed", { invoiceId, error: errorMessage(error) });
  }
}

