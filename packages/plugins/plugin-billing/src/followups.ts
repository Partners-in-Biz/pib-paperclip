/**
 * Nothing sits silently: Billing's standing issues for the Account Manager
 * (else the Bookkeeper, the Operator, the owner).
 *
 * - "Drafts to send" (daily): invoices and quotes drafted over a day ago that
 *   nobody asked to send, including recurring and retainer drafts.
 * - "Overdue invoices" (weekly, kept current daily): what is overdue and the
 *   next step for each.
 * - A quote reply (from the Mailbox): one issue per quote with the reply.
 * - A won deal (CRM `deal.won`): one drafting issue per deal.
 *
 * Each issue's origin id is `billing:<kind>:<id>` (`WORK_ORIGINS`); when an
 * agent closes one, its done check (`donechecks.ts`) looks at the outcome.
 */
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { formatMoneyMinor, HANDOFF_EVENTS, PIB_PLUGINS, pluginEvent, receiveOnce, type DealWon, type MailReceived } from "@partnersinbiz/pib-plugin-kit";
import { invoiceBalances, iso } from "./balances.js";
import { billingSettings, dunningStages, type BillingSettings } from "./config.js";
import { asObject, getQuote, table } from "./db.js";
import { daysPastDue } from "./domain.js";
import { optedOutClients, requestStage, sentStages } from "./dunning.js";
import { WORK_ORIGINS } from "./origins.js";
import { billingPath, companyPrefix, pagePath, quoteRoute, workRoute } from "./routing.js";
import { billingOn } from "./setup.js";
import { closeStandingIssue, getWorkIssue, upsertStandingIssue } from "./workissues.js";

export const DEAL_WON_EVENT = pluginEvent(PIB_PLUGINS.crm, HANDOFF_EVENTS.dealWon);

/** A draft counts as waiting once it is this old. */
export const DRAFT_AGE_HOURS = 24;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function nameOf(customer: unknown, fallback: string): string {
  const record = asObject(customer);
  return typeof record.name === "string" && record.name ? record.name : fallback;
}

function clientRef(kind: string, ref: string): string {
  return `${kind === "contact" ? "contact" : "company"}:${ref}`;
}

