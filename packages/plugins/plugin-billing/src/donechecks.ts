/**
 * Done checks: when an agent closes an issue Billing handed it, Billing looks
 * at the outcome in its own data (never Jev, never the network). Unfinished
 * work reopens the issue with what is missing (kit `registerDoneChecks`); a
 * person's close is never checked. Approvals and money decisions are a
 * person's, so they have no check.
 *
 * Each rule also passes when the work was finished another way: a draft
 * deleted or cancelled, an invoice paid, a quote answered, a note logged with
 * `log-follow-up` for what leaves no other trace (a reply drafted in the
 * Mailbox, what the owner decided).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { formatMoneyMinor, type DoneCheckIssue, type DoneCheckResult, type DoneCheckRule } from "@partnersinbiz/pib-plugin-kit";
import { getAcceptance } from "./accepted-store.js";
import { iso } from "./balances.js";
import { billingSettings } from "./config.js";
import { asObject, getInvoice, getQuote, table } from "./db.js";
import { draftsWaiting, overdueInvoices, type DraftItem, type OverdueItem } from "./followups.js";
import { notedSince } from "./notes.js";
import { originSubject, WORK_ORIGINS } from "./origins.js";
import { getBill } from "./settle.js";
import { getWorkIssue, workDetail, type WorkIssueRow } from "./workissues.js";

/** Lines shown in one reopen comment; the rest are counted. */
export const MISSING_LINES = 8;

const done: DoneCheckResult = { done: true };

function notDone(lines: string[]): DoneCheckResult {
  if (lines.length <= MISSING_LINES) return { done: false, missing: lines };
  const rest = lines.length - (MISSING_LINES - 1);
  return { done: false, missing: [...lines.slice(0, MISSING_LINES - 1), `…and ${rest} more like these (see the list in the issue).`] };
}

/** Work counts from when the issue was last opened (created or reopened), else when it was made. */
function sinceOf(row: WorkIssueRow | null, issue: DoneCheckIssue): string | null {
  return iso(row?.opened_at) ?? issue.createdAt ?? iso(row?.created_at) ?? null;
}

function nameOf(customer: unknown, fallback: string): string {
  const record = asObject(customer);
  return typeof record.name === "string" && record.name ? record.name : fallback;
}

// ── Drafts to send ─────────────────────────────────────────────────────────

export function draftLine(item: DraftItem): string {
  const money = formatMoneyMinor(item.totalMinor, item.currency);
  if (item.stage === "accepted") return `Quote ${item.number} for ${item.customerName} (${money}) was accepted but is not invoiced yet: \`convert-quote\` (quoteId \`${item.id}\`), then \`request-invoice-send\`.`;
  const hint = item.totalMinor <= 0 ? " (it has no lines yet)" : item.note.includes("turned the last send request down") ? " (a person turned the last one down: fix it, then ask again)" : "";
  return item.kind === "invoice"
    ? `Invoice draft for ${item.customerName} (${money}, invoiceId \`${item.id}\`) has no send request yet${hint}.`
    : `Quote ${item.number} for ${item.customerName} (${money}, quoteId \`${item.id}\`) has no send request yet${hint}.`;
}

/**
 * No draft over a day old is left without a send request (a deleted,
 * cancelled, sent or requested draft counts), and an accepted quote the issue
 * listed is invoiced with its invoice asked to send.
 */
