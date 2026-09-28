/**
 * What agents ask a person for, and what happens when the person decides.
 *
 * - Sending an invoice or quote: an approval issue (the Reviewer checks first
 *   when one is running, else the Billing approver, else the owner). A
 *   person's "done" sends it; an agent's "done" is undone (`inbound.ts`).
 * - Payment reminders: the same approval route; "done" sends the stage.
 * - Money (recording a payment, a credit note, a payment check): a decision
 *   issue for a person; "done" applies it, "cancelled" drops it.
 *
 * Asking twice returns the open issue instead of opening another.
 */
import { createHash } from "node:crypto";
import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { createWorkIssue, formatMoneyMinor, PIB_PLUGINS, reviewerBrief } from "@partnersinbiz/pib-plugin-kit";
import { datedAfterToday, invoiceBalance, iso } from "./balances.js";
import { dunningStages, emailEnabled, loadBilling, privateR2 } from "./config.js";
import { checkCreditNote, issueCreditNote } from "./credits.js";
import { asObject, getInvoice, table } from "./db.js";
import { assertPaymentAmount, BillingError, daysPastDue, isOpenStatus } from "./domain.js";
import { DUNNABLE, optedOutClients, queueReminderStage, reminderVars, requestStage, sentStages } from "./dunning.js";
import { recipientsFor, requireOwnInvoice, requireQuote } from "./invoices.js";
import { parseAddresses, renderTemplate } from "./mail.js";
import { APPROVAL_ORIGINS } from "./origins.js";
import { closePopIssues, getPop, listPops, recordDecisionIssue, recordPop } from "./pop.js";
import { billingPath, companyPrefix, issuePath, personAssignee, sendApprovalRoute } from "./routing.js";
import { creditedOnInvoice, paymentBySourceKey, settle } from "./settle.js";
import { actorLabel, integer, optionalDate, optionalInteger, optionalString, requiredCompany, requiredString, requirePerson } from "./util.js";

const CLOSED = new Set(["done", "cancelled"]);

function who(context: PluginPerformActionContext): string {
  return context.actor.type === "agent" ? `An agent (${actorLabel(context)})` : "A person";
}

function customerName(doc: { customer?: unknown; customer_snapshot?: unknown; customer_ref: string }): string {
  const customer = asObject(doc.customer_snapshot ?? doc.customer);
  return typeof customer.name === "string" && customer.name ? customer.name : doc.customer_ref;
}

function clientParam(doc: { customer_kind: string; customer_ref: string }): string {
  return `${doc.customer_kind === "contact" ? "contact" : "company"}:${doc.customer_ref}`;
}

/** The issue behind a pending approval, when it is still open. */
async function openIssue(ctx: PluginContext, companyId: string, issueId: string | null | undefined): Promise<{ id: string; identifier: string | null } | null> {
  if (!issueId) return null;
  const issue = await ctx.issues.get(issueId, companyId).catch(() => null);
  if (!issue || CLOSED.has(String(issue.status))) return null;
  return { id: issue.id, identifier: issue.identifier ?? null };
}

/** Send-approval titles name the client and the amount: a draft's number means nothing to a person yet. */
export function sendApprovalTitle(kind: "invoice" | "quote", name: string, amount: string): string {
  return `Approve sending ${kind} to ${name} (${amount})`;
}

/**
 * Open send approvals raised before titles named the client and amount
 * ("Approve sending invoice INV-9F0D9A85 (Northwind)") get the new title.
 * Only a title still exactly in the old form is changed, never one a person
 * edited. Hourly; returns how many were renamed.
 */
