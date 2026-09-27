/**
 * Events from other plugins and from Paperclip issues:
 * - Mailbox `mail.send.result` → delivery recorded, invoice marked sent.
 * - Mailbox `mail.received` → a reply to a quote, a proof of payment or a supplier's bill.
 * - Accounting `ledger.post.result` → journal number on the document.
 * - Accounting `bank.matched` → settle or ask a person.
 * - `issue.updated` → approvals and decisions a person finished (an agent's "done" is undone).
 */
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import {
  MAIL_EVENTS,
  PIB_PLUGINS,
  receiveOnce,
  reopenApprovalForPerson,
  type BankMatched,
  type LedgerPostResult,
  type MailReceived,
  type MailSendResult,
} from "@partnersinbiz/pib-plugin-kit";
import { invoiceBalance } from "./balances.js";
import { emitBankMatchResult, onBankMatched, settleBankMatch } from "./bank.js";
import { billingSettings, type BillingSettings } from "./config.js";
import { approveBill, billByApproval, draftBillFromEmail } from "./costs.js";
import { asObject, getQuote, invoiceByApproval, quoteByApproval, saveQuoteStatus, table } from "./db.js";
import { openQuoteReplyIssue, quoteForReply } from "./followups.js";
import { markInvoiceSent, startInvoiceSend, startQuoteSend } from "./invoices.js";
import { parseMailKey, settleMailResult } from "./mail.js";
import { onLedgerResult } from "./posting.js";
import { choosePopInvoice, closePopIssues, confirmPop, getPop, lookupSender, looksLikePop, mailText, openInvoiceCandidates, recordPop, rejectPop, threadInvoiceId } from "./pop.js";
import { applyDecision, REQUEST_KINDS, type DecisionRow } from "./requests.js";
import { settle } from "./settle.js";
import { errorMessage } from "./util.js";

export const MAIL_RESULT_EVENT = `plugin.${PIB_PLUGINS.mailbox}.${MAIL_EVENTS.sendResult}` as const;
export const MAIL_RECEIVED_EVENT = `plugin.${PIB_PLUGINS.mailbox}.${MAIL_EVENTS.received}` as const;

const DOC_TABLE: Record<string, string> = { invoice: "invoices", quote: "quotes", credit_note: "credit_notes" };

// ── Mail results ───────────────────────────────────────────────────────────

export async function onMailResult(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const result = event.payload as MailSendResult;
  if (!result?.key || result.context?.plugin !== PIB_PLUGINS.billing) return;
  const parsed = parseMailKey(result.key);
  const done = await settleMailResult(ctx, result);
  if (!parsed) return;
  const docTable = DOC_TABLE[parsed.kind];
  if (!done) {
    // Transient failure: show it, keep retrying.
    if (docTable && result.status === "failed") {
      await ctx.db.execute(`UPDATE ${table(ctx, docTable)} SET delivery_error = $3 WHERE id = $1 AND delivery_key = $2 AND delivery_status = 'queued'`, [parsed.id, result.key, `Retrying: ${String(result.error ?? "send failed")}`]);
    }
    return;
  }
  const settings = await billingSettings(ctx, event.companyId || done.delivery.company_id);
  if (parsed.kind === "invoice") {
    if (done.status === "sent") await markInvoiceSent(ctx, parsed.id, result.sentAt ?? null, "sent", settings);
    else await ctx.db.execute(`UPDATE ${table(ctx, "invoices")} SET delivery_status = 'failed', delivery_error = $3 WHERE id = $1 AND delivery_key = $2`, [parsed.id, result.key, String(result.error ?? "Sending failed")]);
    return;
  }
  if (parsed.kind === "quote") {
    if (done.status === "sent") {
      const quote = await getQuote(ctx, parsed.id);
      if (quote) {
        if (quote.status === "draft") quote.status = "sent";
        quote.sent_at = quote.sent_at ?? result.sentAt ?? new Date().toISOString();
        await saveQuoteStatus(ctx, quote);
      }
      await ctx.db.execute(`UPDATE ${table(ctx, "quotes")} SET delivery_status = 'sent', delivery_error = NULL WHERE id = $1 AND delivery_key = $2`, [parsed.id, result.key]);
    } else {
      await ctx.db.execute(`UPDATE ${table(ctx, "quotes")} SET delivery_status = 'failed', delivery_error = $3 WHERE id = $1 AND delivery_key = $2`, [parsed.id, result.key, String(result.error ?? "Sending failed")]);
    }
    return;
  }
  if (parsed.kind === "credit_note") {
    await ctx.db.execute(
      `UPDATE ${table(ctx, "credit_notes")} SET delivery_status = $3, delivery_error = $4 WHERE id = $1 AND delivery_key = $2`,
      [parsed.id, result.key, done.status, done.status === "failed" ? String(result.error ?? "Sending failed") : null],
    );
    return;
  }
  if (parsed.kind === "reminder") {
    await ctx.db.execute(
      `UPDATE ${table(ctx, "reminders")} SET status = $2, error = $3 WHERE delivery_key = $1`,
      [result.key, done.status, done.status === "failed" ? String(result.error ?? "Sending failed") : null],
    );
  }
  void settings;
}

