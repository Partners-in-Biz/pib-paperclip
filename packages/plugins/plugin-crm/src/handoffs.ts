/**
 * Hand-offs between the CRM and the other modules (kit `HANDOFF_EVENTS`).
 *
 * Emits (each arrives as `plugin.partnersinbiz.crm.<name>`):
 * - `deal.won` when a deal moves to a won stage (`firstWin` when the client
 *   just became a customer): Billing opens its drafting task, the Cockpit
 *   starts onboarding.
 * - `contact.suppressed` when the CRM learns an address must not get
 *   marketing email: an unsubscribe reply, a bounce, or a person or agent
 *   setting the email status.
 * - `company.deleted` when a person deletes a company.
 * These have no result event, so each is recorded once (`handoffs`) and
 * re-sent hourly for a day; receivers dedupe by `key`.
 *
 * Consumes:
 * - Billing `quote.accepted`: the linked (or the client's only) open deal
 *   moves to won; several open deals open an issue for the Account Manager.
 * - Billing `invoice.paid`: logged on the client, lifecycle customer.
 * - Campaigns and Mailbox `contact.suppressed`: the email status is set and
 *   the contact's sequences stop.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import {
  createWorkIssue,
  formatMoneyMinor,
  HANDOFF_EVENTS,
  PIB_PLUGINS,
  pluginEvent,
  receiveOnce,
  SUPPRESSION_SOURCES,
  suppressionEmail,
  suppressionScope,
  type ContactSuppressed,
  type DealWon,
  type InvoicePaid,
  type QuoteAccepted,
  type SuppressionReason,
} from "@partnersinbiz/pib-plugin-kit";
import {
  asRecord,
  contactsByEmail,
  ensurePipeline,
  getAccount,
  getContact,
  getDeal,
  insertActivity,
  insertActivityOnce,
  insertDeal,
  listDeals,
  listLinks,
  listStages,
  saveAccount,
  saveContact,
  saveDeal,
  saveEmailStatus,
  stageKind,
  stopEnrollmentsForContact,
  table,
} from "./db.js";
import { LOCAL_BOARD_USER_ID, stageStopsEnrollments, type AccountDraft, type ContactDraft, type DealDraft, type EmailStatus } from "./domain.js";
import { PLUGIN_ID } from "./namespace.js";
import { LEGACY_ORIGINS, originFor } from "./origins.js";
import { companyPrefix, crmLink, pagePath, refOf, type ClientKind } from "./refs.js";
import { teamAssignee } from "./routing.js";
import { recentHandoffs, recordHandoff } from "./store.js";

const ORIGIN = `plugin:${PLUGIN_ID}` as const;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Record once and emit now. Later re-sends come from `reemitHandoffs`. */
export async function sendHandoff(ctx: PluginContext, companyId: string, event: string, payload: { key: string } & Record<string, unknown>): Promise<boolean> {
  const recorded = await recordHandoff(ctx, companyId, event, payload);
  if (!recorded) return false;
  try {
    await ctx.events.emit(event, companyId, payload);
  } catch (error) {
    ctx.logger.info("CRM hand-off emit failed; re-sent within the hour", { event, key: payload.key, error: message(error) });
  }
  return true;
}

/** Hourly: re-send the last day's hand-offs (receivers dedupe by key). */
export async function reemitHandoffs(ctx: PluginContext, companyId: string): Promise<number> {
  let sent = 0;
  for (const row of await recentHandoffs(ctx, companyId, 24)) {
    try {
      await ctx.events.emit(row.event, companyId, row.payload);
      sent += 1;
    } catch (error) {
      ctx.logger.info("CRM hand-off re-send failed", { key: row.key, error: message(error) });
    }
  }
  return sent;
}

// ---------------------------------------------------------------------------
// Won deals
// ---------------------------------------------------------------------------

export interface WonClient {
  kind: ClientKind;
  id: string;
  name: string;
}

/** The client of a deal: its company, else its contact. */
async function dealClient(ctx: PluginContext, deal: DealDraft): Promise<{ client: WonClient; account: AccountDraft | null; contact: ContactDraft | null } | null> {
  const account = deal.accountId ? await getAccount(ctx, deal.accountId) : null;
  const contact = deal.contactId ? await getContact(ctx, deal.contactId) : null;
  if (account && account.companyId === deal.companyId) return { client: { kind: "company", id: account.id, name: account.name }, account, contact };
  if (contact && contact.companyId === deal.companyId) return { client: { kind: "contact", id: contact.id, name: contact.name }, account: null, contact };
  return null;
}