export async function checkDraftsToSend(ctx: PluginContext, issue: DoneCheckIssue): Promise<DoneCheckResult> {
  const companyId = issue.companyId;
  const items = await draftsWaiting(ctx, companyId);
  const lines = items.map(draftLine);
  const seen = new Set(items.map((item) => item.id));
  const row = issue.originId ? await getWorkIssue(ctx, issue.originId) : null;
  const listed = (row?.fingerprint ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  if (listed.length) {
    // Accepted quotes the issue listed that were converted since: their invoice still needs its send request.
    const converted = await ctx.db.query<{ quote_number: string; id: string; total_minor: string | number; currency: string; customer: unknown; customer_ref: string }>(
      `SELECT q.number AS quote_number, i.id, i.total_minor, i.currency, i.customer, i.customer_ref
         FROM ${table(ctx, "quotes")} q JOIN ${table(ctx, "invoices")} i ON i.id = q.converted_invoice_id
        WHERE q.company_id = $1 AND q.id IN (SELECT jsonb_array_elements_text($2::jsonb))
          AND i.status = 'draft' AND i.pending_action IS NULL AND COALESCE(i.delivery_status, '') <> 'queued'`,
      [companyId, JSON.stringify(listed)],
    );
    for (const inv of converted) {
      if (seen.has(inv.id)) continue;
      lines.push(`Invoice drafted from quote ${inv.quote_number} for ${nameOf(inv.customer, inv.customer_ref)} (${formatMoneyMinor(Number(inv.total_minor), inv.currency)}, invoiceId \`${inv.id}\`) has no send request yet.`);
    }
  }
  return lines.length ? notDone(lines) : done;
}

// ── Overdue invoices ───────────────────────────────────────────────────────

/** Invoice ids an "Overdue invoices" issue listed (fingerprint `YYYY-MM-DD:<id>:<reminders>,…`); null when unknown. */
export function listedOverdue(fingerprint: string | null | undefined): Set<string> | null {
  const match = /^\d{4}-\d{2}-\d{2}:(.*)$/.exec(fingerprint ?? "");
  if (!match) return null;
  const ids = match[1]!.split(",").map((part) => part.slice(0, part.lastIndexOf(":") > 0 ? part.lastIndexOf(":") : part.length)).filter(Boolean);
  return new Set(ids);
}

export function overdueLine(item: OverdueItem): string {
  const next = item.needs === "reminder"
    ? `\`request-reminder-send\` (invoiceId \`${item.id}\`)`
    : `ask the owner (\`partnersinbiz.cockpit:ask-owner\`), then \`log-follow-up\` (invoiceId \`${item.id}\`) with what they decided`;
  return `${item.number} for ${item.customerName} (${formatMoneyMinor(item.outstandingMinor, item.currency)}, ${item.daysOverdue} days overdue) has no reminder request, payment check or note yet: ${next}.`;
}

/** Invoices (of these) with a step taken since `since`: a reminder asked for or sent, a payment check, a credit note asked for, or a note. */
export async function overdueHandled(ctx: PluginContext, companyId: string, invoiceIds: string[], since: string | null): Promise<Set<string>> {
  if (invoiceIds.length === 0) return new Set();
  const rows = await ctx.db.query<{ id: string }>(
    `SELECT i.id FROM ${table(ctx, "invoices")} i
      WHERE i.company_id = $1 AND i.id IN (SELECT jsonb_array_elements_text($2::jsonb))
        AND (
          EXISTS (SELECT 1 FROM ${table(ctx, "decision_issues")} d WHERE d.company_id = $1 AND d.subject_id = i.id AND d.kind IN ('reminder', 'payment', 'credit_note') AND (d.status = 'open' OR d.created_at >= $3::timestamptz))
          OR EXISTS (SELECT 1 FROM ${table(ctx, "pops")} p WHERE p.invoice_id = i.id AND (p.status = 'pending' OR p.created_at >= $3::timestamptz))
          OR EXISTS (SELECT 1 FROM ${table(ctx, "reminders")} r WHERE r.invoice_id = i.id AND r.status IN ('queued', 'sent') AND r.created_at >= $3::timestamptz)
          OR EXISTS (SELECT 1 FROM ${table(ctx, "follow_ups")} f WHERE f.company_id = $1 AND f.subject_kind = 'invoice' AND f.subject_id = i.id AND f.created_at >= $3::timestamptz)
        )`,
    [companyId, JSON.stringify(invoiceIds), since ?? "epoch"],
  );
  return new Set(rows.map((row) => row.id));
}

/**
 * Each overdue invoice the issue listed that needs a step from the agent has
 * one since the issue was opened: a reminder request (or a reminder sent), a
 * payment check, a credit-note request or a follow-up note. Paid, credited or
 * written-off invoices drop off; so do invoices with nothing due from the
 * agent (a proof being checked, automatic reminders, the next one not due).
 */
export async function checkOverdueInvoices(ctx: PluginContext, issue: DoneCheckIssue, now = new Date()): Promise<DoneCheckResult> {
  const companyId = issue.companyId;
  const items = (await overdueInvoices(ctx, companyId, await billingSettings(ctx, companyId), now)).filter((item) => item.needs != null);
  if (items.length === 0) return done;
  const row = issue.originId ? await getWorkIssue(ctx, issue.originId) : null;
  const listed = listedOverdue(row?.fingerprint);
  const todo = listed ? items.filter((item) => listed.has(item.id)) : items;
  if (todo.length === 0) return done;
  const handled = await overdueHandled(ctx, companyId, todo.map((item) => item.id), sinceOf(row, issue));
  const lines = todo.filter((item) => !handled.has(item.id)).map(overdueLine);
  return lines.length ? notDone(lines) : done;
}

// ── Quote reply ────────────────────────────────────────────────────────────

/**
 * The customer's reply is dealt with: the quote's status changed since the
 * reply (accepted, declined, converted, expired), a new quote for the same
 * deal was drafted, or a note was logged on the quote (the answer drafted in
 * the Mailbox, what the owner decided).
 */
export async function checkQuoteReply(ctx: PluginContext, issue: DoneCheckIssue): Promise<DoneCheckResult> {
  const quoteId = originSubject(issue.originId, WORK_ORIGINS.quoteReply);
  const quote = quoteId ? await getQuote(ctx, quoteId) : null;
  if (!quote || quote.company_id !== issue.companyId) return done;
  const row = await getWorkIssue(ctx, issue.originId!);
  const before = workDetail(row).quoteStatus;
  const changed = typeof before === "string" && before ? quote.status !== before : !["draft", "sent"].includes(quote.status);
  if (changed) return done;
  const since = sinceOf(row, issue);
  if (quote.deal_id) {
    const newer = await ctx.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table(ctx, "quotes")} WHERE company_id = $1 AND deal_id = $2 AND id <> $3 AND created_at >= $4::timestamptz`,
      [issue.companyId, quote.deal_id, quote.id, since ?? "epoch"],
    );
    if (Number(newer[0]?.n ?? 0) > 0) return done;
  }
  if ((await notedSince(ctx, issue.companyId, "quote", [quote.id], since)).size > 0) return done;
  const name = nameOf(quote.customer, quote.customer_ref);
  return notDone([
    `Quote ${quote.number} for ${name} is still ${quote.status}: record their answer with \`set-quote-status\`, or draft the reply in the Mailbox and log it with \`log-follow-up\` (quoteId \`${quote.id}\`, mailDraftId).`,
  ]);
}

