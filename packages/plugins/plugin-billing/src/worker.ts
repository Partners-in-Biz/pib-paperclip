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
  COCKPIT_ROUTE,
  configSaved,
  correctDecision,
  createSkillSyncer,
  listCrmClients,
  parseClientParam,
  redeliver,
  registerCrmProjection,
  checkDoneOnUpdate,
  registerCompanyBootstrap,
  registerModuleWatch,
  registerRoleWatch,
  registerSkillSyncJob,
  rememberPluginUiBase,
  resolveCrmClient,
  retryOutbox,
  SETUP_EVENTS,
  SETUP_PLUGIN,
  SETUP_STATUS_ROUTE,
  TAX_CODES,
  toolFail,
  toolOk,
  trackJob,
  type ClientRef,
  type ModulesPayload,
} from "@partnersinbiz/pib-plugin-kit";
import { CRM_DEAL_ACCEPTED_EVENT, CRM_QUOTE_ACCEPTED_EVENT, onSignedDocument } from "./accepted.js";
import { backpostTotal, postMissingJournals } from "./backpost.js";
import { cancelPaymentLinkAction, createPaymentLinkAction, paymentLinksAction, paymentsStatusAction, publicLink, recordRefundAction, simulatePaymentAction } from "./pay/actions.js";
import { housekeepPaymentLinks } from "./pay/links.js";
import { providerStates, webhookUrl } from "./pay/settings.js";
import { linksForInvoice, refundsForInvoice } from "./pay/store.js";
import { handleBillingWebhook } from "./pay/webhook.js";
import { finishErasureHolds, registerBillingErasure } from "./privacy.js";
import { shapeToolResult } from "./tool-results.js";
import { cockpitSnapshot, publishAllCockpit } from "./cockpit.js";
import { asAtDate, customerCredit, invoiceBalance, invoiceBalances, iso, refreshAsAtStatuses, statusAsAtToday, type InvoiceBalance } from "./balances.js";
import { BANK_MATCHED_EVENT } from "./bank.js";
import {
  billingSettings,
  emailEnabled,
  expenseCategories,
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
  customerLastPaidAt,
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
  table,
  type InvoiceRow,
} from "./db.js";
import { clientBillingSummary, assertFrequency, assertTaxRate, BillingError, buildInvoiceHtml, canSeeInvoice, mergeCustomer, QUOTE_STATUSES, type ClientSummary } from "./domain.js";
import { BILLING_DONE_CHECKS } from "./donechecks.js";
import { plannedReminders, runDunningFor } from "./dunning.js";
import { DEAL_WON_EVENT, onDealWon, syncDraftsDigest, syncOverdueDigest } from "./followups.js";
import { refreshDailyRates } from "./fx.js";
import { reemitHandoffs } from "./handoff.js";
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
  customerDetails,
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
import { deliveriesFor, failStaleDeliveries } from "./mail.js";
import { followUpsFor, logFollowUp } from "./notes.js";
import { clientNumbering, nextDocumentNumber, setClientNumbering } from "./numbering.js";
import { emitOpenItems } from "./openitems.js";
import { closePopIssues, confirmPop, getPop, listPops, recordPop, rejectPop } from "./pop.js";
import { LEDGER_RESULT_EVENT } from "./posting.js";
import { buildReports } from "./reporting.js";
import {
  openDecisionList,
  requestCreditDecision,
  requestInvoiceSend,
  requestPayApproval,
  requestPaymentCheck,
  requestPaymentDecision,
  requestQuoteSend,
  requestReminderSend,
  retitleSendApprovals,
} from "./requests.js";
import { createPlan, createSubscription, listRetainers, runSubscriptions, setSubscriptionStatus, updatePlan } from "./retainers.js";
import { teamStatus } from "./routing.js";
import { applyCustomerCredit, settle, writeOff } from "./settle.js";
import { billingOn, knownCompanyIds, publishAllSetupStatus, setupStatus } from "./setup.js";
import { PLUGIN_ID } from "./namespace.js";
import { SKILLS } from "./skills.js";
import { assertOwnKey } from "./storage.js";
import { billTime, deleteTimeEntry, listTime, logTime, startTimer, stopTimer } from "./time.js";
import { BILLING_TOOLS } from "./tools.js";
import { openWorkIssues, refreshWorkIssueOrigins } from "./workissues.js";
import {
  actorLabel,
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
  "billing.request-send": requestInvoiceSend,
  "billing.request-pay": requestPayApproval,
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
  "billing.request-quote-send": requestQuoteSend,
  "billing.list-quotes": (ctx, context, params) => listQuotesAction(ctx, context, params),
  "billing.request-payment-check": requestPaymentCheck,
  "billing.request-reminder-send": (ctx, context, params) => requestReminderSend(ctx, context, params),
  // Money in through a provider (Q10-6): links are made at send time; these are for a person or agent who needs one, and for the page.
  "billing.create-payment-link": createPaymentLinkAction,
  "billing.payment-links": paymentLinksAction,
  "billing.cancel-payment-link": cancelPaymentLinkAction,
  "billing.record-refund": recordRefundAction,
  "billing.simulate-payment": simulatePaymentAction,
  "billing.payments": (ctx, context) => paymentsStatusAction(ctx, context),
  "billing.log-follow-up": logFollowUp,
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
  // Money guard: an agent never records money; it asks a person on a decision issue. People act directly.
  "billing.record-payment": (ctx, context, params) => (context.actor.type === "agent" ? requestPaymentDecision(ctx, context, params) : recordPayment(ctx, context, params)),
  "billing.invoice-payments": (ctx, context, params) => invoicePayments(ctx, context, params),
  "billing.set-invoice-tax": (ctx, context, params) => setInvoiceTax(ctx, context, params, assertTaxRate(params.taxRate)),
  "billing.create-credit-note": (ctx, context, params) => (context.actor.type === "agent" ? requestCreditDecision(ctx, context, params) : createCreditNoteAction(ctx, context, params)),
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
    await closePopIssues(ctx, companyId, [requiredString(params, "popId")]);
    return result;
  },
  "billing.reject-pop": async (ctx, context, params) => {
    const reviewedBy = requirePerson(context, "rejecting a proof of payment");
    const companyId = requiredCompany(context);
    const result = await rejectPop(ctx, { companyId, popId: requiredString(params, "popId"), reason: optionalString(params, "reason") ?? null, reviewedBy });
    await closePopIssues(ctx, companyId, [requiredString(params, "popId")], "cancelled");
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
  "billing.get-numbering": async (ctx, context, params) => {
    const companyId = requiredCompany(context);
    const scope = readClientScope(params);
    if (!scope) throw new BillingError("client is required");
    return clientNumbering(ctx, companyId, { kind: scope.kind, ref: scope.id }, await billingSettings(ctx, companyId));
  },
  "billing.set-numbering": async (ctx, context, params) => {
    const companyId = requiredCompany(context);
    const scope = readClientScope(params);
    if (!scope) throw new BillingError("client is required");
    const nextNumber = optionalInteger(params, "nextNumber");
    return setClientNumbering(ctx, companyId, { kind: scope.kind, ref: scope.id }, { prefix: optionalString(params, "prefix"), nextNumber }, await billingSettings(ctx, companyId));
  },
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
    registerCrmProjection(ctx, ctx.db.namespace, { companies: true, contacts: true, companyBilling: true });
    registerModuleWatch(ctx);
    registerRoleWatch(ctx);
    for (const tool of BILLING_TOOLS) {
      ctx.tools.register(tool.name, tool, async (params, run) => {
        await skillSync?.ensure(run.companyId).catch(() => undefined);
        return runTool(ctx, tool.name, params, run);
      });
    }
    for (const [key, handler] of Object.entries(ACTIONS)) {
      ctx.actions.register(key, async (params, context) => {
        if (context.companyId && key === "billing.load") await skillSync?.ensure(context.companyId).catch(() => undefined);
        return handler(ctx, context, params ?? {});
      });
    }
    ctx.actions.register("billing.sync-skills", async (_params, context) => ({ results: await skillSync?.force(requiredCompany(context)) }));

    ctx.jobs.register("mark-overdue", () => trackJob(ctx, "mark-overdue", () => markOverdueJob(ctx)));
    ctx.jobs.register("run-recurring", () => trackJob(ctx, "run-recurring", () => runRecurring(ctx)));
    ctx.jobs.register("redeliver", () => trackJob(ctx, "redeliver", () => redeliverJob(ctx)));
    ctx.jobs.register("emit-open-items", () => trackJob(ctx, "emit-open-items", () => emitOpenItemsJob(ctx, 1800)));
    ctx.jobs.register("emit-open-items-all", () => trackJob(ctx, "emit-open-items-all", () => emitOpenItemsJob(ctx, null)));
    ctx.jobs.register("dunning", () => trackJob(ctx, "dunning", () => dunningJob(ctx)));
    ctx.jobs.register("fx-rates", () => trackJob(ctx, "fx-rates", () => fxJob(ctx)));
    ctx.jobs.register("drafts-to-send", () => trackJob(ctx, "drafts-to-send", () => draftsJob(ctx)));
    ctx.jobs.register("overdue-invoices", () => trackJob(ctx, "overdue-invoices", () => overdueJob(ctx)));
    ctx.jobs.register("post-missing-journals", () => trackJob(ctx, "post-missing-journals", () => backpostJob(ctx)));

    const guard = (label: string, fn: (event: PluginEvent) => Promise<void>) => async (event: PluginEvent) => {
      try {
        await fn(event);
      } catch (error) {
        ctx.logger.error(`Billing ${label} failed`, { error: errorMessage(error) });
        throw error;
      }
    };
    // One subscription (a second would run both twice). The issue's own handlers (approvals, decisions) run before its done check.
    ctx.events.on("issue.updated", guard("issue update", async (event) => {
      await onIssueUpdated(ctx, event.entityId, event.companyId, event.actorType, event.actorId);
      await checkDoneOnUpdate(ctx, BILLING_DONE_CHECKS, event);
    }));
    ctx.events.on("plugin.partnersinbiz.partners.grant.revoked", (event) => onPartnerGrantRevoked(ctx, event.companyId, event.payload));
    ctx.events.on(MAIL_RESULT_EVENT, guard("mail result", (event) => onMailResult(ctx, event)));
    ctx.events.on(MAIL_RECEIVED_EVENT, guard("inbound mail", (event) => onMailReceived(ctx, event)));
    ctx.events.on(LEDGER_RESULT_EVENT, guard("ledger result", (event) => onLedgerPostResult(ctx, event)));
    ctx.events.on(BANK_MATCHED_EVENT, guard("bank match", (event) => onBankMatchedEvent(ctx, event)));
    ctx.events.on(DEAL_WON_EVENT, guard("deal won", (event) => onDealWon(ctx, event)));
    // A client signed (CRM e-sign): draft the invoice, once per signed document, never send it.
    ctx.events.on(CRM_DEAL_ACCEPTED_EVENT, guard("deal accepted", (event) => onSignedDocument(ctx, event, "deal")));
    ctx.events.on(CRM_QUOTE_ACCEPTED_EVENT, guard("quote accepted", (event) => onSignedDocument(ctx, event, "quote")));
    // After registerModuleWatch (handlers run in order): Accounting switched on → post the journals it missed.
    ctx.events.on(`plugin.${SETUP_PLUGIN}.${SETUP_EVENTS.modulesUpdated}`, guard("module switch", (event) => onModulesUpdated(ctx, event)));
    // One company.created handler (kit): remembers the company, syncs the skills, and catches up a company that missed the event.
    registerCompanyBootstrap(ctx, { syncer: skillSync });
    registerBillingErasure(ctx);
    // Every company's skills, not only the one a call comes from (Q7-2).
    registerSkillSyncJob(ctx, skillSync, { companyIds: () => billingCompanyIds(ctx), isEnabled: (companyId) => billingOn(ctx, companyId), plugin: PLUGIN_ID });
    ctx.jobs.register("privacy-retention", () => trackJob(ctx, "privacy-retention", () => privacyRetentionJob(ctx)));
  },
  async onWebhook(input) {
    if (!pluginCtx) throw new Error("Billing is not ready yet. The provider will send this again.");
    await handleBillingWebhook(pluginCtx, input);
  },
  async onHealth() {
    return { status: "ok", message: "Billing plugin ready" };
  },
  async onApiRequest(input) {
    if (!pluginCtx) return { status: 503, body: { error: "Billing plugin is not ready" } };
    if (input.routeKey === "client-summary") return clientSummaryRoute(pluginCtx, input);
    if (input.routeKey === SETUP_STATUS_ROUTE.routeKey) return setupStatusRoute(pluginCtx, input);
    if (input.routeKey === COCKPIT_ROUTE.routeKey) return cockpitRoute(pluginCtx, input);
    return acceptGrant(pluginCtx, input);
  },
});