export async function retitleSendApprovals(ctx: PluginContext, companyId: string): Promise<number> {
  const rows = await ctx.db.query<{ kind: string; number: string; issue_id: string; currency: string; total_minor: string | number; customer: unknown; customer_snapshot: unknown; customer_ref: string }>(
    `SELECT 'invoice' AS kind, number, approval_issue_id AS issue_id, currency, total_minor, customer, customer_snapshot, customer_ref FROM ${table(ctx, "invoices")}
      WHERE company_id = $1 AND pending_action = 'send' AND approval_issue_id IS NOT NULL
     UNION ALL
     SELECT 'quote' AS kind, number, approval_issue_id AS issue_id, currency, total_minor, customer, NULL AS customer_snapshot, customer_ref FROM ${table(ctx, "quotes")}
      WHERE company_id = $1 AND pending_action = 'send' AND approval_issue_id IS NOT NULL`,
    [companyId],
  );
  let renamed = 0;
  for (const row of rows) {
    const name = customerName(row);
    // The two older forms: with the client (0.4) and without it (earlier).
    const older = new Set([`Approve sending ${row.kind} ${row.number} (${name})`, `Approve sending ${row.kind} ${row.number}`]);
    const title = sendApprovalTitle(row.kind === "quote" ? "quote" : "invoice", name, formatMoneyMinor(Number(row.total_minor), row.currency));
    try {
      const issue = await ctx.issues.get(row.issue_id, companyId);
      if (!issue || CLOSED.has(String(issue.status)) || !older.has(String(issue.title))) continue;
      await ctx.issues.update(row.issue_id, { title }, companyId);
      renamed += 1;
    } catch (error) {
      ctx.logger.info("Send approval not renamed", { issueId: row.issue_id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return renamed;
}

/** An approval issue opened for a document that changed meanwhile (another request won, or it was sent): close it. */
async function withdrawIssue(ctx: PluginContext, companyId: string, issueId: string, why: string): Promise<void> {
  try {
    await ctx.issues.createComment(issueId, `Not needed: ${why}`, companyId);
    await ctx.issues.update(issueId, { status: "cancelled" }, companyId);
  } catch (error) {
    ctx.logger.info("Could not withdraw a duplicate approval issue", { issueId, error: error instanceof Error ? error.message : String(error) });
  }
}

/** A stable id from a key (UUID shaped, no colons), so a decision applied twice makes one record. */
export function stableId(key: string): string {
  const hex = createHash("sha256").update(key).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function issueRef(ctx: PluginContext, companyId: string, issueId: string): Promise<{ id: string; identifier: string | null }> {
  const issue = await ctx.issues.get(issueId, companyId).catch(() => null);
  return { id: issueId, identifier: issue?.identifier ?? null };
}

/** What the Reviewer checks on an invoice, quote or reminder before a person approves sending it. */
export function sendReviewBrief(what: string, emailed: boolean, approver: string | null | undefined): string {
  return reviewerBrief({
    what,
    checks: [
      "Customer and amounts: the right customer, lines, quantities and prices match the work or agreement.",
      "VAT: the right VAT code on each line, and the document is a Tax invoice only when your VAT number is set.",
      "Due date (or valid-until date) is correct for this customer.",
      "Bank details: account name, number and branch code on the document match your EFT details.",
      "PDF attached: the Billing page shows the document and it renders correctly.",
      emailed ? "Email wording: subject and message are plain, polite and name the right document." : "No email address: the person sends it themselves.",
      emailed ? "Recipients: the addresses listed above belong to this customer." : "Recipients: add the customer's billing email in the CRM if one should exist.",
    ],
    handTo: approver ? { userId: approver, label: `the person who approves Billing (user ${approver})` } : { label: "the company owner" },
  });
}

// ── Sending invoices and quotes ────────────────────────────────────────────

export interface SendRequestResult {
  invoiceId?: string;
  quoteId?: string;
  number: string;
  issueId: string;
  issue: string;
  pendingAction: "send";
  recipients: Array<{ email: string; name?: string | null }>;
  reviewer: boolean;
  already: boolean;
  next: string;
}

const SEND_NEXT = "Wait for the approval. When a person marks the issue done, Billing emails it from the Mailbox with its PDF and records it as sent. Never send it yourself.";

/** Ask for an invoice to be sent (agents and people). */
export async function requestInvoiceSend(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>): Promise<SendRequestResult> {
  const companyId = requiredCompany(context);
  const invoice = await requireOwnInvoice(ctx, companyId, requiredString(params, "invoiceId"));
  if (invoice.status === "cancelled") throw new BillingError(`Invoice ${invoice.number} is cancelled`);
  if (invoice.status !== "draft") throw new BillingError(`Invoice ${invoice.number} is already sent (${invoice.status}). Only a draft can be sent.`);
  if (invoice.delivery_status === "queued") throw new BillingError("This invoice is already being sent");
  if (Number(invoice.total_minor) <= 0) throw new BillingError("Add a line before sending the invoice");
  const { settings } = await loadBilling(ctx, companyId);
  const prefix = await companyPrefix(ctx, companyId);
  const pending = invoice.pending_action === "send" ? await openIssue(ctx, companyId, invoice.approval_issue_id) : null;
  if (pending) {
    const recipients = emailEnabled(settings) ? await recipientsFor(ctx, companyId, invoice) : [];
    return { invoiceId: invoice.id, number: invoice.number, issueId: pending.id, issue: issuePath(prefix, pending), pendingAction: "send", recipients, reviewer: false, already: true, next: SEND_NEXT };
  }
  // A send approval closed without Billing hearing of it may be replaced.
  const staleIssue = invoice.pending_action === "send" ? invoice.approval_issue_id ?? "" : "";
  if ("sendTo" in params) {
    await ctx.db.execute(`UPDATE ${table(ctx, "invoices")} SET send_to = $2::jsonb WHERE id = $1`, [invoice.id, JSON.stringify(parseAddresses(params.sendTo))]);
    invoice.send_to = parseAddresses(params.sendTo);
  }
  const recipients = emailEnabled(settings) ? await recipientsFor(ctx, companyId, invoice) : [];
  const route = await sendApprovalRoute(ctx, companyId, settings);
  const amount = formatMoneyMinor(Number(invoice.total_minor), invoice.currency);
  const name = customerName(invoice);
  const link = billingPath(prefix, { tab: "invoices", client: clientParam(invoice) });
  const lines = [
    `${who(context)} asks to send the draft invoice for ${amount} to ${name} (${clientParam(invoice)}). It gets its invoice number when it is sent.`,
    "",
    `Open it on the Billing page and check it: ${link}`,
    recipients.length
      ? `Mark this issue done to email it (with the PDF) to ${recipients.map((r) => r.email).join(", ")} from the Mailbox. Billing records it as sent when the email goes out and freezes the sender and customer details.`
      : `There is no email address for this customer${emailEnabled(settings) ? "" : " (email is off in Billing settings)"}, so mark this issue done after you have sent it yourself. Billing then records it as sent and freezes the sender and customer details.`,
    "Cancel this issue to keep it as a draft.",
  ];
  const issue = await createWorkIssue(ctx, {
    companyId,
    title: sendApprovalTitle("invoice", name, amount),
    description: route.reviewer ? `${lines.join("\n")}\n${sendReviewBrief(`the invoice to ${name} (${amount}) before it is emailed`, recipients.length > 0, route.approver)}` : lines.join("\n"),
    originKind: `plugin:${PIB_PLUGINS.billing}`,
    originId: `${APPROVAL_ORIGINS.invoiceSend}${invoice.id}`,
    ...route.assignee,
  });
  // Claim the invoice for this approval only if nothing changed meanwhile (never a whole-row save).
  const claim = await ctx.db.execute(
    `UPDATE ${table(ctx, "invoices")} SET approval_issue_id = $2, pending_action = 'send', updated_at = now()
      WHERE id = $1 AND status = 'draft' AND COALESCE(delivery_status, '') <> 'queued' AND (pending_action IS NULL OR approval_issue_id = $3)`,
    [invoice.id, issue.id, staleIssue],
  );
  if ((claim.rowCount ?? 0) === 0) {
    await withdrawIssue(ctx, companyId, issue.id, `invoice ${invoice.number} changed while this was opened (another send request, or it was sent).`);
    const fresh = await getInvoice(ctx, invoice.id);
    const other = fresh?.pending_action === "send" ? await openIssue(ctx, companyId, fresh.approval_issue_id) : null;
    if (other) return { invoiceId: invoice.id, number: invoice.number, issueId: other.id, issue: issuePath(prefix, other), pendingAction: "send", recipients, reviewer: false, already: true, next: SEND_NEXT };
    throw new BillingError(`Invoice ${invoice.number} changed while asking (it may be sent already). Check it with invoice-detail.`);
  }
  const ref = await issueRef(ctx, companyId, issue.id);
  return { invoiceId: invoice.id, number: invoice.number, issueId: issue.id, issue: issuePath(prefix, ref), pendingAction: "send", recipients, reviewer: Boolean(route.reviewer), already: false, next: SEND_NEXT };
}

/** Ask for a quote to be sent (agents and people). */
export async function requestQuoteSend(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>): Promise<SendRequestResult> {
  const companyId = requiredCompany(context);
  const quote = await requireQuote(ctx, companyId, requiredString(params, "quoteId"));
  if (quote.status !== "draft" && quote.status !== "sent") throw new BillingError(`Quote ${quote.number} is ${quote.status}. Only a draft or sent quote can be emailed.`);
  if (quote.delivery_status === "queued") throw new BillingError("This quote is already being sent");
  if (Number(quote.total_minor) <= 0) throw new BillingError("Add a line before sending the quote");
  const { settings } = await loadBilling(ctx, companyId);
  const prefix = await companyPrefix(ctx, companyId);
  const pending = quote.pending_action === "send" ? await openIssue(ctx, companyId, quote.approval_issue_id) : null;
  const recipients = emailEnabled(settings) ? await recipientsFor(ctx, companyId, quote) : [];
  if (pending) {
    return { quoteId: quote.id, number: quote.number, issueId: pending.id, issue: issuePath(prefix, pending), pendingAction: "send", recipients, reviewer: false, already: true, next: SEND_NEXT };
  }
  const staleIssue = quote.pending_action === "send" ? quote.approval_issue_id ?? "" : "";
  const route = await sendApprovalRoute(ctx, companyId, settings);
  const name = customerName(quote);
  const amount = formatMoneyMinor(Number(quote.total_minor), quote.currency);
  const link = billingPath(prefix, { tab: "quotes", client: clientParam(quote) });
  const lines = [
    `${who(context)} asks to send quote ${quote.number} for ${amount} to ${name} (${clientParam(quote)})${quote.deal_id ? `, for CRM deal ${quote.deal_id}` : ""}.`,
    "",
    `Check it on the Billing page: ${link}`,
    recipients.length
      ? `Mark this issue done to email it (with the PDF) to ${recipients.map((r) => r.email).join(", ")}. The email asks the customer to reply to accept.`
      : "There is no email address for this customer, so mark this issue done after you have sent it yourself.",
    "Cancel this issue to keep it as it is.",
  ];
  const issue = await createWorkIssue(ctx, {
    companyId,
    title: sendApprovalTitle("quote", name, amount),
    description: route.reviewer ? `${lines.join("\n")}\n${sendReviewBrief(`quote ${quote.number} before it is emailed`, recipients.length > 0, route.approver)}` : lines.join("\n"),
    originKind: `plugin:${PIB_PLUGINS.billing}`,
    originId: `${APPROVAL_ORIGINS.quoteSend}${quote.id}`,
    ...route.assignee,
  });
  const claim = await ctx.db.execute(
    `UPDATE ${table(ctx, "quotes")} SET approval_issue_id = $2, pending_action = 'send', updated_at = now()
      WHERE id = $1 AND status IN ('draft', 'sent') AND COALESCE(delivery_status, '') <> 'queued' AND (pending_action IS NULL OR approval_issue_id = $3)`,
    [quote.id, issue.id, staleIssue],
  );
  if ((claim.rowCount ?? 0) === 0) {
    await withdrawIssue(ctx, companyId, issue.id, `quote ${quote.number} changed while this was opened (another send request, or it was sent).`);
    throw new BillingError(`Quote ${quote.number} changed while asking. Check it with quote-detail; a send approval may already be open.`);
  }
  const ref = await issueRef(ctx, companyId, issue.id);
  return { quoteId: quote.id, number: quote.number, issueId: issue.id, issue: issuePath(prefix, ref), pendingAction: "send", recipients, reviewer: Boolean(route.reviewer), already: false, next: SEND_NEXT };
}

/** A person asks another person to confirm an invoice was paid in full (the 0.2 payment approval). */
export async function requestPayApproval(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  requirePerson(context, "asking for a payment approval (use record-payment, which asks a person for you)");
  const companyId = requiredCompany(context);
  const invoice = await requireOwnInvoice(ctx, companyId, requiredString(params, "invoiceId"));
  const balance = await invoiceBalance(ctx, invoice.id);
  if (!balance || balance.outstandingMinor <= 0 || invoice.status === "draft") throw new BillingError("This invoice cannot be marked paid");
  const { settings } = await loadBilling(ctx, companyId);
  const money = formatMoneyMinor(balance.outstandingMinor, invoice.currency);
  const issue = await createWorkIssue(ctx, {
    companyId,
    title: `Approve payment of ${invoice.number} (${customerName(invoice)}, ${money})`,
    description: `Confirm the payment of ${money} for invoice ${invoice.number} has cleared (EFT proof and the bank statement), then mark this issue done. The plugin then records the payment and the invoice is paid.`,
    originKind: `plugin:${PIB_PLUGINS.billing}`,
    originId: `${APPROVAL_ORIGINS.invoicePay}${invoice.id}`,
    ...(await personAssignee(ctx, companyId, settings)),
  });
  const claim = await ctx.db.execute(
    `UPDATE ${table(ctx, "invoices")} SET approval_issue_id = $2, pending_action = 'pay', updated_at = now()
      WHERE id = $1 AND pending_action IS NULL AND status NOT IN ('draft', 'cancelled')`,
    [invoice.id, issue.id],
  );
  if ((claim.rowCount ?? 0) === 0) {
    await withdrawIssue(ctx, companyId, issue.id, `another approval is already open for invoice ${invoice.number}.`);
    throw new BillingError(`Another approval is already open for invoice ${invoice.number}`);
  }
  return { invoiceId: invoice.id, issueId: issue.id, pendingAction: "pay", recipients: [] };
}

// ── Money decisions ────────────────────────────────────────────────────────

export interface DecisionRow {
  issue_id: string;
  company_id: string;
  kind: string;
  subject_kind: string;
  subject_id: string;
  payload: unknown;
  status: string;
  created_at?: unknown;
}

async function openDecisions(ctx: PluginContext, companyId: string, kind: string, subjectId: string): Promise<DecisionRow[]> {
  return ctx.db.query<DecisionRow>(
    `SELECT issue_id, company_id, kind, subject_kind, subject_id, payload, status, created_at FROM ${table(ctx, "decision_issues")}
      WHERE company_id = $1 AND kind = $2 AND subject_id = $3 AND status = 'open' ORDER BY created_at`,
    [companyId, kind, subjectId],
  );
}

function decisionResult(prefix: string | null, issue: { id: string; identifier: string | null }, extra: Record<string, unknown>) {
  return { requested: true, issueId: issue.id, issue: issuePath(prefix, issue), ...extra };
}

/** An agent's `record-payment`: a person checks the bank and records it by marking the issue done. */
export async function requestPaymentDecision(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const invoice = await requireOwnInvoice(ctx, companyId, requiredString(params, "invoiceId"));
  if (invoice.status === "draft") throw new BillingError("Send the invoice before recording a payment");
  if (invoice.status === "cancelled") throw new BillingError("This invoice is cancelled");
  const amountMinor = assertPaymentAmount(integer(params.amountMinor, "amountMinor"));
  const paymentKey = optionalString(params, "paymentKey") ?? null;
  const recorded = paymentKey ? await paymentBySourceKey(ctx, companyId, `manual:${paymentKey}`) : null;
  if (recorded) return { recorded: true, paymentId: recorded.id, invoiceId: invoice.id, number: invoice.number, next: "This payment is already recorded." };
  if (invoice.status === "paid" || invoice.status === "written_off") {
    throw new BillingError(`Invoice ${invoice.number} is already ${invoice.status.replace(/_/g, " ")}, so this money would only become customer credit. If the customer really paid again, ask the owner (ask-owner).`);
  }
  const method = (optionalString(params, "method") ?? "eft").toLowerCase();
  const reference = optionalString(params, "reference") ?? null;
  const paidAt = optionalDate(params, "paidAt") ?? null;
  if (datedAfterToday(paidAt)) throw new BillingError(`paidAt ${String(paidAt).slice(0, 10)} is after today. Only money already in the bank is recorded: check the date.`);
  const prefix = await companyPrefix(ctx, companyId);
  const next = "A person checks the bank and marks the issue done; Billing then records the payment. Don't record it again, and don't tell the customer it is paid until the invoice status is paid.";
  const open = (await openDecisions(ctx, companyId, "payment", invoice.id)).find((d) => {
    const p = asObject(d.payload);
    return paymentKey ? p.paymentKey === paymentKey : Number(p.amountMinor) === amountMinor;
  });
  if (open) return decisionResult(prefix, await issueRef(ctx, companyId, open.issue_id), { already: true, invoiceId: invoice.id, number: invoice.number, amountMinor, next });
  const { settings } = await loadBilling(ctx, companyId);
  const balance = await invoiceBalance(ctx, invoice.id);
  const owed = balance?.outstandingMinor ?? Number(invoice.total_minor);
  const money = formatMoneyMinor(amountMinor, invoice.currency);
  const name = customerName(invoice);
  const lines = [
    `${who(context)} asks to record a payment of ${money} on invoice ${invoice.number} (${name}, ${clientParam(invoice)}).`,
    `- Method: ${method}${reference ? ` · Reference: ${reference}` : ""}${paidAt ? ` · Paid on: ${paidAt.slice(0, 10)}` : ""}`,
    `- The invoice still owes ${formatMoneyMinor(owed, invoice.currency)}.${amountMinor > owed ? " Anything above that stays with the customer as credit." : ""}`,
    "",
    "Check the bank statement. Only when the money is in:",
    "- Mark this issue done to record it. The invoice becomes paid (or part paid) and the payment goes to the books.",
    "- Cancel this issue if the money is not in; nothing is recorded.",
    "",
    `Invoice: ${billingPath(prefix, { tab: "invoices", client: clientParam(invoice) })}`,
  ];
  const issue = await createWorkIssue(ctx, {
    companyId,
    title: `Record payment of ${money} on ${invoice.number} (${name})?`,
    description: lines.join("\n"),
    originKind: `plugin:${PIB_PLUGINS.billing}`,
    originId: `${APPROVAL_ORIGINS.recordPayment}${invoice.id}`,
    ...(await personAssignee(ctx, companyId, settings)),
  });
  await recordDecisionIssue(ctx, {
    issueId: issue.id,
    companyId,
    kind: "payment",
    subjectKind: "invoice",
    subjectId: invoice.id,
    // What the invoice owed when asked: if money arrives another way meanwhile, the person records it on the page instead.
    payload: { invoiceId: invoice.id, number: invoice.number, amountMinor, currency: invoice.currency, method, reference, paidAt, paymentKey, owedMinor: owed, requestedBy: actorLabel(context) },
  });
  return decisionResult(prefix, await issueRef(ctx, companyId, issue.id), { already: false, invoiceId: invoice.id, number: invoice.number, amountMinor, next });
}

/** An agent's `create-credit-note`: a person decides; "done" issues the credit note. */
export async function requestCreditDecision(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const amountMinor = integer(params.amountMinor, "amountMinor");
  const reason = optionalString(params, "reason") ?? null;
  const { invoice } = await checkCreditNote(ctx, companyId, requiredString(params, "invoiceId"), amountMinor, reason);
  const prefix = await companyPrefix(ctx, companyId);
  const next = "A person decides on the issue; when they mark it done Billing issues the credit note, applies it and posts it to the books. A person emails it from the Billing page.";
  const open = (await openDecisions(ctx, companyId, "credit_note", invoice.id)).find((d) => Number(asObject(d.payload).amountMinor) === amountMinor);
  if (open) return decisionResult(prefix, await issueRef(ctx, companyId, open.issue_id), { already: true, invoiceId: invoice.id, number: invoice.number, amountMinor, next });
  const { settings } = await loadBilling(ctx, companyId);
  const balance = await invoiceBalance(ctx, invoice.id);
  const money = formatMoneyMinor(amountMinor, invoice.currency);
  const owed = balance?.outstandingMinor ?? 0;
  const lines = [
    `${who(context)} asks to issue a credit note of ${money} (incl. VAT) against invoice ${invoice.number} (${customerName(invoice)}, ${clientParam(invoice)}).`,
    `- Reason: ${reason ?? "none given"}`,
    `- The invoice still owes ${formatMoneyMinor(owed, invoice.currency)}. The credit is applied to that first; the rest stays with the customer as credit.`,
    "",
    "Mark this issue done to issue it (it is numbered, applied and posted to the books). Cancel this issue to refuse it.",
    "",
    `Invoice: ${billingPath(prefix, { tab: "invoices", client: clientParam(invoice) })}`,
  ];
  const issue = await createWorkIssue(ctx, {
    companyId,
    title: `Issue credit note of ${money} on ${invoice.number} (${customerName(invoice)})?`,
    description: lines.join("\n"),
    originKind: `plugin:${PIB_PLUGINS.billing}`,
    originId: `${APPROVAL_ORIGINS.creditNote}${invoice.id}`,
    ...(await personAssignee(ctx, companyId, settings)),
  });
  await recordDecisionIssue(ctx, {
    issueId: issue.id,
    companyId,
    kind: "credit_note",
    subjectKind: "invoice",
    subjectId: invoice.id,
    payload: { invoiceId: invoice.id, number: invoice.number, amountMinor, currency: invoice.currency, reason, creditedMinor: await creditedOnInvoice(ctx, invoice.id), requestedBy: actorLabel(context) },
  });
  return decisionResult(prefix, await issueRef(ctx, companyId, issue.id), { already: false, invoiceId: invoice.id, number: invoice.number, amountMinor, next });
}

/** An agent reports that a customer says they paid: the same person check as an emailed proof of payment. */
export async function requestPaymentCheck(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const invoice = await requireOwnInvoice(ctx, companyId, requiredString(params, "invoiceId"));
  if (invoice.status === "draft") throw new BillingError(`Invoice ${invoice.number} is still a draft: it was never sent, so nothing can be paid on it yet`);
  if (invoice.status === "cancelled") throw new BillingError(`Invoice ${invoice.number} is cancelled`);
  if (!isOpenStatus(invoice.status)) throw new BillingError(`Invoice ${invoice.number} is already ${invoice.status.replace(/_/g, " ")}. Nothing to check.`);
  const note = requiredString(params, "note").slice(0, 1000);
  const amountMinor = optionalInteger(params, "amountMinor");
  if (amountMinor != null && amountMinor <= 0) throw new BillingError("amountMinor must be a positive integer in cents");
  const paidOn = optionalDate(params, "paidOn")?.slice(0, 10) ?? null;
  const reference = optionalString(params, "reference") ?? null;
  const mailMessageId = optionalString(params, "mailMessageId") ?? null;
  const prefix = await companyPrefix(ctx, companyId);
  const next = "A person checks the bank. When they mark the issue done, the payment is recorded and the invoice is paid. Don't tell the customer it is paid until the invoice status is paid.";
  // Already waiting on a check for this invoice: add what the agent learned to that issue.
  const pending = (await listPops(ctx, companyId, { status: "pending", invoiceIds: [invoice.id] }))[0];
  if (pending && (!mailMessageId || pending.mail_message_id !== mailMessageId)) {
    if (pending.issue_id) {
      const extra = [amountMinor ? formatMoneyMinor(amountMinor, invoice.currency) : null, paidOn ? `paid on ${paidOn}` : null, reference ? `reference ${reference}` : null].filter(Boolean).join(", ");
      await ctx.issues.createComment(pending.issue_id, `${who(context)} adds: "${note}"${extra ? ` (${extra})` : ""}.`, companyId).catch(() => undefined);
    }
    const ref = pending.issue_id ? await issueRef(ctx, companyId, pending.issue_id) : null;
    return { requested: true, already: true, popId: pending.id, issueId: pending.issue_id, issue: ref ? issuePath(prefix, ref) : null, invoiceId: invoice.id, number: invoice.number, status: "payment_pending_verification", next };
  }
  const { settings } = await loadBilling(ctx, companyId);
  const recorded = await recordPop(ctx, {
    companyId,
    invoiceId: invoice.id,
    source: "agent",
    basis: "agent",
    amountMinor: amountMinor ?? null,
    reference,
    subject: "Payment check asked for by an agent",
    snippet: note,
    mailMessageId,
    paidOn,
    createdBy: actorLabel(context),
  }, settings);
  const pop = await getPop(ctx, recorded.popId);
  const issueId = recorded.issueId ?? pop?.issue_id ?? null;
  const ref = issueId ? await issueRef(ctx, companyId, issueId) : null;
  return { requested: true, already: !recorded.created, popId: recorded.popId, issueId, issue: ref ? issuePath(prefix, ref) : null, invoiceId: invoice.id, number: invoice.number, status: "payment_pending_verification", next };
}

// ── Payment reminders ──────────────────────────────────────────────────────

/** An agent asks for the next payment reminder on an overdue invoice; a person approves the email. */
export async function requestReminderSend(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>, now = new Date()) {
  const companyId = requiredCompany(context);
  const invoice = await requireOwnInvoice(ctx, companyId, requiredString(params, "invoiceId"));
  const { settings } = await loadBilling(ctx, companyId);
  const balance = await invoiceBalance(ctx, invoice.id);
  const name = customerName(invoice);
  if (!balance || balance.outstandingMinor <= 0 || !isOpenStatus(invoice.status)) throw new BillingError(`Invoice ${invoice.number} is not owed (${invoice.status.replace(/_/g, " ")}), so there is nothing to remind about`);
  if (invoice.status === "payment_pending_verification") throw new BillingError(`A proof of payment for ${invoice.number} is waiting for a person's check. No reminder until that check is done.`);
  const dueAt = iso(invoice.due_at);
  if (!dueAt || Date.parse(dueAt) >= now.getTime()) throw new BillingError(`Invoice ${invoice.number} is not overdue yet${dueAt ? ` (due ${dueAt.slice(0, 10)})` : ""}`);
  if (!emailEnabled(settings)) throw new BillingError("Email is off in Billing settings, so reminders cannot be sent. Ask the owner (ask-owner) how to chase this customer.");
  if ((await optedOutClients(ctx, companyId)).has(`${invoice.customer_kind}:${invoice.customer_ref}`)) {
    throw new BillingError(`${name} gets no payment reminders (opted out). Ask the owner (ask-owner) before chasing them.`);
  }
  const stages = dunningStages(settings);
  const days = daysPastDue(dueAt, now);
  const pick = requestStage(stages, days, (await sentStages(ctx, companyId)).get(invoice.id) ?? []);
  if (settings.dunning?.enabled === true) {
    throw new BillingError(pick.stage != null
      ? `Automatic reminders are on: reminder ${pick.stage + 1} for ${invoice.number} goes out by itself on the next morning run. No request needed.`
      : `Automatic reminders are on and send each stage by itself. ${pick.reason === "all_sent" ? `All ${stages.length} reminders for ${invoice.number} went out: ask the owner (ask-owner) whether to call, agree a payment plan or write it off.` : `The next one for ${invoice.number} is due in ${pick.dueInDays} day(s).`}`);
  }
  if (pick.stage == null) {
    if (pick.reason === "all_sent") throw new BillingError(`All ${stages.length} reminders for ${invoice.number} were sent. Next: ask the owner (ask-owner) whether to call the customer, agree a payment plan or write the invoice off (a person does that).`);
    const dueOn = new Date(Date.parse(dueAt) + stages[pick.nextStage]!.daysAfterDue * 86_400_000).toISOString().slice(0, 10);
    throw new BillingError(`Reminder ${pick.nextStage + 1} for ${invoice.number} is due on ${dueOn} (in ${pick.dueInDays} day(s)). Ask again then.`);
  }
  const prefix = await companyPrefix(ctx, companyId);
  const next = "A person approves the email on the issue; Billing then sends it from the Mailbox. Nothing else to do until then.";
  const open = (await openDecisions(ctx, companyId, "reminder", invoice.id))[0];
  if (open) return decisionResult(prefix, await issueRef(ctx, companyId, open.issue_id), { already: true, invoiceId: invoice.id, number: invoice.number, stage: Number(asObject(open.payload).stage ?? 0) + 1, next });
  const recipients = await recipientsFor(ctx, companyId, invoice);
  if (recipients.length === 0) throw new BillingError(`There is no email address for ${name}. Add their billing email in the CRM first.`);
  const stage = stages[pick.stage]!;
  const vars = reminderVars(balance, days, settings);
  const route = await sendApprovalRoute(ctx, companyId, settings);
  const lines = [
    `${who(context)} asks to email payment reminder ${pick.stage + 1} of ${stages.length} for invoice ${invoice.number} (${name}, ${clientParam(invoice)}): ${formatMoneyMinor(balance.outstandingMinor, invoice.currency)} outstanding, ${days} day(s) overdue.`,
    "",
    `To: ${recipients.map((r) => r.email).join(", ")}`,
    `Subject: ${renderTemplate(stage.subject, vars)}`,
    "Message:",
    ...renderTemplate(stage.body, vars).split("\n").map((line) => `> ${line}`),
    "",
    "Mark this issue done to send it from the Mailbox (with the invoice PDF and EFT details). Cancel this issue to send nothing.",
    `Invoice: ${billingPath(prefix, { tab: "invoices", client: clientParam(invoice) })}`,
  ];
  const issue = await createWorkIssue(ctx, {
    companyId,
    title: `Approve payment reminder ${pick.stage + 1} for ${invoice.number} (${name}, ${formatMoneyMinor(balance.outstandingMinor, invoice.currency)})`,
    description: route.reviewer ? `${lines.join("\n")}\n${sendReviewBrief(`payment reminder ${pick.stage + 1} for invoice ${invoice.number} before it is emailed`, true, route.approver)}` : lines.join("\n"),
    originKind: `plugin:${PIB_PLUGINS.billing}`,
    originId: `${APPROVAL_ORIGINS.reminder}${invoice.id}`,
    ...route.assignee,
  });
  await recordDecisionIssue(ctx, {
    issueId: issue.id,
    companyId,
    kind: "reminder",
    subjectKind: "invoice",
    subjectId: invoice.id,
    payload: { invoiceId: invoice.id, number: invoice.number, stage: pick.stage, requestedBy: actorLabel(context) },
  });
  return decisionResult(prefix, await issueRef(ctx, companyId, issue.id), { already: false, invoiceId: invoice.id, number: invoice.number, stage: pick.stage + 1, recipients, reviewer: Boolean(route.reviewer), next });
}

// ── Applying a person's decision ───────────────────────────────────────────

export const REQUEST_KINDS = ["payment", "credit_note", "reminder"] as const;

/**
 * A person marked a payment, credit-note or reminder decision done (or
 * cancelled it). Returns a line for the issue, or throws when it could not be
 * applied (the caller reopens the issue with the reason).
 */
export async function applyDecision(ctx: PluginContext, decision: DecisionRow, done: boolean, actor: string, issue: { id: string; identifier?: string | null }): Promise<string | null> {
  if (!done) return null;
  const payload = asObject(decision.payload);
  const companyId = decision.company_id;
  if (decision.kind === "payment") {
    const { settings } = await loadBilling(ctx, companyId);
    const number = String(payload.number ?? "");
    const currency = String(payload.currency ?? "ZAR");
    const balance = await invoiceBalance(ctx, String(payload.invoiceId));
    // Never count the same money twice: skip when the invoice was paid or credited another way since the request.
    if (!balance || !isOpenStatus(balance.invoice.status) || balance.outstandingMinor <= 0) {
      await dismissDecision(ctx, decision.issue_id);
      return `Not recorded: invoice ${number} is ${balance?.invoice.status.replace(/_/g, " ") ?? "gone"} now, so this money is most likely recorded already (a bank match, a proof of payment or the Billing page). If it really is extra money, record it on the Billing page.`;
    }
    if (payload.owedMinor != null && balance.outstandingMinor < Number(payload.owedMinor)) {
      await dismissDecision(ctx, decision.issue_id);
      return `Not recorded: since this was asked, ${formatMoneyMinor(Number(payload.owedMinor) - balance.outstandingMinor, currency)} was recorded or credited on ${number} (it now owes ${formatMoneyMinor(balance.outstandingMinor, currency)}). Check it is not the same money; if it is extra, record it on the Billing page.`;
    }
    if (payload.paymentKey) {
      const key = String(payload.paymentKey);
      const bank = await ctx.db.query<{ id: string }>(
        `SELECT id FROM ${table(ctx, "payments")} WHERE company_id = $1 AND (bank_tx_id = $2 OR source_key = $3) LIMIT 1`,
        [companyId, key, `bank:${key}`],
      );
      if (bank[0]) {
        await dismissDecision(ctx, decision.issue_id);
        return `Not recorded: bank line ${key} is already recorded (a bank match). Nothing was added.`;
      }
    }
    const settled = await settle(ctx, {
      companyId,
      invoiceId: String(payload.invoiceId),
      amountMinor: Number(payload.amountMinor),
      sourceKey: payload.paymentKey ? `manual:${String(payload.paymentKey)}` : `decision:${decision.issue_id}`,
      source: "approval",
      method: typeof payload.method === "string" ? payload.method : "eft",
      reference: typeof payload.reference === "string" && payload.reference ? payload.reference : `Approved on issue ${issue.identifier ?? issue.id}`,
      paidAt: typeof payload.paidAt === "string" ? payload.paidAt : null,
      createdBy: actor,
    }, settings);
    await closePopIssues(ctx, companyId, settled.confirmedPopIds);
    return `Recorded ${formatMoneyMinor(settled.amountMinor, String(payload.currency ?? "ZAR"))} on ${settled.invoiceNumber}: the invoice is now ${settled.status.replace(/_/g, " ")}${settled.outstandingMinor > 0 ? ` with ${formatMoneyMinor(settled.outstandingMinor, String(payload.currency ?? "ZAR"))} still owed` : ""}.`;
  }
  if (decision.kind === "credit_note") {
    const id = stableId(`credit-decision:${decision.issue_id}`);
    const invoiceId = String(payload.invoiceId);
    // Issued on the page since the request: do not add a second one by accident.
    const already = (await ctx.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table(ctx, "credit_notes")} WHERE id = $1`, [id]))[0];
    if (Number(already?.n ?? 0) === 0 && payload.creditedMinor != null && (await creditedOnInvoice(ctx, invoiceId)) > Number(payload.creditedMinor)) {
      await dismissDecision(ctx, decision.issue_id);
      return `Not issued: a credit note was issued on ${String(payload.number ?? "")} since this was asked. If this one is still needed, issue it on the Billing page.`;
    }
    const note = await issueCreditNote(ctx, { id, companyId, invoiceId, amountMinor: Number(payload.amountMinor), reason: typeof payload.reason === "string" ? payload.reason : null, createdBy: actor });
    return `Issued credit note ${note.number} (${formatMoneyMinor(note.amountMinor, String(payload.currency ?? "ZAR"))}); invoice ${String(payload.number ?? "")} is now ${String(note.invoiceStatus).replace(/_/g, " ")}. Email it from the Billing page if the customer should get it.`;
  }
  if (decision.kind === "reminder") {
    const { settings, resolver } = await loadBilling(ctx, companyId);
    const balance = await invoiceBalance(ctx, String(payload.invoiceId));
    if (!balance || balance.outstandingMinor <= 0 || !DUNNABLE.has(balance.invoice.status)) return `Not sent: invoice ${String(payload.number ?? "")} is ${balance?.invoice.status.replace(/_/g, " ") ?? "gone"} now.`;
    if (!emailEnabled(settings)) return "Not sent: email is off in Billing settings.";
    const r2 = settings.dunning?.attachInvoice === false ? null : await privateR2(resolver, settings).catch(() => null);
    const outcome = await queueReminderStage(ctx, {
      companyId,
      balance,
      stageIndex: Number(payload.stage ?? 0),
      daysOverdue: daysPastDue(iso(balance.invoice.due_at), new Date()),
      settings,
      r2,
      createdBy: actor,
    });
    if (outcome.status === "queued") return `Reminder ${Number(payload.stage ?? 0) + 1} for ${balance.invoice.number} is queued in the Mailbox.`;
    if (outcome.status === "already") return `Reminder ${Number(payload.stage ?? 0) + 1} for ${balance.invoice.number} was already sent; nothing more was sent.`;
    return `Not sent: ${outcome.error ?? "the reminder could not be queued"}.`;
  }
  return null;
}

/** A decision the person approved but that was not applied (it was no longer needed). */
async function dismissDecision(ctx: PluginContext, issueId: string): Promise<void> {
  await ctx.db.execute(`UPDATE ${table(ctx, "decision_issues")} SET status = 'dismissed', resolved_at = now() WHERE issue_id = $1`, [issueId]);
}

/** Open decisions for the page and the Cockpit, in plain words. */
export async function openDecisionList(ctx: PluginContext, companyId: string): Promise<Array<{ issueId: string; kind: string; title: string; invoiceId: string | null; amountMinor: number | null; currency: string | null; createdAt: string | null }>> {
  const rows = await ctx.db.query<DecisionRow>(
    `SELECT issue_id, company_id, kind, subject_kind, subject_id, payload, status, created_at FROM ${table(ctx, "decision_issues")}
      WHERE company_id = $1 AND status = 'open' ORDER BY created_at LIMIT 100`,
    [companyId],
  );
  return rows.map((row) => {
    const p = asObject(row.payload);
    const currency = typeof p.currency === "string" ? p.currency : null;
    const amount = p.amountMinor != null ? Number(p.amountMinor) : null;
    const money = amount != null ? formatMoneyMinor(amount, currency ?? "ZAR") : "";
    const number = String(p.number ?? "");
    const title = row.kind === "payment"
      ? `Record payment of ${money} on ${number}`
      : row.kind === "credit_note"
        ? `Issue credit note of ${money} on ${number}`
        : row.kind === "reminder"
          ? `Send payment reminder ${Number(p.stage ?? 0) + 1} for ${number}`
          : row.kind === "pop"
            ? "Check a proof of payment"
            : row.kind === "bank_match"
              ? "Check a bank match"
              : "Decide a Billing request";
    return { issueId: row.issue_id, kind: row.kind, title, invoiceId: typeof p.invoiceId === "string" ? p.invoiceId : row.subject_kind === "invoice" ? row.subject_id : null, amountMinor: amount, currency, createdAt: iso(row.created_at) };
  });
}