// ── Deal won ───────────────────────────────────────────────────────────────

/**
 * Something was drafted for the won deal since the issue opened: a quote or
 * invoice for the deal or its client, or a retainer for the client; or the
 * deal's invoice is asked to send (or sent); or a note on the deal says why
 * nothing is billed.
 */
export async function checkDealWon(ctx: PluginContext, issue: DoneCheckIssue): Promise<DoneCheckResult> {
  const dealId = originSubject(issue.originId, WORK_ORIGINS.dealWon);
  if (!dealId) return done;
  const row = await getWorkIssue(ctx, issue.originId!);
  const detail = workDetail(row);
  const clientKind = detail.clientKind === "contact" ? "contact" : detail.clientKind === "company" ? "company" : null;
  const clientRef = typeof detail.clientRef === "string" && detail.clientRef ? detail.clientRef : null;
  const since = sinceOf(row, issue) ?? "epoch";
  const rows = await ctx.db.query<{ n: string }>(
    `SELECT ((SELECT count(*) FROM ${table(ctx, "quotes")} q WHERE q.company_id = $1 AND q.created_at >= $2::timestamptz AND (q.deal_id = $3 OR (q.customer_kind = $4 AND q.customer_ref = $5)))
           + (SELECT count(*) FROM ${table(ctx, "invoices")} i WHERE i.company_id = $1 AND i.status <> 'cancelled' AND i.created_at >= $2::timestamptz AND (i.deal_id = $3 OR (i.customer_kind = $4 AND i.customer_ref = $5)))
           + (SELECT count(*) FROM ${table(ctx, "subscriptions")} s WHERE s.company_id = $1 AND s.created_at >= $2::timestamptz AND s.customer_kind = $4 AND s.customer_ref = $5)
           + (SELECT count(*) FROM ${table(ctx, "invoices")} i WHERE i.company_id = $1 AND i.deal_id = $3 AND (i.pending_action = 'send' OR i.status NOT IN ('draft', 'cancelled')))
           + (SELECT count(*) FROM ${table(ctx, "follow_ups")} f WHERE f.company_id = $1 AND f.subject_kind = 'deal' AND f.subject_id = $3 AND f.created_at >= $2::timestamptz))::text AS n`,
    [issue.companyId, since, dealId, clientKind ?? "", clientRef ?? ""],
  );
  if (Number(rows[0]?.n ?? 0) > 0) return done;
  const title = typeof detail.title === "string" && detail.title ? `"${detail.title}"` : dealId;
  const client = clientRef ? ` (\`${clientKind}:${clientRef}\`)` : "";
  return notDone([
    `Nothing is drafted for deal ${title}${client} since this issue opened: no quote, invoice or retainer (pass dealId \`${dealId}\`). If it is not billed, say why with \`log-follow-up\` (dealId \`${dealId}\`).`,
  ]);
}