function ago(at: string | null, now: Date): string {
  if (!at) return "";
  const days = Math.floor((now.getTime() - Date.parse(at)) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
}

/** Table cells never break the Markdown table. */
function cell(value: string): string {
  return value.replace(/\|/g, "/").replace(/\s+/g, " ").trim();
}

// ── Drafts to send ─────────────────────────────────────────────────────────

export interface DraftItem {
  kind: "invoice" | "quote";
  /** draft: nobody asked to send it; accepted: an accepted quote not turned into an invoice yet. */
  stage: "draft" | "accepted";
  id: string;
  number: string;
  customerName: string;
  client: string;
  totalMinor: number;
  currency: string;
  createdAt: string | null;
  note: string;
}

/** Invoices and quotes drafted over a day ago with no send approval open. */
export async function draftsWaiting(ctx: PluginContext, companyId: string, olderThanHours = DRAFT_AGE_HOURS): Promise<DraftItem[]> {
  const invoices = await ctx.db.query<{ id: string; number: string; customer: unknown; customer_kind: string; customer_ref: string; total_minor: string | number; currency: string; created_at: unknown; recurring_id: string | null; subscription_id: string | null; quote_id: string | null; deal_id: string | null; approval_issue_id: string | null }>(
    `SELECT i.id, i.number, i.customer, i.customer_kind, i.customer_ref, i.total_minor, i.currency, i.created_at, i.recurring_id, i.subscription_id, i.quote_id, i.deal_id, i.approval_issue_id
       FROM ${table(ctx, "invoices")} i
      WHERE i.company_id = $1 AND i.status = 'draft' AND i.pending_action IS NULL AND COALESCE(i.delivery_status, '') <> 'queued'
        AND i.created_at < now() - ($2 || ' hours')::interval
        AND NOT EXISTS (SELECT 1 FROM ${table(ctx, "recurring_invoices")} r WHERE r.template_invoice_id = i.id AND r.is_active = true)
      ORDER BY i.created_at LIMIT 100`,
    [companyId, String(olderThanHours)],
  );
  const quotes = await ctx.db.query<{ id: string; number: string; customer: unknown; customer_kind: string; customer_ref: string; total_minor: string | number; currency: string; created_at: unknown; deal_id: string | null; approval_issue_id: string | null }>(
    `SELECT q.id, q.number, q.customer, q.customer_kind, q.customer_ref, q.total_minor, q.currency, q.created_at, q.deal_id, q.approval_issue_id
       FROM ${table(ctx, "quotes")} q
      WHERE q.company_id = $1 AND q.status = 'draft' AND q.pending_action IS NULL AND COALESCE(q.delivery_status, '') <> 'queued'
        AND q.created_at < now() - ($2 || ' hours')::interval
      ORDER BY q.created_at LIMIT 100`,
    [companyId, String(olderThanHours)],
  );
  // Accepted quotes nobody turned into an invoice yet.
  const accepted = await ctx.db.query<{ id: string; number: string; customer: unknown; customer_kind: string; customer_ref: string; total_minor: string | number; currency: string; created_at: unknown; deal_id: string | null }>(
    `SELECT q.id, q.number, q.customer, q.customer_kind, q.customer_ref, q.total_minor, q.currency, q.created_at, q.deal_id
       FROM ${table(ctx, "quotes")} q
      WHERE q.company_id = $1 AND q.status = 'accepted' AND q.converted_invoice_id IS NULL
        AND COALESCE(q.accepted_at, q.updated_at) < now() - ($2 || ' hours')::interval
      ORDER BY q.created_at LIMIT 100`,
    [companyId, String(olderThanHours)],
  );
  const notes = (row: { total_minor: string | number; approval_issue_id: string | null; deal_id: string | null }, extra: string[]) => [
    ...extra,
    Number(row.total_minor) <= 0 ? "no lines yet" : null,
    row.approval_issue_id ? "a person turned the last send request down: fix it, then ask again" : null,
    row.deal_id ? `deal ${row.deal_id}` : null,
  ].filter(Boolean).join("; ");
  return [
    ...invoices.map((row) => ({
      kind: "invoice" as const,
      stage: "draft" as const,
      id: row.id,
      number: row.number,
      customerName: nameOf(row.customer, row.customer_ref),
      client: clientRef(row.customer_kind, row.customer_ref),
      totalMinor: Number(row.total_minor),
      currency: row.currency,
      createdAt: iso(row.created_at),
      note: notes(row, [row.subscription_id ? "retainer" : row.recurring_id ? "recurring" : row.quote_id ? "from a quote" : ""].filter(Boolean)),
    })),
    ...quotes.map((row) => ({
      kind: "quote" as const,
      stage: "draft" as const,
      id: row.id,
      number: row.number,
      customerName: nameOf(row.customer, row.customer_ref),
      client: clientRef(row.customer_kind, row.customer_ref),
      totalMinor: Number(row.total_minor),
      currency: row.currency,
      createdAt: iso(row.created_at),
      note: notes(row, []),
    })),
    ...accepted.map((row) => ({
      kind: "quote" as const,
      stage: "accepted" as const,
      id: row.id,
      number: row.number,
      customerName: nameOf(row.customer, row.customer_ref),
      client: clientRef(row.customer_kind, row.customer_ref),
      totalMinor: Number(row.total_minor),
      currency: row.currency,
      createdAt: iso(row.created_at),
      note: notes({ total_minor: row.total_minor, approval_issue_id: null, deal_id: row.deal_id }, ["accepted: `convert-quote`, then `request-invoice-send`"]),
    })),
  ];
}

export function draftsDigest(items: DraftItem[], prefix: string | null, now = new Date()): { title: string; description: string } {
  const invoices = items.filter((i) => i.kind === "invoice").length;
  const quotes = items.length - invoices;
  const parts = [invoices ? plural(invoices, "invoice") : null, quotes ? plural(quotes, "quote") : null].filter(Boolean).join(" and ");
  const rows = items.map((item) =>
    `| ${item.kind === "invoice" ? "Invoice" : "Quote"} ${cell(item.number)} (\`${item.id}\`) | ${cell(item.customerName)} (\`${item.client}\`) | ${formatMoneyMinor(item.totalMinor, item.currency)} | ${ago(item.createdAt, now)} | ${cell(item.note || "—")} |`);
  const description = [
    `${parts} drafted over a day ago and nobody has asked to send ${items.length === 1 ? "it" : "them"}. For each one:`,
    "1. Check it with `partnersinbiz.billing:invoice-detail` or `quote-detail`: customer, lines, VAT codes, due or valid-until date.",
    "2. If it is right, ask for approval with `request-invoice-send` or `request-quote-send`. A person approves; Billing emails it.",
    "3. If it is wrong, fix it (`update-line`, `add-line`, `remove-line`, `update-invoice`; quotes: `add-quote-line`, `remove-quote-line`, `update-quote`), then ask to send.",
    "4. An accepted quote: `convert-quote` turns it into a draft invoice; check that and `request-invoice-send`.",
    "5. If it should not go out at all, ask the owner with `partnersinbiz.cockpit:ask-owner` to cancel it (only a person cancels).",
    "",
    "| Draft | Client | Amount | Made | Note |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    `Billing: ${billingPath(prefix, { tab: "invoices" })} · Quotes: ${billingPath(prefix, { tab: "quotes" })}`,
    "This issue is updated every morning and closes itself when nothing is waiting. Mark it done when every draft above has a send request (or is cancelled); Billing checks that when you close it, and it reopens when new drafts wait. If only a person can finish one (the owner must cancel it), leave this issue blocked and say who must do what.",
  ].join("\n");
  return { title: `Drafts to send: ${parts} waiting`, description };
}

export const draftsKey = (companyId: string) => `${WORK_ORIGINS.drafts}${companyId}`;
export const overdueKey = (companyId: string) => `${WORK_ORIGINS.overdue}${companyId}`;
export const quoteReplyKey = (quoteId: string) => `${WORK_ORIGINS.quoteReply}${quoteId}`;
export const dealWonKey = (dealId: string) => `${WORK_ORIGINS.dealWon}${dealId}`;

/** Daily: open, update, reopen or close the company's "Drafts to send" issue. */
export async function syncDraftsDigest(ctx: PluginContext, companyId: string, now = new Date()): Promise<{ items: number; issueId: string | null }> {
  const items = await draftsWaiting(ctx, companyId);
  const key = draftsKey(companyId);
  if (items.length === 0) {
    await closeStandingIssue(ctx, key, companyId, "Nothing is waiting: every draft is sent, waiting for approval or cancelled.");
    return { items: 0, issueId: null };
  }
  const previous = new Set(((await getWorkIssue(ctx, key))?.fingerprint ?? "").split(",").filter(Boolean));
  const ids = items.map((i) => i.id).sort();
  const added = items.filter((i) => !previous.has(i.id));
  const { title, description } = draftsDigest(items, await companyPrefix(ctx, companyId), now);
  const result = await upsertStandingIssue(ctx, {
    key,
    companyId,
    kind: "drafts",
    title,
    description,
    fingerprint: ids.join(","),
    route: await workRoute(ctx, companyId),
    wake: added.length > 0,
    comment: added.length ? `New drafts waiting: ${added.map((i) => i.number).join(", ")}.` : "Drafts are still waiting to be sent.",
    wakeReason: "Drafts waiting to be sent",
  });
  return { items: items.length, issueId: result.issueId };
}

// ── Overdue invoices ───────────────────────────────────────────────────────

export interface OverdueItem {
  id: string;
  number: string;
  customerName: string;
  client: string;
  outstandingMinor: number;
  currency: string;
  dueAt: string | null;
  daysOverdue: number;
  remindersSent: number;
  step: string;
  /**
   * What the agent must do now: ask for the due reminder, or ask the owner
   * (opted out, every reminder sent, over 60 days). Null when nothing is due
   * from the agent (a proof of payment is being checked, reminders go out by
   * themselves, or the next one is not due yet).
   */
  needs: "reminder" | "owner" | null;
}

export async function overdueInvoices(ctx: PluginContext, companyId: string, settings: BillingSettings, now = new Date()): Promise<OverdueItem[]> {
  const open = await invoiceBalances(ctx, companyId, { openOnly: true });
  const sent = await sentStages(ctx, companyId);
  const optedOut = await optedOutClients(ctx, companyId);
  const stages = dunningStages(settings);
  const automatic = settings.dunning?.enabled === true;
  const items: OverdueItem[] = [];
  for (const b of open) {
    const dueAt = iso(b.invoice.due_at);
    if (b.outstandingMinor <= 0 || !dueAt || Date.parse(dueAt) >= now.getTime()) continue;
    const days = daysPastDue(dueAt, now);
    const done = sent.get(b.invoice.id) ?? [];
    const pick = requestStage(stages, days, done);
    let step: string;
    let needs: OverdueItem["needs"] = null;
    if (b.invoice.status === "payment_pending_verification") step = "Wait: a person is checking a proof of payment";
    else if (optedOut.has(`${b.invoice.customer_kind}:${b.invoice.customer_ref}`)) {
      step = "No reminders (opted out): ask the owner how to chase";
      needs = "owner";
    } else if (pick.stage != null) {
      step = automatic ? `Reminder ${pick.stage + 1} goes out automatically` : `\`request-reminder-send\` (reminder ${pick.stage + 1} is due)`;
      if (!automatic) needs = "reminder";
    } else if (pick.reason === "all_sent") {
      step = "All reminders sent: ask the owner (call, payment plan or write-off)";
      needs = "owner";
    } else step = `Reminder ${pick.nextStage + 1} is due in ${plural(pick.dueInDays, "day")}${automatic ? " (automatic)" : ""}`;
    if (days > 60 && !step.startsWith("Wait")) {
      step = `${step}; over 60 days: ask the owner`;
      needs ??= "owner";
    }
    items.push({
      id: b.invoice.id,
      number: b.invoice.number,
      customerName: nameOf(b.invoice.customer_snapshot ?? b.invoice.customer, b.invoice.customer_ref),
      client: clientRef(b.invoice.customer_kind, b.invoice.customer_ref),
      outstandingMinor: b.outstandingMinor,
      currency: b.invoice.currency,
      dueAt,
      daysOverdue: days,
      remindersSent: new Set(done).size,
      step,
      needs,
    });
  }
  return items.sort((a, b) => b.daysOverdue - a.daysOverdue);
}

function sumsText(items: Array<{ outstandingMinor: number; currency: string }>): string {
  const sums = new Map<string, number>();
  for (const item of items) sums.set(item.currency, (sums.get(item.currency) ?? 0) + item.outstandingMinor);
  return [...sums.entries()].map(([currency, minor]) => formatMoneyMinor(minor, currency)).join(" + ");
}

export function overdueDigest(items: OverdueItem[], settings: BillingSettings, prefix: string | null, now = new Date()): { title: string; description: string } {
  const automatic = settings.dunning?.enabled === true;
  const stages = dunningStages(settings).length;
  const total = sumsText(items);
  const rows = items.map((item) =>
    `| ${cell(item.number)} (\`${item.id}\`) | ${cell(item.customerName)} (\`${item.client}\`) | ${formatMoneyMinor(item.outstandingMinor, item.currency)} | ${item.daysOverdue} | ${item.remindersSent} of ${stages} | ${cell(item.step)} |`);
  const description = [
    `${plural(items.length, "invoice is", "invoices are")} overdue: ${total} (as of ${now.toISOString().slice(0, 10)}).`,
    "",
    "What to do for each:",
    automatic
      ? "- Payment reminders are on: Billing emails each stage by itself every morning. Don't ask for them."
      : "- Ask for the next payment reminder with `partnersinbiz.billing:request-reminder-send` (invoiceId). A person approves each email; Billing sends it from the Mailbox.",
    "- The customer says they paid, or sent proof (email, WhatsApp, a call): `request-payment-check` with what they said. Never mark an invoice paid yourself.",
    "- The customer replied with a question or a problem: answer with a Mailbox draft (`partnersinbiz.mailbox:create-draft`); a person sends it.",
    "- All reminders sent, or over 60 days: ask the owner with `partnersinbiz.cockpit:ask-owner` (call them, agree a payment plan, a credit note or a write-off). Credit notes go through `create-credit-note` (a person approves); only a person writes off.",
    "- Anything that leaves no other trace in Billing (what you asked the owner, what they decided, a promise to pay, a reply you drafted): log it on the invoice with `partnersinbiz.billing:log-follow-up` (invoiceId, note).",
    "",
    "| Invoice | Client | Owed | Days overdue | Reminders | Next step |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    `Overdue list: ${billingPath(prefix, { tab: "invoices" })} · Reminders: ${billingPath(prefix, { tab: "reminders" })}`,
    "Updated every Monday (and kept current daily); it closes itself when nothing is overdue. Mark it done when every invoice above that needs a step has one: a reminder request, a payment check, a follow-up note, or it is paid. Billing checks that when you close it.",
  ].join("\n");
  return { title: `Overdue invoices: ${items.length} (${total})`, description };
}

/**
 * Weekly (`weekly: true`): open or update the issue and wake the agent.
 * Daily: keep an open issue current (no wake) and close it when nothing is overdue.
 */
export async function syncOverdueDigest(ctx: PluginContext, companyId: string, options: { weekly: boolean; now?: Date } = { weekly: true }): Promise<{ items: number; issueId: string | null }> {
  const now = options.now ?? new Date();
  const settings = await billingSettings(ctx, companyId);
  const items = await overdueInvoices(ctx, companyId, settings, now);
  const key = overdueKey(companyId);
  if (items.length === 0) {
    await closeStandingIssue(ctx, key, companyId, "Nothing is overdue any more.");
    return { items: 0, issueId: null };
  }
  const row = await getWorkIssue(ctx, key);
  if (!options.weekly && row?.status !== "open") return { items: items.length, issueId: null };
  const { title, description } = overdueDigest(items, settings, await companyPrefix(ctx, companyId), now);
  const result = await upsertStandingIssue(ctx, {
    key,
    companyId,
    kind: "overdue",
    title,
    description,
    fingerprint: `${now.toISOString().slice(0, 10)}:${items.map((i) => `${i.id}:${i.remindersSent}`).sort().join(",")}`,
    route: await workRoute(ctx, companyId),
    wake: options.weekly,
    comment: options.weekly ? `This week: ${plural(items.length, "overdue invoice")} (${sumsText(items)}). Work through the next steps.` : null,
    wakeReason: "Weekly overdue invoices",
    // Daily runs only keep an open issue current; the weekly run reopens it.
    reopen: options.weekly,
  });
  return { items: items.length, issueId: result.issueId };
}

// ── Quote replies ──────────────────────────────────────────────────────────

const QUOTE_NUMBER_RE = /\b(Q-[A-Za-z0-9]{2,6}-\d{1,8}|QTE-\d{1,8})\b/gi;

/** The quote a message answers: the Mailbox's reply context, else a quote number in the subject of a sent quote. */
export async function quoteForReply(ctx: PluginContext, companyId: string, mail: Pick<MailReceived, "replyTo" | "subject">): Promise<string | null> {
  const reply = mail.replyTo;
  if (reply && reply.plugin === PIB_PLUGINS.billing) return reply.kind === "quote" ? reply.id : null;
  const numbers = [...new Set([...String(mail.subject ?? "").matchAll(QUOTE_NUMBER_RE)].map((m) => m[1]!.toUpperCase()))];
  if (!numbers.length) return null;
  const rows = await ctx.db.query<{ id: string }>(
    `SELECT id FROM ${table(ctx, "quotes")} WHERE company_id = $1 AND upper(number) IN (SELECT jsonb_array_elements_text($2::jsonb)) AND sent_at IS NOT NULL ORDER BY sent_at DESC LIMIT 1`,
    [companyId, JSON.stringify(numbers)],
  );
  return rows[0]?.id ?? null;
}

/** A customer answered a quote email: one issue per quote for the Account Manager, with the reply and the next steps. */
export async function openQuoteReplyIssue(ctx: PluginContext, companyId: string, mail: MailReceived, quoteId: string): Promise<{ quoteId: string; issueId: string | null }> {
  const quote = await getQuote(ctx, quoteId);
  if (!quote || quote.company_id !== companyId) return { quoteId, issueId: null };
  const prefix = await companyPrefix(ctx, companyId);
  const name = nameOf(quote.customer, quote.customer_ref);
  const client = clientRef(quote.customer_kind, quote.customer_ref);
  const from = `${mail.from?.name ? `${mail.from.name} ` : ""}<${mail.from?.email ?? "unknown"}>`;
  const snippet = String(mail.snippet ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  const money = formatMoneyMinor(Number(quote.total_minor), quote.currency);
  const description = [
    `${from} replied to quote ${quote.number} (${money}, ${quote.status}${quote.valid_until ? `, valid until ${String(iso(quote.valid_until)).slice(0, 10)}` : ""}) for ${name} (\`${client}\`)${quote.deal_id ? `, CRM deal \`${quote.deal_id}\`` : ""}.`,
    "",
    `Subject: ${mail.subject}`,
    `> ${snippet || "(no text)"}`,
    `Mailbox message \`${mail.messageId}\`, thread \`${mail.threadId}\`. Read the full email in the Mailbox before you act.`,
    "",
    "Next steps:",
    `- They accept: \`partnersinbiz.billing:set-quote-status\` (quoteId \`${quote.id}\`, status \`accepted\`), then \`convert-quote\` to draft the invoice, check it and \`request-invoice-send\`. Accepting tells the CRM, which marks the deal won.`,
    "- They decline: `set-quote-status` with `declined`, and log why on the client in the CRM.",
    `- A question or a change: answer with a Mailbox draft (\`partnersinbiz.mailbox:create-draft\` with replyToMessageId \`${mail.messageId}\`); a person sends it. Then log it with \`partnersinbiz.billing:log-follow-up\` (quoteId \`${quote.id}\`, a note, mailDraftId). For a changed price or scope, draft a new quote (with the same dealId) and \`request-quote-send\`.`,
    "- Not sure what they mean, or they ask for a discount: ask the owner with `partnersinbiz.cockpit:ask-owner`, and leave this issue blocked until they answer.",
    "",
    `Quote: ${billingPath(prefix, { tab: "quotes", client })}`,
    "Done when the quote's status changed (accepted, declined, expired), a new quote for the deal is drafted, or the answer is drafted and logged. Billing checks that when you close it.",
  ].join("\n");
  const result = await upsertStandingIssue(ctx, {
    key: quoteReplyKey(quote.id),
    companyId,
    kind: "quote_reply",
    subjectId: quote.id,
    title: `Quote reply: ${quote.number} (${name})`,
    description,
    fingerprint: mail.key,
    route: await quoteRoute(ctx, companyId),
    wake: true,
    comment: `New reply from ${from}: "${snippet.slice(0, 300)}"`,
    wakeReason: "A customer replied to a quote",
    // The status when this reply came in: the done check looks for a change since.
    detail: { quoteStatus: quote.status, messageId: mail.messageId, repliedAt: mail.receivedAt || new Date().toISOString() },
  });
  return { quoteId: quote.id, issueId: result.issueId };
}

// ── Deal won (CRM) ─────────────────────────────────────────────────────────

/** CRM `deal.won`: one drafting issue per deal for the Account Manager (idempotent by the event key). */
export async function onDealWon(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const deal = event.payload as DealWon | undefined;
  const companyId = event.companyId;
  if (!companyId || !deal?.key || !deal.dealId) return;
  if (!(await billingOn(ctx, companyId))) return;
  await receiveOnce(ctx, companyId, DEAL_WON_EVENT, `deal-won:${deal.key}`, () => openDealWonIssue(ctx, companyId, deal));
}

export async function openDealWonIssue(ctx: PluginContext, companyId: string, deal: DealWon): Promise<Record<string, unknown>> {
  const quotes = await ctx.db.query<{ id: string; number: string; status: string; converted_invoice_id: string | null }>(
    `SELECT id, number, status, converted_invoice_id FROM ${table(ctx, "quotes")} WHERE company_id = $1 AND deal_id = $2 ORDER BY created_at DESC`,
    [companyId, deal.dealId],
  );
  const invoices = await ctx.db.query<{ id: string; number: string; status: string }>(
    `SELECT id, number, status FROM ${table(ctx, "invoices")} WHERE company_id = $1 AND deal_id = $2 AND status <> 'cancelled' ORDER BY created_at DESC`,
    [companyId, deal.dealId],
  );
  const issued = invoices.find((i) => i.status !== "draft");
  // Already invoiced (the quote was accepted and the invoice went out): nothing to draft.
  if (issued) return { dealId: deal.dealId, skipped: `invoice ${issued.number} is already ${issued.status}` };
  const prefix = await companyPrefix(ctx, companyId);
  const client = clientRef(deal.clientKind, deal.clientRef);
  const value = deal.valueMinor != null && deal.valueMinor > 0 ? formatMoneyMinor(deal.valueMinor, deal.currency || "ZAR") : null;
  const accepted = quotes.find((q) => q.status === "accepted");
  const draft = invoices.find((i) => i.status === "draft");
  const head = `The CRM marked deal "${deal.title}" (\`${deal.dealId}\`) won for ${deal.clientName} (\`${client}\`) on ${String(deal.wonAt ?? "").slice(0, 10) || "today"}${value ? `, worth ${value}` : ""}.${deal.firstWin ? " It is their first win: the Cockpit starts onboarding separately." : ""}`;
  const links = `Billing for this client: ${billingPath(prefix, { client })} · Quotes: ${billingPath(prefix, { tab: "quotes", client })} · CRM deals: ${pagePath(prefix, "/crm?tab=deals")}`;
  const prefixTitle = `Deal won: ${deal.title} for ${deal.clientName}${value ? `, ${value}` : ""}`;
  let title: string;
  let lines: string[];
  if (draft || accepted) {
    // Already drafted: one next step only, so nobody drafts a second invoice for the same sale.
    const step = draft
      ? `Invoice ${draft.number} (\`${draft.id}\`) is already drafted for this deal: check it with \`partnersinbiz.billing:invoice-detail\` and ask for approval with \`request-invoice-send\`. Do not draft another invoice for this deal.`
      : `Quote ${accepted!.number} (\`${accepted!.id}\`) for this deal is accepted: \`convert-quote\` it, check the draft invoice and \`request-invoice-send\`. Do not draft another invoice for this deal.`;
    title = draft ? `${prefixTitle}: send invoice ${draft.number}` : `${prefixTitle}: convert quote ${accepted!.number} and send the invoice`;
    lines = [head, "", step, "", links, "Done when the invoice is waiting for approval. Billing checks that when you close it."];
  } else {
    title = `${prefixTitle}: draft the quote, invoice or retainer`;
    lines = [
      head,
      "",
      ...(quotes.length ? [`Quote(s) ${quotes.map((q) => `${q.number} (${q.status})`).join(", ")} are linked to this deal. If one was agreed, \`set-quote-status\` accepted and \`convert-quote\` it instead of drafting below.`, ""] : []),
      "Draft what was sold (pass the deal id so the CRM and Billing stay linked):",
      `- Once-off work: \`partnersinbiz.billing:create-invoice\` (customerKind \`${deal.clientKind}\`, customerRef \`${deal.clientRef}\`, currency, dealId \`${deal.dealId}\`), \`add-line\` per item (cents, VAT code), then \`request-invoice-send\`.`,
      `- Not agreed in writing yet: \`create-quote\` with dealId \`${deal.dealId}\`, \`add-quote-line\`, then \`request-quote-send\`.`,
      `- A monthly retainer: \`create-subscription\` (client \`${client}\`, priceMinor or planId, period, startAt). Each period's invoice is drafted for you to send.`,
      "Take the items and prices from the deal in the CRM (`partnersinbiz.crm:list-deal-products`). Never invent prices: if the amount or scope is unclear, ask the owner with `partnersinbiz.cockpit:ask-owner` and leave this issue blocked until they answer.",
      `If the owner says this deal is not billed (or billed elsewhere), record that with \`partnersinbiz.billing:log-follow-up\` (dealId \`${deal.dealId}\`, note).`,
      "",
      links,
      "Done when the invoice or quote is waiting for approval, or the retainer is set up. Billing checks that when you close it.",
    ];
  }
  const description = lines.join("\n");
  const result = await upsertStandingIssue(ctx, {
    key: dealWonKey(deal.dealId),
    companyId,
    kind: "deal_won",
    subjectId: deal.dealId,
    title: title.length > 240 ? `${title.slice(0, 237)}…` : title,
    description,
    fingerprint: deal.key,
    route: await workRoute(ctx, companyId),
    wake: true,
    comment: null,
    wakeReason: "A deal was won",
    // The client, so the done check also finds a quote, invoice or retainer drafted without the deal id.
    detail: { clientKind: deal.clientKind === "contact" ? "contact" : "company", clientRef: deal.clientRef, title: deal.title, clientName: deal.clientName },
  });
  return { dealId: deal.dealId, issueId: result.issueId };
}