/** Deliveries the outbox gave up on: show the failure on the document. */
export async function markFailedDeliveries(ctx: PluginContext, failed: Array<{ key: string; doc_kind: string; doc_id: string; error: string | null }>): Promise<void> {
  for (const row of failed) {
    const docTable = DOC_TABLE[row.doc_kind];
    const message = row.error ?? "The Mailbox did not answer. Check that it is installed and Gmail is connected.";
    if (docTable) {
      await ctx.db.execute(`UPDATE ${table(ctx, docTable)} SET delivery_status = 'failed', delivery_error = $3 WHERE id = $1 AND delivery_key = $2`, [row.doc_id, row.key, message]);
    } else if (row.doc_kind === "reminder") {
      await ctx.db.execute(`UPDATE ${table(ctx, "reminders")} SET status = 'failed', error = $2 WHERE delivery_key = $1`, [row.key, message]);
    }
  }
}

// ── Inbound mail ───────────────────────────────────────────────────────────

const BILL_NUMBER_RE = /\b(?:invoice|inv|bill|tax invoice)\s*(?:no\.?|number|#)?\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9/_-]{2,30})/i;

export async function onMailReceived(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const mail = event.payload as MailReceived;
  const companyId = event.companyId;
  if (!mail?.key || !mail.messageId || !companyId) return;
  const fromEmail = String(mail.from?.email ?? "").toLowerCase();
  if (fromEmail && fromEmail === String(mail.accountAddress ?? "").toLowerCase()) return;
  const category = mail.triage?.category ?? null;
  // A customer answering a quote email (accept, decline, a question): an issue for the Account Manager.
  if (!mail.bounce && category !== "spam" && category !== "proof_of_payment") {
    const quoteId = await quoteForReply(ctx, companyId, mail);
    if (quoteId) {
      await receiveOnce(ctx, companyId, MAIL_RECEIVED_EVENT, `quote-reply:${mail.key}`, () => openQuoteReplyIssue(ctx, companyId, mail, quoteId));
      return;
    }
  }
  const threadInvoice = threadInvoiceId(mail);
  // Cheap exit for mail that is never a payment or a bill.
  if (!threadInvoice && category && ["spam", "newsletter", "notification", "lead", "personal", "bank_statement"].includes(category)) return;
  const settings = await billingSettings(ctx, companyId);
  const open = await openInvoiceCandidates(ctx, companyId);
  const threadPop = Boolean(threadInvoice) && (mail.attachments?.length ?? 0) > 0 && !["spam", "newsletter", "notification", "invoice_or_bill"].includes(category ?? "");
  if (looksLikePop(mail, open) || threadPop) {
    await receiveOnce(ctx, companyId, MAIL_RECEIVED_EVENT, `pop:${mail.key}`, async () => {
      const sender = await lookupSender(ctx, companyId, fromEmail);
      const match = choosePopInvoice({ threadInvoiceId: threadInvoice, text: mailText(mail), open, senderClients: sender.clients });
      const recorded = await recordPop(ctx, {
        companyId,
        invoiceId: match.invoiceId,
        source: "email",
        basis: match.basis,
        fromEmail: fromEmail || null,
        fromName: mail.from?.name ?? null,
        subject: mail.subject,
        snippet: mail.snippet,
        mailMessageId: mail.messageId,
        mailThreadId: mail.threadId,
        attachments: mail.attachments ?? [],
        receivedAt: mail.receivedAt,
        others: match.others,
      }, settings);
      return { popId: recorded.popId, invoiceId: match.invoiceId, basis: match.basis };
    });
    return;
  }
  if (category === "invoice_or_bill" && fromEmail) {
    const sender = await lookupSender(ctx, companyId, fromEmail);
    const supplier = sender.clients.find((c) => c.kind === "company" && c.name) ?? sender.clients.find((c) => c.kind === "contact") ?? sender.clients[0];
    if (!supplier) return; // unknown sender: leave it to a person in the Mailbox
    await receiveOnce(ctx, companyId, MAIL_RECEIVED_EVENT, `bill:${mail.key}`, async () => {
      const reference = BILL_NUMBER_RE.exec(`${mail.subject}\n${mail.snippet}`)?.[1] ?? null;
      const name = supplier.name || (await supplierName(ctx, companyId, supplier.kind, supplier.ref)) || fromEmail;
      const bill = await draftBillFromEmail(ctx, companyId, {
        supplier: { kind: supplier.kind as "company" | "contact", ref: supplier.ref, name },
        fromEmail,
        subject: mail.subject,
        messageId: mail.messageId,
        threadId: mail.threadId,
        receivedAt: mail.receivedAt || new Date().toISOString(),
        reference,
      }, settings);
      return { billId: bill.billId, created: bill.created };
    });
  }
}

async function supplierName(ctx: PluginContext, companyId: string, kind: string, ref: string): Promise<string | null> {
  const rows = await ctx.db.query<{ name: string }>(`SELECT name FROM ${table(ctx, kind === "company" ? "crm_companies" : "crm_contacts")} WHERE company_id = $1 AND id = $2`, [companyId, ref]);
  return rows[0]?.name ?? null;
}

// ── Accounting ─────────────────────────────────────────────────────────────

export async function onLedgerPostResult(ctx: PluginContext, event: PluginEvent): Promise<void> {
  await onLedgerResult(ctx, event.payload as LedgerPostResult);
}

export async function onBankMatchedEvent(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const companyId = event.companyId;
  if (!companyId) return;
  const settings = await billingSettings(ctx, companyId);
  const { closePops } = await onBankMatched(ctx, companyId, event.payload as BankMatched, settings);
  await closePopIssues(ctx, companyId, closePops);
}

// ── Issues a person finished ───────────────────────────────────────────────

async function claimDecisionIssue(ctx: PluginContext, issueId: string, status: "resolved" | "dismissed"): Promise<DecisionRow | null> {
  const rows = await ctx.db.query<DecisionRow>(
    `SELECT issue_id, company_id, kind, subject_kind, subject_id, payload, status FROM ${table(ctx, "decision_issues")} WHERE issue_id = $1`,
    [issueId],
  );
  const row = rows[0];
  if (!row || row.status !== "open") return null;
  const res = await ctx.db.execute(`UPDATE ${table(ctx, "decision_issues")} SET status = $2, resolved_at = now() WHERE issue_id = $1 AND status = 'open'`, [issueId, status]);
  return (res.rowCount ?? 0) > 0 ? row : null;
}

export async function onIssueUpdated(ctx: PluginContext, issueId: string | undefined, companyId: string, actorType?: string, actorId?: string): Promise<void> {
  if (!issueId || !companyId) return;
  const issue = await ctx.issues.get(issueId, companyId);
  if (!issue || (issue.status !== "done" && issue.status !== "cancelled")) return;
  // Only a person decides an approval. An agent (e.g. the Reviewer) closing it is undone and handed to the person.
  if (actorType === "agent") {
    const what = await openApprovalWhat(ctx, issue.id);
    if (what) {
      const settings = await billingSettings(ctx, companyId);
      const reopened = await reopenApprovalForPerson(ctx, { issueId: issue.id, companyId, userId: settings.reviewerUserId?.trim() || null, what });
      if (!reopened) ctx.logger.info("Could not hand the approval back to a person", { issueId: issue.id });
      return;
    }
  }
  const done = issue.status === "done";
  // The person who closed it (else its assignee): recorded on payments, credit notes and sends.
  const actor = actorType === "user" && actorId ? `user:${actorId}` : issue.assigneeUserId ? `user:${issue.assigneeUserId}` : "approval";

  const invoice = await invoiceByApproval(ctx, issue.id);
  if (invoice && invoice.pending_action) {
    const action = invoice.pending_action;
    const claim = await ctx.db.execute(
      `UPDATE ${table(ctx, "invoices")} SET pending_action = NULL, updated_at = now() WHERE id = $1 AND approval_issue_id = $2 AND pending_action = $3`,
      [invoice.id, issue.id, action],
    );
    if ((claim.rowCount ?? 0) === 0 || !done) return;
    if (action === "send") {
      if (invoice.status === "draft" && invoice.delivery_status !== "queued") await startInvoiceSend(ctx, invoice.id, actor);
      return;
    }
    if (action === "pay") {
      const balance = await invoiceBalance(ctx, invoice.id);
      if (balance && balance.outstandingMinor > 0) {
        const settled = await settle(ctx, {
          companyId: invoice.company_id,
          invoiceId: invoice.id,
          amountMinor: balance.outstandingMinor,
          sourceKey: `approval:${issue.id}`,
          source: "approval",
          method: "eft",
          reference: `Approved on issue ${issue.identifier ?? issue.id}`,
          createdBy: actor,
        }, await billingSettings(ctx, invoice.company_id));
        await closePopIssues(ctx, invoice.company_id, settled.confirmedPopIds);
      }
    }
    return;
  }

  const quote = await quoteByApproval(ctx, issue.id);
  if (quote && quote.pending_action) {
    const claim = await ctx.db.execute(
      `UPDATE ${table(ctx, "quotes")} SET pending_action = NULL, updated_at = now() WHERE id = $1 AND approval_issue_id = $2 AND pending_action = 'send'`,
      [quote.id, issue.id],
    );
    if ((claim.rowCount ?? 0) > 0 && done && quote.delivery_status !== "queued") await startQuoteSend(ctx, quote.id, actor);
    return;
  }

  const bill = await billByApproval(ctx, issue.id);
  if (bill && bill.pending_action === "approve") {
    const claim = await ctx.db.execute(
      `UPDATE ${table(ctx, "bills")} SET pending_action = NULL, updated_at = now() WHERE id = $1 AND approval_issue_id = $2 AND pending_action = 'approve'`,
      [bill.id, issue.id],
    );
    if ((claim.rowCount ?? 0) > 0 && done && bill.status === "draft") await approveBill(ctx, bill.company_id, bill.id);
    return;
  }

  const decision = await claimDecisionIssue(ctx, issue.id, done ? "resolved" : "dismissed");
  if (!decision) return;
  const settings: BillingSettings = await billingSettings(ctx, decision.company_id);
  if ((REQUEST_KINDS as readonly string[]).includes(decision.kind)) {
    try {
      const line = await applyDecision(ctx, decision, done, actor, issue);
      if (line) await comment(ctx, issue.id, decision.company_id, line);
    } catch (error) {
      ctx.logger.info("Billing decision not applied", { issueId: issue.id, kind: decision.kind, error: errorMessage(error) });
      await reopenDecision(ctx, decision, `This could not be applied: ${errorMessage(error)}. Fix it on the Billing page, then mark this issue done again, or cancel it.`);
    }
    return;
  }
  if (decision.kind === "pop") {
    const pop = await getPop(ctx, decision.subject_id);
    if (!pop || pop.status !== "pending") return;
    if (done) {
      try {
        await confirmPop(ctx, { companyId: decision.company_id, popId: pop.id, createdBy: actor }, settings);
      } catch (error) {
        ctx.logger.info("POP not confirmed from its issue", { popId: pop.id, error: errorMessage(error) });
        await reopenDecision(ctx, decision, `The payment could not be recorded: ${errorMessage(error)}. Use Money is in on the Billing page (Invoices → Payments) to pick the invoice or the amount, or cancel this issue.`);
      }
    } else {
      await rejectPop(ctx, { companyId: decision.company_id, popId: pop.id, reason: "Rejected on its verification issue", reviewedBy: actor });
    }
    return;
  }
  if (decision.kind === "bank_match") {
    const match = asObject(decision.payload) as unknown as BankMatched;
    if (done) {
      const settled = await settleBankMatch(ctx, decision.company_id, match, settings, actor);
      const result = { key: match.key, status: "settled" as const, paymentId: settled.paymentId };
      await ctx.db.execute(`UPDATE ${table(ctx, "inbox")} SET result = $2::jsonb WHERE key = $1`, [match.key, JSON.stringify(result)]);
      await emitBankMatchResult(ctx, decision.company_id, result);
      await closePopIssues(ctx, decision.company_id, settled.confirmedPopIds);
    } else {
      const result = { key: match.key, status: "rejected" as const, error: "A person rejected the match in Billing" };
      await ctx.db.execute(`UPDATE ${table(ctx, "inbox")} SET result = $2::jsonb WHERE key = $1`, [match.key, JSON.stringify(result)]);
      await emitBankMatchResult(ctx, decision.company_id, result);
    }
  }
}

/**
 * What the issue still gates (send, pay, bill approval, POP, bank match,
 * payment, credit note or reminder), in words for the reopen comment; null
 * when it gates nothing any more.
 */
async function openApprovalWhat(ctx: PluginContext, issueId: string): Promise<string | null> {
  const rows = await ctx.db.query<{ what: string; label: string | null; payload: unknown }>(
    `SELECT 'invoice_' || pending_action AS what, number AS label, NULL::jsonb AS payload FROM ${table(ctx, "invoices")} WHERE approval_issue_id = $1 AND pending_action IS NOT NULL
      UNION ALL SELECT 'quote_send' AS what, number AS label, NULL::jsonb AS payload FROM ${table(ctx, "quotes")} WHERE approval_issue_id = $1 AND pending_action IS NOT NULL
      UNION ALL SELECT 'bill_approve' AS what, supplier_name AS label, NULL::jsonb AS payload FROM ${table(ctx, "bills")} WHERE approval_issue_id = $1 AND pending_action IS NOT NULL
      UNION ALL SELECT 'decision_' || kind AS what, NULL AS label, payload FROM ${table(ctx, "decision_issues")} WHERE issue_id = $1 AND status = 'open'`,
    [issueId],
  );
  const row = rows[0];
  if (!row) return null;
  const number = String(asObject(row.payload).number ?? row.label ?? "");
  switch (row.what) {
    case "invoice_send": return `sending invoice ${number}`;
    case "invoice_pay": return `payment of invoice ${number}`;
    case "quote_send": return `sending quote ${number}`;
    case "bill_approve": return `the bill from ${number}`;
    case "decision_pop": return "a proof-of-payment check";
    case "decision_bank_match": return "a bank match";
    case "decision_payment": return `recording a payment on ${number}`;
    case "decision_credit_note": return `a credit note on ${number}`;
    case "decision_reminder": return `payment reminder ${Number(asObject(row.payload).stage ?? 0) + 1} for ${number}`;
    default: return "a Billing approval";
  }
}

async function comment(ctx: PluginContext, issueId: string, companyId: string, body: string): Promise<void> {
  try {
    await ctx.issues.createComment(issueId, body, companyId);
  } catch (error) {
    ctx.logger.info("Billing comment skipped", { issueId, error: errorMessage(error) });
  }
}

/** A person's decision could not be applied: keep it open, reopen the issue and say why. */
async function reopenDecision(ctx: PluginContext, decision: DecisionRow, why: string): Promise<void> {
  await ctx.db.execute(`UPDATE ${table(ctx, "decision_issues")} SET status = 'open', resolved_at = NULL WHERE issue_id = $1`, [decision.issue_id]);
  try {
    await ctx.issues.update(decision.issue_id, { status: "todo" }, decision.company_id);
  } catch (error) {
    ctx.logger.info("Could not reopen the Billing decision", { issueId: decision.issue_id, error: errorMessage(error) });
  }
  await comment(ctx, decision.issue_id, decision.company_id, why);
}
