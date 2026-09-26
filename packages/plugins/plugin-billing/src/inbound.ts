/**
 * Events from other plugins and from Paperclip issues:
 * - Mailbox `mail.send.result` → delivery recorded, invoice marked sent.
 * - Mailbox `mail.received` → proof of payment or a supplier's bill.
 * - Accounting `ledger.post.result` → journal number on the document.
 * - Accounting `bank.matched` → settle or ask a person.
 * - `issue.updated` → approvals and verification issues a person finished.
 */
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import {
  MAIL_EVENTS,
  PIB_PLUGINS,
  receiveOnce,
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
import { markInvoiceSent, startInvoiceSend, startQuoteSend } from "./invoices.js";
import { parseMailKey, settleMailResult } from "./mail.js";
import { onLedgerResult } from "./posting.js";
import { choosePopInvoice, confirmPop, getPop, lookupSender, looksLikePop, mailText, openInvoiceCandidates, recordPop, rejectPop, threadInvoiceId } from "./pop.js";
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

async function closeIssue(ctx: PluginContext, companyId: string, issueId: string): Promise<void> {
  await ctx.db.execute(`UPDATE ${table(ctx, "decision_issues")} SET status = 'resolved', resolved_at = now() WHERE issue_id = $1 AND status = 'open'`, [issueId]);
  try {
    await ctx.issues.update(issueId, { status: "done" }, companyId);
  } catch (error) {
    ctx.logger.info("Could not close the verification issue", { issueId, error: errorMessage(error) });
  }
}

export async function onBankMatchedEvent(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const companyId = event.companyId;
  if (!companyId) return;
  const settings = await billingSettings(ctx, companyId);
  const { closePops } = await onBankMatched(ctx, companyId, event.payload as BankMatched, settings);
  for (const popId of closePops) {
    const pop = await getPop(ctx, popId);
    if (pop?.issue_id) await closeIssue(ctx, companyId, pop.issue_id);
  }
}

// ── Issues a person finished ───────────────────────────────────────────────

async function claimDecisionIssue(ctx: PluginContext, issueId: string, status: "resolved" | "dismissed") {
  const rows = await ctx.db.query<{ issue_id: string; company_id: string; kind: string; subject_kind: string; subject_id: string; payload: unknown; status: string }>(
    `SELECT issue_id, company_id, kind, subject_kind, subject_id, payload, status FROM ${table(ctx, "decision_issues")} WHERE issue_id = $1`,
    [issueId],
  );
  const row = rows[0];
  if (!row || row.status !== "open") return null;
  const res = await ctx.db.execute(`UPDATE ${table(ctx, "decision_issues")} SET status = $2, resolved_at = now() WHERE issue_id = $1 AND status = 'open'`, [issueId, status]);
  return (res.rowCount ?? 0) > 0 ? row : null;
}

export async function onIssueUpdated(ctx: PluginContext, issueId: string | undefined, companyId: string): Promise<void> {
  if (!issueId || !companyId) return;
  const issue = await ctx.issues.get(issueId, companyId);
  if (!issue || (issue.status !== "done" && issue.status !== "cancelled")) return;
  const done = issue.status === "done";
  const actor = issue.assigneeUserId ? `user:${issue.assigneeUserId}` : "approval";

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
        for (const popId of settled.confirmedPopIds) {
          const pop = await getPop(ctx, popId);
          if (pop?.issue_id) await closeIssue(ctx, invoice.company_id, pop.issue_id);
        }
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
  if (decision.kind === "pop") {
    const pop = await getPop(ctx, decision.subject_id);
    if (!pop || pop.status !== "pending") return;
    if (done) {
      try {
        await confirmPop(ctx, { companyId: decision.company_id, popId: pop.id, createdBy: actor }, settings);
      } catch (error) {
        ctx.logger.info("POP not confirmed from its issue", { popId: pop.id, error: errorMessage(error) });
        await ctx.db.execute(`UPDATE ${table(ctx, "decision_issues")} SET status = 'open', resolved_at = NULL WHERE issue_id = $1`, [issue.id]);
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
      for (const popId of settled.confirmedPopIds) {
        const pop = await getPop(ctx, popId);
        if (pop?.issue_id) await closeIssue(ctx, decision.company_id, pop.issue_id);
      }
    } else {
      const result = { key: match.key, status: "rejected" as const, error: "A person rejected the match in Billing" };
      await ctx.db.execute(`UPDATE ${table(ctx, "inbox")} SET result = $2::jsonb WHERE key = $1`, [match.key, JSON.stringify(result)]);
      await emitBankMatchResult(ctx, decision.company_id, result);
    }
  }
}