/**
 * A deal just moved into a won stage: set won_at, make the client a customer
 * (a won deal is a fact, so it wins over a human-owned lifecycle), log it,
 * and emit `deal.won`. A deal with no client opens an issue to link one.
 */
export async function onDealWon(ctx: PluginContext, deal: DealDraft, how: string): Promise<{ firstWin: boolean; emitted: boolean; issueId: string | null }> {
  await ctx.db.execute(`UPDATE ${table(ctx, "deals")} SET won_at = now() WHERE id = $1`, [deal.id]);
  const found = await dealClient(ctx, deal);
  const value = deal.amountMinor > 0 ? formatMoneyMinor(deal.amountMinor, deal.currency) : "no amount";
  if (!found) {
    const prefix = await companyPrefix(ctx, deal.companyId);
    for (const originId of [originFor.wonClient(deal.id), LEGACY_ORIGINS.wonClient(deal.id)]) {
      const open = await ctx.issues.list({ companyId: deal.companyId, originKind: ORIGIN, originId, limit: 1 }).catch(() => []);
      if (open[0] && open[0].status !== "done" && open[0].status !== "cancelled") return { firstWin: false, emitted: false, issueId: open[0].id };
    }
    const issue = await createWorkIssue(ctx, {
      companyId: deal.companyId,
      title: `Hand-off: link the won deal "${deal.title}" to its client`.slice(0, 200),
      description: [
        `The deal "${deal.title}" (${value}, id \`${deal.id}\`) was won (${how}) but has no company or contact, so the CRM could not make the client a customer or tell Billing and the Cockpit.`,
        "",
        "1. Find the client with `find-records` (create it only when nothing matches).",
        `2. Link this deal to it: \`update-deal\` with dealId \`${deal.id}\` and \`companyRecordId\` or \`contactId\`. The CRM then makes them a customer and tells Billing and the Cockpit.`,
        "3. Mark this issue done with the client's ref.",
        "",
        "**Done when** the deal has a company or contact (or is no longer won). Closing checks it.",
        `Pipeline: ${pagePath(prefix, "/crm?tab=deals")}`,
      ].join("\n"),
      originKind: ORIGIN,
      originId: originFor.wonClient(deal.id),
      ...(await teamAssignee(ctx, deal.companyId)),
      wakeReason: "A won deal needs its client",
    });
    return { firstWin: false, emitted: false, issueId: issue.id };
  }
  const { client, account, contact } = found;
  let firstWin = false;
  if (account) {
    firstWin = account.lifecycle !== "customer";
    if (firstWin) await saveAccount(ctx, { ...account, lifecycle: "customer" });
  } else if (contact) {
    firstWin = contact.lifecycle !== "customer";
    if (firstWin) await saveContact(ctx, { ...contact, lifecycle: "customer" });
  }
  // The buyer becomes a customer too.
  if (account && contact && contact.lifecycle !== "customer") await saveContact(ctx, { ...contact, lifecycle: "customer" });
  await insertActivity(ctx, {
    companyId: deal.companyId,
    recordType: client.kind,
    recordId: client.id,
    kind: "deal_won",
    body: `Won deal "${deal.title}" (${value}) ${how}.${firstWin ? " Lifecycle set to customer." : ""}`,
  }).catch(() => undefined);
  const contactEmail = contact?.emails.find((email) => email.includes("@")) ?? (account ? await firstPersonEmail(ctx, deal.companyId, account.id) : null);
  const payload: DealWon = {
    key: `crm:deal:${deal.id}:won`,
    dealId: deal.id,
    title: deal.title,
    valueMinor: deal.amountMinor > 0 ? deal.amountMinor : null,
    currency: deal.currency,
    clientKind: client.kind,
    clientRef: client.id,
    clientName: client.name,
    contactEmail,
    firstWin,
    ownerAgentId: deal.assigneeAgentId ?? null,
    ownerUserId: deal.ownerUserId && deal.ownerUserId !== LOCAL_BOARD_USER_ID ? deal.ownerUserId : null,
    wonAt: new Date().toISOString(),
  };
  const emitted = await sendHandoff(ctx, deal.companyId, HANDOFF_EVENTS.dealWon, payload as unknown as { key: string } & Record<string, unknown>);
  return { firstWin, emitted, issueId: null };
}