// ── A client signed (CRM e-sign) ───────────────────────────────────────────

/**
 * The invoice Billing drafted from a signed document is asked to send (or already sent, paid, cancelled or erased), or a note
 * says why it will not be; or, when Billing found a difference and drafted nothing, an invoice now exists for the quote or deal,
 * or a note on the quote, deal or invoice says why none will be made. A note counts when it was made since the issue opened.
 */
export async function checkSignedDocument(ctx: PluginContext, issue: DoneCheckIssue): Promise<DoneCheckResult> {
  const documentId = originSubject(issue.originId, WORK_ORIGINS.signed);
  const acceptance = documentId ? await getAcceptance(ctx, issue.companyId, documentId) : null;
  if (!acceptance) return done;
  const row = await getWorkIssue(ctx, issue.originId!);
  const since = sinceOf(row, issue);
  if (acceptance.status === "drafted" && acceptance.invoice_id) {
    const invoice = await getInvoice(ctx, acceptance.invoice_id);
    // An invoice that is gone (erased) or no longer a draft needs nothing more from the agent.
    if (!invoice || invoice.company_id !== issue.companyId || invoice.status !== "draft" || invoice.pending_action === "send" || invoice.delivery_status === "queued") return done;
    if ((await notedSince(ctx, issue.companyId, "invoice", [invoice.id], since)).size > 0) return done;
    return notDone([
      `Invoice ${invoice.number} (${formatMoneyMinor(Number(invoice.total_minor), invoice.currency)}, invoiceId \`${invoice.id}\`), drafted from the document the client signed, has no send request yet: check it with \`invoice-detail\`, then \`request-invoice-send\`. If it must not go out, say why with \`log-follow-up\` (invoiceId, note).`,
    ]);
  }
  if (acceptance.status !== "needs_attention") return done;
  const made = await ctx.db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${table(ctx, "invoices")} i
      WHERE i.company_id = $1 AND i.status <> 'cancelled' AND ((i.quote_id IS NOT NULL AND i.quote_id = $2) OR (i.deal_id IS NOT NULL AND i.deal_id = $3))`,
    [issue.companyId, acceptance.quote_id ?? "", acceptance.deal_id ?? ""],
  );
  if (Number(made[0]?.n ?? 0) > 0) return done;
  if (acceptance.quote_id && (await notedSince(ctx, issue.companyId, "quote", [acceptance.quote_id], since)).size > 0) return done;
  if (acceptance.deal_id && (await notedSince(ctx, issue.companyId, "deal", [acceptance.deal_id], since)).size > 0) return done;
  const where = [acceptance.quote_id ? `quoteId \`${acceptance.quote_id}\`` : null, acceptance.deal_id ? `dealId \`${acceptance.deal_id}\`` : null].filter(Boolean).join(" or ");
  return notDone([
    `No invoice was drafted for the signed document \`${acceptance.document_id}\` and none exists yet for ${where || "it"}: sort out the difference this issue lists, then \`convert-quote\` or draft the invoice and \`request-invoice-send\`. If nothing will be invoiced, say why with \`log-follow-up\`${where ? ` (${where}, note)` : ""}.`,
  ]);
}