export default plugin;
runWorker(plugin, import.meta.url);

// ── Tools ──────────────────────────────────────────────────────────────────

type ToolMessage = string | ((data: Record<string, unknown>) => string);

/** Tool name → action handler and the one-line result for the agent. */
const TOOL_ACTIONS: Record<string, { action: string; message: ToolMessage }> = {
  "create-invoice": { action: "billing.create-invoice", message: "Draft invoice created. Add lines, then request-invoice-send." },
  "add-line": { action: "billing.add-line", message: "Invoice line added" },
  "update-line": { action: "billing.update-line", message: "Invoice line changed" },
  "remove-line": { action: "billing.remove-line", message: "Invoice line removed" },
  "update-invoice": { action: "billing.update-invoice", message: "Invoice changed" },
  "invoice-detail": { action: "billing.invoice-detail", message: "Invoice loaded" },
  "list-open-invoices": { action: "billing.open-invoices", message: "Open invoices listed" },
  "request-invoice-send": { action: "billing.request-send", message: (d) => (d.already ? "A send approval is already open for this invoice" : "Send approval issue opened for a person") },
  "invoice-html": { action: "billing.invoice-html", message: "Invoice HTML generated" },
  "set-invoice-tax": { action: "billing.set-invoice-tax", message: "Invoice tax set" },
  "invoice-payments": { action: "billing.invoice-payments", message: "Payments listed" },
  "create-quote": { action: "billing.create-quote", message: "Draft quote created. Add lines, then request-quote-send." },
  "add-quote-line": { action: "billing.add-quote-line", message: "Quote line added" },
  "remove-quote-line": { action: "billing.remove-quote-line", message: "Quote line removed" },
  "update-quote": { action: "billing.update-quote", message: "Quote changed" },
  "quote-detail": { action: "billing.quote-detail", message: "Quote loaded" },
  "list-quotes": { action: "billing.list-quotes", message: "Quotes listed" },
  "request-quote-send": { action: "billing.request-quote-send", message: (d) => (d.already ? "A send approval is already open for this quote" : "Send approval issue opened for a person") },
  "set-quote-status": { action: "billing.set-quote-status", message: (d) => (d.status === "accepted" ? "Quote accepted (the CRM is told). Next: convert-quote." : "Quote status changed") },
  "convert-quote": { action: "billing.convert-quote", message: "Quote converted to a draft invoice. Check it, then request-invoice-send." },
  "quote-html": { action: "billing.quote-html", message: "Quote HTML generated" },
  "request-payment-check": { action: "billing.request-payment-check", message: (d) => (d.already ? "A payment check is already open for this invoice; your note was added" : "Payment check opened for a person") },
  "record-payment": { action: "billing.record-payment", message: (d) => (d.recorded ? "This payment is already recorded" : d.already ? "A person is already asked to record this payment" : "Asked a person to record the payment (decision issue)") },
  "create-credit-note": { action: "billing.create-credit-note", message: (d) => (d.already ? "A person is already asked for this credit note" : "Asked a person to issue the credit note (decision issue)") },
  "list-credit-notes": { action: "billing.list-credit-notes", message: "Credit notes listed" },
  "customer-credit": { action: "billing.customer-credit", message: "Customer credit listed" },
  "list-proofs-of-payment": { action: "billing.pops", message: "Proofs of payment listed" },
  "request-reminder-send": { action: "billing.request-reminder-send", message: (d) => (d.already ? "A reminder approval is already open for this invoice" : "Reminder approval issue opened for a person") },
  "create-payment-link": { action: "billing.create-payment-link", message: "Payment link ready (nothing was sent)" },
  "list-payment-links": { action: "billing.payment-links", message: "Payment links listed" },
  "log-follow-up": { action: "billing.log-follow-up", message: (d) => `Follow-up logged on ${String(d.on ?? "it")}` },
  "create-recurring-invoice": { action: "billing.create-recurring", message: "Recurring invoice scheduled" },
  "list-recurring-invoices": { action: "billing.list-recurring", message: "Recurring invoices listed" },
  "pause-recurring-invoice": { action: "billing.pause-recurring", message: "Recurring invoice paused" },
  "resume-recurring-invoice": { action: "billing.resume-recurring", message: "Recurring invoice resumed" },
  "create-retainer-plan": { action: "billing.create-plan", message: "Retainer plan created" },
  "create-subscription": { action: "billing.create-subscription", message: "Retainer subscription created" },
  "list-retainers": { action: "billing.retainers", message: "Retainers listed" },
  "create-expense": { action: "billing.create-expense", message: "Expense recorded" },
  "create-bill": { action: "billing.create-bill", message: "Draft bill created" },
  "add-bill-line": { action: "billing.add-bill-line", message: "Bill line added" },
  "request-bill-approval": { action: "billing.request-bill-approval", message: "Bill approval issue opened" },
  "list-bills": { action: "billing.list-bills", message: "Bills listed" },
  "start-timer": { action: "billing.start-timer", message: "Timer started" },
  "stop-timer": { action: "billing.stop-timer", message: "Timer stopped" },
  "log-time": { action: "billing.log-time", message: "Time logged" },
  "list-time-entries": { action: "billing.list-time", message: "Time entries listed" },
  "bill-time": { action: "billing.bill-time", message: "Time added to the invoice" },
  "billing-report": { action: "billing.reports", message: "Billing reports built" },
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
    const result = toolOk("", shapeToolResult(name, await handler(ctx, toolContext(run), body), body));
    return { ...result, content: typeof entry.message === "function" ? entry.message(result.data) : entry.message };
  } catch (error) {
    return toolFail(error instanceof Error ? error.message : "Billing tool failed");
  }
}