async function firstPersonEmail(ctx: PluginContext, companyId: string, accountId: string): Promise<string | null> {
  const links = (await listLinks(ctx, companyId)).filter((link) => link.accountId === accountId);
  for (const link of links) {
    const person = await getContact(ctx, link.contactId);
    const email = person?.emails.find((item) => item.includes("@") && person.emailStatus !== "bounced");
    if (email) return email;
  }
  return null;
}

/** The first won stage of the deal's pipeline. */
async function wonStageId(ctx: PluginContext, pipelineId: string): Promise<string | null> {
  const stages = await listStages(ctx, pipelineId);
  return stages.find((stage) => stageKind(stage.kind) === "won")?.id ?? null;
}

/**
 * Moves a deal to a stage: logs the move, stops the contact's sequences on
 * won or lost, and runs the won hand-off when it enters a won stage.
 */
export async function moveDealTo(
  ctx: PluginContext,
  deal: DealDraft,
  stage: { id: string; name: string; kind: string },
  how: string,
): Promise<{ deal: DealDraft; stageKind: string; won: { firstWin: boolean; emitted: boolean; issueId: string | null } | null }> {
  const before = await listStages(ctx, deal.pipelineId).catch(() => []);
  const wasWon = stageKind(before.find((row) => row.id === deal.stageId)?.kind ?? "open") === "won";
  const moved = deal.stageId !== stage.id;
  const next: DealDraft = { ...deal, stageId: stage.id };
  await saveDeal(ctx, next);
  if (moved) {
    // Recorded for the deal's history and the Cockpit's activity list; never fails the move.
    await insertActivity(ctx, { companyId: deal.companyId, recordType: "deal", recordId: deal.id, kind: "deal_moved", body: `Moved to ${stage.name}` }).catch(() => undefined);
  }
  const kind = stageKind(stage.kind);
  if (stageStopsEnrollments(kind) && deal.contactId) await stopEnrollmentsForContact(ctx, deal.companyId, deal.contactId);
  if (kind !== "won" && wasWon) await ctx.db.execute(`UPDATE ${table(ctx, "deals")} SET won_at = NULL WHERE id = $1`, [deal.id]);
  const won = moved && kind === "won" && !wasWon ? await onDealWon(ctx, next, how) : null;
  return { deal: next, stageKind: kind, won };
}

/**
 * An agent picked the deal an accepted quote closes (`move-deal` with
 * `quoteId`): the deal records the quote in custom `quoteId` and
 * `quoteNumber` (as a deal the CRM creates for a quote does), and its
 * timeline says so. Returns the deal to save.
 */
export async function withQuote(ctx: PluginContext, deal: DealDraft, quoteRef: string): Promise<DealDraft> {
  const rows = await ctx.db.query<{ meta: unknown }>(
    `SELECT meta FROM ${table(ctx, "activities")} WHERE company_id = $1 AND kind = 'quote_accepted'`,
    [deal.companyId],
  );
  const pick = rows.map((row) => asRecord(row.meta)).find((meta) => meta.quoteId === quoteRef);
  const number = typeof pick?.number === "string" && pick.number ? pick.number : null;
  await insertActivityOnce(ctx, {
    companyId: deal.companyId,
    recordType: "deal",
    recordId: deal.id,
    kind: "quote_accepted",
    body: `Quote ${number ?? quoteRef} accepted: it closes this deal.`,
    meta: { quoteId: quoteRef, number },
    sourceKey: `quote-deal:${quoteRef}`,
  }).catch(() => undefined);
  return { ...deal, custom: { ...deal.custom, quoteId: quoteRef, ...(number ? { quoteNumber: number } : {}) } };
}

/** Moves a deal to won (quote acceptance). */
export type MoveToWon = (deal: DealDraft, stageId: string, how: string) => Promise<void>;