// ── Complete the bill from an email ────────────────────────────────────────

/** The drafted bill has its lines and an approval request, or is no longer a draft, or a note says it is not a bill. */
export async function checkBillFromEmail(ctx: PluginContext, issue: DoneCheckIssue): Promise<DoneCheckResult> {
  const billId = originSubject(issue.originId, WORK_ORIGINS.billFromEmail);
  const bill = billId ? await getBill(ctx, billId) : null;
  if (!bill || bill.company_id !== issue.companyId || bill.status !== "draft" || bill.pending_action === "approve") return done;
  if ((await notedSince(ctx, issue.companyId, "bill", [bill.id], issue.createdAt)).size > 0) return done;
  const lines = await ctx.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table(ctx, "bill_lines")} WHERE bill_id = $1`, [bill.id]);
  const notBill = `Not a bill? Say so with \`log-follow-up\` (billId \`${bill.id}\`).`;
  return notDone([
    Number(lines[0]?.n ?? 0) === 0
      ? `The bill from ${bill.supplier_name} (billId \`${bill.id}\`) has no lines yet: \`add-bill-line\` for each line on the supplier's invoice, then \`request-bill-approval\`. ${notBill}`
      : `The bill from ${bill.supplier_name} (billId \`${bill.id}\`) has its lines but no approval request: \`request-bill-approval\`. ${notBill}`,
  ]);
}

/** Every kind of work Billing hands to agents, matched by origin id prefix. */
export const BILLING_DONE_CHECKS: DoneCheckRule[] = [
  { originPrefix: WORK_ORIGINS.drafts, label: "Drafts to send", check: (issue, ctx) => checkDraftsToSend(ctx, issue) },
  { originPrefix: WORK_ORIGINS.overdue, label: "Overdue invoices", check: (issue, ctx) => checkOverdueInvoices(ctx, issue) },
  { originPrefix: WORK_ORIGINS.quoteReply, label: "Quote reply", check: (issue, ctx) => checkQuoteReply(ctx, issue) },
  { originPrefix: WORK_ORIGINS.dealWon, label: "Deal won", check: (issue, ctx) => checkDealWon(ctx, issue) },
  { originPrefix: WORK_ORIGINS.billFromEmail, label: "Complete the bill", check: (issue, ctx) => checkBillFromEmail(ctx, issue) },
  { originPrefix: WORK_ORIGINS.signed, label: "Signed document", check: (issue, ctx) => checkSignedDocument(ctx, issue) },
];