// ── Page snapshot ──────────────────────────────────────────────────────────

/** An invoice with its balance as at today (a payment dated after today is left out, shown apart and flagged). */
export function balanceOut(balance: InvoiceBalance) {
  return {
    ...publicInvoice(balance.invoice),
    status: statusAsAtToday(balance),
    paidMinor: balance.state.paidMinor,
    creditedMinor: balance.state.creditedMinor,
    writtenOffMinor: balance.state.writtenOffMinor,
    outstandingMinor: balance.outstandingMinor,
    pendingPops: balance.state.pendingPops,
    ...(balance.futurePayments > 0 ? { futurePaidMinor: balance.futurePaidMinor, futurePayments: balance.futurePayments, nextFuturePaidAt: balance.nextFuturePaidAt } : {}),
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
  // Statuses follow "as at today" before anything is read (usually nothing to change).
  await refreshAsAtStatuses(ctx, companyId).catch((error) => ctx.logger.info("As-at refresh skipped", { companyId, error: errorMessage(error) }));
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
  // What waits on a person (money decisions and reminder approvals), and Billing's standing issues for the Account Manager.
  const invoiceClient = new Map(own.map((b) => [b.invoice.id, `${b.invoice.customer_kind}:${b.invoice.customer_ref}`]));
  const scopeKey = scope ? `${scope.kind}:${scope.id}` : null;
  const decisions = (await openDecisionList(ctx, companyId).catch(() => []))
    .filter((d) => !scopeKey || (d.invoiceId != null && invoiceClient.get(d.invoiceId) === scopeKey));
  const workIssues = scope ? [] : (await openWorkIssues(ctx, companyId).catch(() => [])).map((w) => ({ kind: w.kind, issueId: w.issue_id, subjectId: w.subject_id }));
  // Payments dated after today: in no total until their day; a person checks the date.
  const futurePayments = own
    .filter((b) => b.futurePayments > 0)
    .map((b) => ({ invoiceId: b.invoice.id, number: b.invoice.number, customerName: customerNameOf(b.invoice.customer_snapshot ?? b.invoice.customer) ?? b.invoice.customer_ref, amountMinor: b.futurePaidMinor, currency: b.invoice.currency, paidAt: b.nextFuturePaidAt, count: b.futurePayments }));
  return {
    asOf: asAtDate(),
    futurePayments,
    settingsSaved: Object.keys(settings).length > 0,
    defaults: {
      currency: settings.defaultCurrency ?? "ZAR",
      taxRate: Number(settings.defaultTaxRate ?? 0),
      // The code new lines get (out of scope when "VAT registered" is off).
      taxCode: settings.vatRegistered === false ? "za_out_of_scope" : settings.defaultTaxCode ?? null,
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
    // Online payments: which providers are on and, for those that are not, why (no secret is read).
    payments: { providers: providerStates(settings).map((p) => ({ key: p.key, label: p.label, enabled: p.enabled, blocker: p.blocker, webhookUrl: p.key === "stripe" || p.key === "payfast" ? webhookUrl(settings, p.key) : null })) },
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
    decisions,
    workIssues,
    team: await teamStatus(ctx, companyId).catch(() => null),
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
    followUps: invoice.company_id === companyId ? await followUpsFor(ctx, companyId, "invoice", invoice.id) : [],
    ledgerKey: `billing:invoice:${invoice.id}:issue`,
    // Online payment (empty while every provider is off): the links, and money paid back through a provider.
    paymentLinks: (await linksForInvoice(ctx, invoice.id)).map(publicLink),
    refunds: (await refundsForInvoice(ctx, invoice.id)).map((r) => ({ id: r.id, provider: r.provider, amountMinor: Number(r.amount_minor), reason: r.reason, source: r.source, createdAt: iso(r.created_at) })),
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
    followUps: await followUpsFor(ctx, companyId, "quote", quote.id),
  };
}

/** Quotes for an agent: optionally one client, status or deal. */
async function listQuotesAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const scope = readClientScope(params) ?? null;
  const status = optionalString(params, "status");
  if (status && !(QUOTE_STATUSES as readonly string[]).includes(status)) throw new BillingError(`status is one of ${QUOTE_STATUSES.join(", ")}`);
  const dealId = optionalString(params, "dealId");
  const rows = (await listQuotes(ctx, companyId, scope)).filter((quote) => (!status || quote.status === status) && (!dealId || quote.deal_id === dealId));
  return rows.slice(0, 100).map(publicQuote);
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
  await closePopIssues(ctx, companyId, result.confirmedPopIds);
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
        invoice.customer = mergeCustomer(asObject(invoice.customer), await customerDetails(ctx, template.company_id, template.customer_kind, template.customer_ref));
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

/** Reports "as at" `to` (default today, and never after today). With `client`, one customer's figures (the client workspace). */
async function reportsAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const today = asAtDate();
  const asked = optionalString(params, "to") ?? today;
  const to = asked > today ? today : asked;
  const from = optionalString(params, "from") ?? `${new Date(Date.UTC(new Date(to).getUTCFullYear(), new Date(to).getUTCMonth() - 11, 1)).toISOString().slice(0, 7)}-01`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new BillingError("from and to must be dates (YYYY-MM-DD)");
  const scope = readClientScope(params) ?? null;
  return { asOf: to, ...(await buildReports(ctx, companyId, await billingSettings(ctx, companyId), { from, to }, new Date(), scope)) };
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

/** Hourly: overdue invoices (not for companies with Billing off), the setup status, the Cockpit numbers and recent hand-offs again. */
async function markOverdueJob(ctx: PluginContext) {
  const off: string[] = [];
  for (const companyId of await knownCompanyIds(ctx).catch(() => [] as string[])) {
    if (!(await billingOn(ctx, companyId))) {
      off.push(companyId);
      continue;
    }
    // "As at today": a payment dated in the future counts once its day comes (and an early "paid" is undone).
    await refreshAsAtStatuses(ctx, companyId).catch((error) => ctx.logger.info("As-at refresh skipped", { companyId, error: errorMessage(error) }));
    await retitleSendApprovals(ctx, companyId).catch((error) => ctx.logger.info("Approval titles not synced", { companyId, error: errorMessage(error) }));
    // Payment links withdrawn since the last run are switched off at the provider (best effort; a failure is tried again next hour).
    if (await configSaved(ctx, companyId).catch(() => false)) {
      await housekeepPaymentLinks(ctx, companyId, await billingSettings(ctx, companyId)).catch((error) => ctx.logger.info("Payment link housekeeping skipped", { companyId, error: errorMessage(error) }));
    }
  }
  await markOverdue(ctx, off);
  await publishAllSetupStatus(ctx);
  await publishAllCockpit(ctx);
  await reemitHandoffs(ctx).catch((error) => ctx.logger.info("Hand-off re-send skipped", { error: errorMessage(error) }));
}

/** Nightly: erasures whose retention period has ended get the name and address replaced too. */
async function privacyRetentionJob(ctx: PluginContext) {
  for (const companyId of await companiesWithSettings(ctx)) {
    try {
      const finished = await finishErasureHolds(ctx, companyId);
      if (finished > 0) ctx.logger.info("Erasure retention periods ended", { companyId, finished });
    } catch (error) {
      ctx.logger.info("Erasure retention skipped", { companyId, error: errorMessage(error) });
    }
  }
}

/** Daily: the "Drafts to send" issue for each company, and the "Overdue invoices" issue kept current. */
async function draftsJob(ctx: PluginContext) {
  for (const companyId of await companiesWithSettings(ctx)) {
    try {
      await syncDraftsDigest(ctx, companyId);
      await syncOverdueDigest(ctx, companyId, { weekly: false });
      // Standing issues opened before 0.5 get their billing:<kind>:<id> origin id, so their done check runs.
      await refreshWorkIssueOrigins(ctx, companyId);
    } catch (error) {
      ctx.logger.info("Drafts to send skipped", { companyId, error: errorMessage(error) });
    }
  }
}

/** Weekly (Mondays): the "Overdue invoices" issue with the next step for each. */
async function overdueJob(ctx: PluginContext) {
  for (const companyId of await companiesWithSettings(ctx)) {
    try {
      await syncOverdueDigest(ctx, companyId, { weekly: true });
    } catch (error) {
      ctx.logger.info("Overdue invoices skipped", { companyId, error: errorMessage(error) });
    }
  }
}

/** Nightly: journals skipped while Accounting (or posting) was off. */
async function backpostJob(ctx: PluginContext) {
  for (const companyId of await companiesWithSettings(ctx)) {
    try {
      const counts = await postMissingJournals(ctx, companyId);
      if (backpostTotal(counts) > 0) ctx.logger.info("Posted journals skipped while Accounting was off", { companyId, ...counts });
    } catch (error) {
      ctx.logger.info("Journal back-posting skipped", { companyId, error: errorMessage(error) });
    }
  }
}

/** Setup's module switches (re-sent hourly): with Accounting on, post what it missed. */
async function onModulesUpdated(ctx: PluginContext, event: PluginEvent) {
  const payload = event.payload as ModulesPayload | undefined;
  const companyId = payload?.companyId ?? event.companyId;
  if (!companyId || !payload?.modules || payload.modules.accounting === false) return;
  const counts = await postMissingJournals(ctx, companyId);
  if (backpostTotal(counts) > 0) ctx.logger.info("Accounting is on: posted the journals it missed", { companyId, ...counts });
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

async function cockpitRoute(ctx: PluginContext, input: PluginApiRequestInput): Promise<PluginApiResponse> {
  if (!input.companyId) return { status: 400, body: { error: "companyId is required" } };
  try {
    return { status: 200, body: await cockpitSnapshot(ctx, input.companyId) };
  } catch (error) {
    ctx.logger.info("Billing cockpit snapshot failed", { error: errorMessage(error) });
    return { status: 500, body: { error: error instanceof Error ? error.message : "Cockpit snapshot failed" } };
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

/**
 * The CRM company page's Billing card: the same balances as the Billing
 * page and the Cockpit, as at today (a payment dated after today is not
 * counted yet).
 */
async function clientSummary(ctx: PluginContext, companyId: string, scope: ClientRef): Promise<ClientSummary> {
  const [balances, quotes, settings, lastPaidAt] = await Promise.all([
    invoiceBalances(ctx, companyId, { customerKind: scope.kind, customerRef: scope.id }),
    listQuotes(ctx, companyId, scope),
    billingSettings(ctx, companyId),
    customerLastPaidAt(ctx, companyId, scope),
  ]);
  const now = new Date();
  return clientBillingSummary({
    invoices: balances
      .filter((b) => b.invoice.status !== "cancelled")
      .map((b, index) => ({
        status: statusAsAtToday(b, now),
        currency: b.invoice.currency,
        totalMinor: Number(b.invoice.total_minor),
        paidMinor: b.state.paidMinor,
        creditedMinor: b.state.creditedMinor + b.state.writtenOffMinor,
        dueAt: isoOrNull(b.invoice.due_at),
        lastPaidAt: index === 0 ? lastPaidAt : null,
      })),
    quotes: quotes.map((quote) => ({ status: quote.status })),
    now,
    defaultCurrency: settings.defaultCurrency,
    asOf: asAtDate(now),
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