export function moveToWonWith(ctx: PluginContext): MoveToWon {
  return async (deal, stageId, how) => {
    const stages = await listStages(ctx, deal.pipelineId);
    const stage = stages.find((row) => row.id === stageId);
    if (!stage) throw new Error("Won stage was not found");
    await moveDealTo(ctx, deal, stage, how);
  };
}

// ---------------------------------------------------------------------------
// Billing: quote accepted, invoice paid
// ---------------------------------------------------------------------------

export const QUOTE_ACCEPTED_EVENT = pluginEvent(PIB_PLUGINS.billing, HANDOFF_EVENTS.quoteAccepted);
export const INVOICE_PAID_EVENT = pluginEvent(PIB_PLUGINS.billing, HANDOFF_EVENTS.invoicePaid);

function asQuoteAccepted(payload: unknown): QuoteAccepted | null {
  const body = asRecord(payload);
  if (typeof body.key !== "string" || !body.key) return null;
  const kind = body.clientKind === "company" || body.clientKind === "contact" ? body.clientKind : null;
  return {
    key: body.key,
    quoteId: typeof body.quoteId === "string" ? body.quoteId : "",
    number: typeof body.number === "string" && body.number ? body.number : "quote",
    dealId: typeof body.dealId === "string" && body.dealId ? body.dealId : null,
    clientKind: kind,
    clientRef: kind && typeof body.clientRef === "string" && body.clientRef ? body.clientRef : null,
    totalMinor: Number.isInteger(body.totalMinor) ? (body.totalMinor as number) : 0,
    currency: typeof body.currency === "string" && /^[A-Z]{3}$/.test(body.currency) ? body.currency : "ZAR",
    acceptedAt: typeof body.acceptedAt === "string" ? body.acceptedAt : new Date().toISOString(),
  };
}

async function clientRecord(ctx: PluginContext, companyId: string, kind: ClientKind, id: string): Promise<AccountDraft | ContactDraft | null> {
  const row = kind === "company" ? await getAccount(ctx, id) : await getContact(ctx, id);
  return row && row.companyId === companyId ? row : null;
}

/** The client's deals (a company's include its people's deals with no company set). */
export async function clientDeals(ctx: PluginContext, companyId: string, kind: ClientKind, id: string): Promise<DealDraft[]> {
  const deals = await listDeals(ctx, companyId);
  if (kind === "contact") return deals.filter((deal) => deal.companyId === companyId && deal.contactId === id);
  const people = new Set((await listLinks(ctx, companyId)).filter((link) => link.accountId === id).map((link) => link.contactId));
  return deals.filter((deal) => deal.companyId === companyId && (deal.accountId === id || (deal.accountId == null && deal.contactId != null && people.has(deal.contactId))));
}

export interface QuoteOutcome extends Record<string, unknown> {
  action: "won" | "already-won" | "created" | "pick" | "ignored";
  dealId?: string | null;
  issueId?: string | null;
  reason?: string;
}

export async function handleQuoteAccepted(ctx: PluginContext, companyId: string, quote: QuoteAccepted, moveToWon: MoveToWon): Promise<QuoteOutcome> {
  const how = `when the customer accepted ${quote.number}`;
  if (quote.dealId) {
    const deal = await getDeal(ctx, quote.dealId);
    if (deal && deal.companyId === companyId) {
      const stages = await listStages(ctx, deal.pipelineId);
      if (stageKind(stages.find((stage) => stage.id === deal.stageId)?.kind ?? "open") === "won") {
        await logQuote(ctx, companyId, deal, quote);
        return { action: "already-won", dealId: deal.id };
      }
      const won = await wonStageId(ctx, deal.pipelineId);
      if (!won) return { action: "ignored", dealId: deal.id, reason: "The pipeline has no won stage" };
      await moveToWon(deal, won, how);
      await logQuote(ctx, companyId, deal, quote);
      return { action: "won", dealId: deal.id };
    }
  }
  if (!quote.clientKind || !quote.clientRef) return { action: "ignored", reason: "No deal and no client on the quote" };
  const client = await clientRecord(ctx, companyId, quote.clientKind, quote.clientRef);
  if (!client) return { action: "ignored", reason: `Client ${refOf(quote.clientKind, quote.clientRef)} is not in the CRM` };
  const deals = await clientDeals(ctx, companyId, quote.clientKind, quote.clientRef);
  const pipeline = await ensurePipeline(ctx, companyId);
  const stages = await listStages(ctx, pipeline.pipelineId);
  const kindOf = (deal: DealDraft) => stageKind(stages.find((stage) => stage.id === deal.stageId)?.kind ?? "open");
  const open = deals.filter((deal) => kindOf(deal) === "open");
  const won = await wonStageId(ctx, pipeline.pipelineId);
  if (!won) return { action: "ignored", reason: "The pipeline has no won stage" };
  if (open.length === 1) {
    await moveToWon(open[0]!, won, how);
    await logQuote(ctx, companyId, open[0]!, quote);
    return { action: "won", dealId: open[0]!.id };
  }
  if (open.length === 0) {
    // A sale without a deal in the pipeline: record it as a won deal so the pipeline and the client's lifecycle are right.
    const deal: DealDraft = {
      id: randomUUID(),
      companyId,
      pipelineId: pipeline.pipelineId,
      stageId: pipeline.openStageId,
      accountId: quote.clientKind === "company" ? quote.clientRef : null,
      contactId: quote.clientKind === "contact" ? quote.clientRef : null,
      title: `Quote ${quote.number}`,
      amountMinor: Math.max(0, quote.totalMinor),
      currency: quote.currency,
      ownerUserId: null,
      assigneeAgentId: null,
      tags: [],
      nextActionKind: null,
      nextActionDueAt: null,
      custom: { quoteId: quote.quoteId, quoteNumber: quote.number },
      humanOwned: [],
    };
    await insertDeal(ctx, deal);
    await moveToWon(deal, won, how);
    await logQuote(ctx, companyId, deal, quote);
    return { action: "created", dealId: deal.id };
  }
  const prefix = await companyPrefix(ctx, companyId);
  const ref = refOf(quote.clientKind, quote.clientRef);
  const quoteRef = quote.quoteId || quote.key;
  const issue = await createWorkIssue(ctx, {
    companyId,
    title: `Hand-off: pick the deal for accepted quote ${quote.number} (${ref})`.slice(0, 200),
    description: [
      `${client.name} (${ref}) accepted quote ${quote.number} (${formatMoneyMinor(quote.totalMinor, quote.currency)}), but has ${open.length} open deals and the quote names none.`,
      "",
      ...open.map((deal) => `- \`${deal.id}\` ${deal.title} (${deal.amountMinor > 0 ? formatMoneyMinor(deal.amountMinor, deal.currency) : "no amount"})`),
      "",
      `Move the deal this quote closes to won with \`move-deal\` (dealId, stageId \`won\`, quoteId \`${quoteRef}\`): the deal records the quote, the client becomes a customer, and Billing and the Cockpit are told. Then mark this issue done.`,
      "",
      "**Done when** a deal carries this quote, or one of the client's deals was won since the quote came in. Closing checks it.",
      `Client: ${crmLink(prefix, quote.clientKind, quote.clientRef)}`,
    ].join("\n"),
    originKind: ORIGIN,
    originId: originFor.quoteDeal(quoteRef),
    ...(await teamAssignee(ctx, companyId)),
    wakeReason: "An accepted quote needs its deal",
  });
  await insertActivityOnce(ctx, {
    companyId,
    recordType: quote.clientKind,
    recordId: quote.clientRef,
    kind: "quote_accepted",
    body: `Quote ${quote.number} accepted (${formatMoneyMinor(quote.totalMinor, quote.currency)}). Several deals are open: the Account Manager picks the one it closes.`,
    meta: { quoteId: quoteRef, number: quote.number, key: quote.key },
    sourceKey: `quote:${quote.key}`,
    issueId: issue.id,
  });
  return { action: "pick", issueId: issue.id };
}

async function logQuote(ctx: PluginContext, companyId: string, deal: DealDraft, quote: QuoteAccepted): Promise<void> {
  await insertActivityOnce(ctx, {
    companyId,
    recordType: "deal",
    recordId: deal.id,
    kind: "quote_accepted",
    body: `Quote ${quote.number} accepted (${formatMoneyMinor(quote.totalMinor, quote.currency)}).`,
    meta: { quoteId: quote.quoteId, number: quote.number },
    sourceKey: `quote:${quote.key}`,
  }).catch(() => undefined);
}

export async function onQuoteAccepted(ctx: PluginContext, event: PluginEvent, moveToWon: MoveToWon): Promise<void> {
  const quote = asQuoteAccepted(event.payload);
  if (!quote || !event.companyId) return;
  try {
    await receiveOnce(ctx, event.companyId, event.eventType, `quote-accepted:${quote.key}`, () => handleQuoteAccepted(ctx, event.companyId, quote, moveToWon));
  } catch (error) {
    ctx.logger.error("CRM quote.accepted failed", { key: quote.key, error: message(error) });
  }
}

function asInvoicePaid(payload: unknown): InvoicePaid | null {
  const body = asRecord(payload);
  if (typeof body.key !== "string" || !body.key) return null;
  const kind = body.clientKind === "company" || body.clientKind === "contact" ? body.clientKind : null;
  return {
    key: body.key,
    invoiceId: typeof body.invoiceId === "string" ? body.invoiceId : "",
    number: typeof body.number === "string" && body.number ? body.number : "invoice",
    dealId: typeof body.dealId === "string" && body.dealId ? body.dealId : null,
    clientKind: kind,
    clientRef: kind && typeof body.clientRef === "string" && body.clientRef ? body.clientRef : null,
    totalMinor: Number.isInteger(body.totalMinor) ? (body.totalMinor as number) : 0,
    currency: typeof body.currency === "string" && /^[A-Z]{3}$/.test(body.currency) ? body.currency : "ZAR",
    paidAt: typeof body.paidAt === "string" ? body.paidAt : new Date().toISOString(),
  };
}

export async function handleInvoicePaid(ctx: PluginContext, companyId: string, invoice: InvoicePaid): Promise<Record<string, unknown>> {
  let kind = invoice.clientKind;
  let ref = invoice.clientRef;
  if ((!kind || !ref) && invoice.dealId) {
    const deal = await getDeal(ctx, invoice.dealId);
    if (deal && deal.companyId === companyId) {
      kind = deal.accountId ? "company" : deal.contactId ? "contact" : null;
      ref = deal.accountId ?? deal.contactId ?? null;
    }
  }
  if (!kind || !ref) return { logged: false, reason: "No client on the invoice" };
  const client = await clientRecord(ctx, companyId, kind, ref);
  if (!client) return { logged: false, reason: `Client ${refOf(kind, ref)} is not in the CRM` };
  const becameCustomer = client.lifecycle !== "customer";
  if (becameCustomer) {
    if (kind === "company") await saveAccount(ctx, { ...(client as AccountDraft), lifecycle: "customer" });
    else await saveContact(ctx, { ...(client as ContactDraft), lifecycle: "customer" });
  }
  await insertActivityOnce(ctx, {
    companyId,
    recordType: kind,
    recordId: ref,
    kind: "invoice_paid",
    body: `Invoice ${invoice.number} paid (${formatMoneyMinor(invoice.totalMinor, invoice.currency)}).${becameCustomer ? " Lifecycle set to customer." : ""}`,
    meta: { invoiceId: invoice.invoiceId, number: invoice.number, dealId: invoice.dealId },
    sourceKey: `invoice-paid:${invoice.key}`,
  });
  return { logged: true, client: refOf(kind, ref), becameCustomer };
}

export async function onInvoicePaid(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const invoice = asInvoicePaid(event.payload);
  if (!invoice || !event.companyId) return;
  try {
    await receiveOnce(ctx, event.companyId, event.eventType, `invoice-paid:${invoice.key}`, () => handleInvoicePaid(ctx, event.companyId, invoice));
  } catch (error) {
    ctx.logger.error("CRM invoice.paid failed", { key: invoice.key, error: message(error) });
  }
}

// ---------------------------------------------------------------------------
// Suppression (contact.suppressed)
// ---------------------------------------------------------------------------

/** Campaigns and the Mailbox; the CRM does not listen to its own event. */
export const SUPPRESSION_EVENTS = SUPPRESSION_SOURCES.filter((source) => source !== PLUGIN_ID).map((source) => pluginEvent(source, HANDOFF_EVENTS.contactSuppressed));

const REASONS: SuppressionReason[] = ["unsubscribed", "bounced", "complained", "manual"];

function asSuppressed(payload: unknown): ContactSuppressed | null {
  const body = asRecord(payload);
  if (typeof body.key !== "string" || !body.key || typeof body.email !== "string" || !body.email.includes("@")) return null;
  const reason = REASONS.includes(body.reason as SuppressionReason) ? (body.reason as SuppressionReason) : "manual";
  return {
    key: body.key,
    email: suppressionEmail(body.email),
    reason,
    scope: body.scope === "all" ? "all" : suppressionScope(reason),
    source: typeof body.source === "string" ? body.source : "unknown",
    clientKind: body.clientKind === "company" || body.clientKind === "contact" ? body.clientKind : null,
    clientRef: typeof body.clientRef === "string" ? body.clientRef : null,
    at: typeof body.at === "string" ? body.at : new Date().toISOString(),
  };
}

/** The status a suppression sets: a bounce is the stronger one and is never softened. */
export function statusFor(reason: SuppressionReason, current: EmailStatus | undefined): EmailStatus {
  if (current === "bounced") return "bounced";
  return reason === "bounced" ? "bounced" : "unsubscribed";
}

const SOURCE_LABEL: Record<string, string> = { [PIB_PLUGINS.campaigns]: "Campaigns", [PIB_PLUGINS.mailbox]: "the Mailbox", [PIB_PLUGINS.crm]: "the CRM" };

/** Applies a suppression to every contact with the address. */
export async function applySuppression(ctx: PluginContext, companyId: string, input: { email: string; reason: SuppressionReason; source: string; key: string }): Promise<{ contacts: string[] }> {
  const contacts = await contactsByEmail(ctx, companyId, input.email);
  const touched: string[] = [];
  for (const contact of contacts) {
    const next = statusFor(input.reason, contact.emailStatus);
    if (contact.emailStatus !== next) await saveEmailStatus(ctx, contact.id, next);
    await stopEnrollmentsForContact(ctx, companyId, contact.id);
    await insertActivityOnce(ctx, {
      companyId,
      recordType: "contact",
      recordId: contact.id,
      kind: "email_suppressed",
      body: `${input.email} ${next === "bounced" ? "bounced" : "opted out"} (${input.reason}, from ${SOURCE_LABEL[input.source] ?? input.source}). Email status ${next}; sequences stopped.`,
      meta: { email: input.email, reason: input.reason, source: input.source },
      sourceKey: `suppressed:${input.key}:${contact.id}`,
    });
    touched.push(contact.id);
  }
  return { contacts: touched };
}

export async function onContactSuppressed(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const suppressed = asSuppressed(event.payload);
  if (!suppressed || !event.companyId) return;
  try {
    // Suppressions apply even while the CRM is switched off: an opt-out is never lost.
    await receiveOnce(ctx, event.companyId, event.eventType, `suppress-in:${suppressed.key}`, () => applySuppression(ctx, event.companyId, suppressed) as Promise<Record<string, unknown>>);
  } catch (error) {
    ctx.logger.error("CRM contact.suppressed failed", { key: suppressed.key, error: message(error) });
  }
}

/** The CRM learned an address must not get marketing email: tell Campaigns and the Mailbox. */
export async function emitSuppressed(
  ctx: PluginContext,
  companyId: string,
  input: { email: string; reason: SuppressionReason; clientKind?: ClientKind | null; clientRef?: string | null },
): Promise<boolean> {
  const email = suppressionEmail(input.email);
  if (!email.includes("@")) return false;
  const payload: ContactSuppressed = {
    key: `suppress:${email}:${input.reason}`,
    email,
    reason: input.reason,
    scope: suppressionScope(input.reason),
    source: PLUGIN_ID,
    clientKind: input.clientKind ?? null,
    clientRef: input.clientRef ?? null,
    at: new Date().toISOString(),
  };
  return sendHandoff(ctx, companyId, HANDOFF_EVENTS.contactSuppressed, payload as unknown as { key: string } & Record<string, unknown>);
}

/** Sets a contact's email status on a person's or agent's word, stops sequences and tells the other modules. */
export async function setEmailStatus(
  ctx: PluginContext,
  contact: ContactDraft,
  status: EmailStatus,
  by: { source: "agent" | "human"; note?: string | null },
): Promise<{ contactId: string; emailStatus: EmailStatus; told: boolean }> {
  if (status === "ok" && by.source !== "human") throw new Error("Only a person can allow email to a contact again");
  const previous = contact.emailStatus ?? "ok";
  // An agent never softens a bounce: the address still does not work.
  if (by.source !== "human" && previous === "bounced" && status === "unsubscribed") status = "bounced";
  if (previous !== status) await saveEmailStatus(ctx, contact.id, status);
  let told = false;
  if (status !== "ok") {
    await stopEnrollmentsForContact(ctx, contact.companyId, contact.id);
    const reason: SuppressionReason = status === "bounced" ? "bounced" : "unsubscribed";
    for (const email of contact.emails.filter((item) => item.includes("@"))) {
      if (await emitSuppressed(ctx, contact.companyId, { email, reason, clientKind: "contact", clientRef: contact.id })) told = true;
    }
  }
  if (previous !== status) {
    await insertActivity(ctx, {
      companyId: contact.companyId,
      recordType: "contact",
      recordId: contact.id,
      kind: "email_status",
      body: `Email status set to ${status} by ${by.source === "human" ? "a person" : "an agent"}${by.note ? `: ${by.note}` : "."}${status === "ok" ? " Other modules keep their own opt-out lists; this does not clear them." : " Sequences stopped; Campaigns and the Mailbox were told."}`.slice(0, 1000),
    });
  }
  return { contactId: contact.id, emailStatus: status, told };
}

// ---------------------------------------------------------------------------
// Company deleted
// ---------------------------------------------------------------------------

/**
 * Deletes a CRM company (a person's action): its links, shares, facts,
 * activities, profile and client leads go; its deals stay, unlinked; its
 * people stay as contacts. Emits `company.deleted`.
 */
export async function deleteCompanyRecord(ctx: PluginContext, companyId: string, account: AccountDraft): Promise<{ deleted: true; id: string; people: number; deals: number }> {
  const links = (await listLinks(ctx, companyId)).filter((link) => link.accountId === account.id);
  const deals = (await listDeals(ctx, companyId)).filter((deal) => deal.accountId === account.id);
  await ctx.db.execute(`UPDATE ${table(ctx, "deals")} SET account_id = NULL, updated_at = now() WHERE company_id = $1 AND account_id = $2`, [companyId, account.id]);
  await ctx.db.execute(`DELETE FROM ${table(ctx, "contact_companies")} WHERE company_id = $1 AND account_id = $2`, [companyId, account.id]);
  await ctx.db.execute(`DELETE FROM ${table(ctx, "record_grants")} WHERE company_id = $1 AND record_type = 'company' AND record_id = $2`, [companyId, account.id]);
  await ctx.db.execute(`DELETE FROM ${table(ctx, "facts")} WHERE company_id = $1 AND record_type = 'company' AND record_id = $2`, [companyId, account.id]);
  await ctx.db.execute(`DELETE FROM ${table(ctx, "activities")} WHERE company_id = $1 AND record_type = 'company' AND record_id = $2`, [companyId, account.id]);
  await ctx.db.execute(`DELETE FROM ${table(ctx, "client_profiles")} WHERE company_id = $1 AND client_kind = 'company' AND client_ref = $2`, [companyId, account.id]);
  await ctx.db.execute(`DELETE FROM ${table(ctx, "client_leads")} WHERE company_id = $1 AND client_kind = 'company' AND client_ref = $2`, [companyId, account.id]);
  await ctx.db.execute(`DELETE FROM ${table(ctx, "companies")} WHERE company_id = $1 AND id = $2`, [companyId, account.id]);
  // People who worked there are re-shared so the other modules drop the link.
  for (const link of links) await ctx.db.execute(`UPDATE ${table(ctx, "contacts")} SET updated_at = now() WHERE id = $1`, [link.contactId]);
  await sendHandoff(ctx, companyId, "company.deleted", { key: `company:${account.id}:deleted`, id: account.id, name: account.name, deletedAt: new Date().toISOString() });
  return { deleted: true, id: account.id, people: links.length, deals: deals.length };
}
