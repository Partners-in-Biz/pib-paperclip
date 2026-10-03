/**
 * The do-not-email list, checked on every send.
 *
 * - Marketing sends (`marketing: true`: campaign steps, CRM sequences) leave
 *   out every suppressed address and carry a List-Unsubscribe header. Any
 *   send leaves out addresses suppressed for `all` (a hard bounce). When no
 *   recipient is left the request fails permanently with a clear error and
 *   the `suppressed` list, so the sender stops instead of retrying.
 * - Inbound: a message whose subject or first line is "unsubscribe" or
 *   "stop" suppresses the sender for marketing; a hard bounce for an address
 *   we emailed suppresses it for all mail. Both are announced as
 *   `contact.suppressed`.
 * - `contact.suppressed` from the CRM and Campaigns joins the same list.
 * - Events are at-most-once, so the hourly job announces what the Mailbox
 *   found in the last 3 days again (receivers upsert by address).
 */
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import {
  HANDOFF_EVENTS,
  OWN_SENDER,
  pluginEvent,
  suppressionBlocks,
  suppressionEmail,
  suppressionKey,
  suppressionScope,
  SUPPRESSION_SOURCES,
  type ContactSuppressed,
  type MailAddress,
  type MailSendRequested,
  type SuppressionReason,
} from "@partnersinbiz/pib-plugin-kit";
import type { GmailStore } from "./db.js";
import { announceOptOut } from "./erasure.js";
import { errorMessage, type Env } from "./gmail/env.js";
import { isValidEmail } from "./gmail/headers.js";
import type { AccountRow, MessageRow, SkippedRecipient, SuppressionReasonKey, SuppressionRow, SuppressionScope } from "./gmail/types.js";
import { PLUGIN_ID } from "./namespace.js";
import { accountSenderKey } from "./sender.js";

export const REANNOUNCE_HOURS = 72;
const REASONS: SuppressionReasonKey[] = ["unsubscribed", "bounced", "complained", "manual"];

export const REASON_LABELS: Record<SuppressionReasonKey, string> = {
  unsubscribed: "unsubscribed from marketing email",
  bounced: "bounced before (a hard bounce), so the address does not work",
  complained: "complained about our email",
  manual: "is on the do-not-email list",
};

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export interface SuppressionCheck {
  /** The request with the suppressed recipients left out. */
  request: MailSendRequested;
  skipped: SkippedRecipient[];
  /** No recipient is left: do not send. */
  blocked: boolean;
  /** Error for a blocked request. */
  error: string | null;
}

/**
 * Whether this row stops this send: a hard bounce (`all`) stops every send, a
 * marketing opt-out stops marketing from the same sender (and from every sender
 * when the row has none: it was written before senders existed).
 */
export function blocks(row: Pick<SuppressionRow, "scope" | "sender_key">, send: { marketing: boolean; senderKey?: string | null }): boolean {
  return suppressionBlocks({ scope: row.scope, senderKey: row.sender_key || null }, send);
}

/** Leaves out suppressed recipients (to, cc, bcc). `senderKey` is whose list applies (the sending mailbox's client, or `own`). */
export async function checkSuppression(store: Pick<GmailStore, "suppressionsFor">, companyId: string, request: MailSendRequested, senderKey: string = OWN_SENDER): Promise<SuppressionCheck> {
  const all = [...request.to, ...(request.cc ?? []), ...(request.bcc ?? [])];
  const rows = all.length ? await store.suppressionsFor(companyId, all.map((a) => a.email)) : [];
  const marketing = request.marketing === true;
  // One row per address is enough to skip it; a hard bounce or an erasure marker is the strongest reason, so it is the one named.
  const stop = new Map<string, SuppressionRow>();
  for (const row of rows.filter((entry) => blocks(entry, { marketing, senderKey }))) {
    const have = stop.get(row.email);
    if (!have || (row.scope === "all" && have.scope !== "all")) stop.set(row.email, row);
  }
  if (stop.size === 0) return { request, skipped: [], blocked: false, error: null };
  const keep = (list: MailAddress[] | undefined) => (list ?? []).filter((address) => !stop.has(suppressionEmail(address.email)));
  const filtered: MailSendRequested = { ...request, to: keep(request.to), cc: keep(request.cc), bcc: keep(request.bcc) };
  const skipped = [...stop.values()].map((row) => ({ email: row.email, scope: row.scope, reason: row.reason }));
  const left = filtered.to.length + (filtered.cc?.length ?? 0) + (filtered.bcc?.length ?? 0);
  if (left > 0) return { request: filtered, skipped, blocked: false, error: null };
  const detail = skipped.map((entry) => `${entry.email} ${REASON_LABELS[entry.reason]}`).join("; ");
  return {
    request: filtered,
    skipped,
    blocked: true,
    error: `Not sent: ${detail}. ${marketing ? "Marketing email never goes to a suppressed address." : "Correct the address in the CRM, then send again."}`,
  };
}

/**
 * `List-Unsubscribe` for marketing mail: a reply to the sending account with
 * subject "unsubscribe", and, when there is an https address, that first (mail
 * clients prefer it). `post` is `List-Unsubscribe-Post`, set only with an https
 * address: RFC 8058 one-click needs both headers.
 */
export function listUnsubscribeHeader(fromAddress: string, httpsUrl?: string | null): { value: string; post: string | null } {
  const mailto = `<mailto:${fromAddress}?subject=unsubscribe>`;
  const both = httpsUrl ? `<${httpsUrl}>, ${mailto}` : null;
  // The header is one unfolded line of at most 998 characters (RFC 5322); a link that would push it over is left out, never truncated.
  return both && "List-Unsubscribe: ".length + both.length <= 998 ? { value: both, post: "List-Unsubscribe=One-Click" } : { value: mailto, post: null };
}

// ---------------------------------------------------------------------------
// Inbound: unsubscribe requests and hard bounces
// ---------------------------------------------------------------------------

const OPT_OUT = /^(please\s+)?(unsubscribe|stop)(\s+(me|please))?$/i;

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/[\s.!,;:]+$/, "");
}

/**
 * The first line of a message from its Gmail snippet (where line breaks are
 * spaces): the text before a quoted reply, a signature or a forwarded header.
 */
export function firstLine(snippet: string): string {
  const text = decodeEntities(snippet).replace(/\s+/g, " ").trim();
  const cut = /\s((On|Op)\s.{3,200}?\s(wrote|geskryf):|-{2,}|_{5,}|From:\s|Sent from\s|Get Outlook|>)/i.exec(text);
  return clean(cut ? text.slice(0, cut.index) : text);
}

/** "unsubscribe" or "stop" as the whole subject (after Re:/Fwd:) or the whole first line. */
export function isOptOutRequest(subject: string, snippet: string): boolean {
  const topic = clean(decodeEntities(subject).replace(/^((re|fw|fwd|aw|sv)\s*:\s*)+/i, ""));
  return OPT_OUT.test(topic) || OPT_OUT.test(firstLine(snippet));
}

/** Delay notices and full mailboxes clear up by themselves: only permanent failures suppress. */
const SOFT_BOUNCE = /\b(delay(ed)?|temporar(y|ily)|will (be )?retr(y|ied)|still trying|(mailbox|inbox) (is )?full|out of storage|storage space|over quota|quota exceeded|try again later)\b/i;

/**
 * Addresses a delivery failure notice says are dead, limited to addresses we
 * emailed in the last 30 days (a notice cannot suppress strangers). Without
 * X-Failed-Recipients, the bounced message found by its Message-ID counts
 * when it had one recipient.
 */
export async function hardBounceRecipients(store: Pick<GmailStore, "sendsByRfcIds" | "sendToRecipient">, companyId: string, row: MessageRow): Promise<string[]> {
  if (!row.bounce || row.direction !== "inbound") return [];
  if (SOFT_BOUNCE.test(`${row.subject ?? ""} ${row.snippet ?? ""}`)) return [];
  let candidates = row.bounce.recipients.map(suppressionEmail).filter(isValidEmail);
  if (candidates.length === 0 && row.bounce.rfcIds.length > 0) {
    const sends = await store.sendsByRfcIds(companyId, row.bounce.rfcIds);
    const single = sends.find((send) => (send.to_addrs ?? []).length === 1);
    if (single) candidates = [suppressionEmail(single.to_addrs![0]!.email)];
  }
  const out: string[] = [];
  for (const email of [...new Set(candidates)]) {
    if (await store.sendToRecipient(companyId, email)) out.push(email);
  }
  return out;
}

export function suppressionPayload(input: { email: string; reason: SuppressionReasonKey; scope: SuppressionScope; clientKind?: string | null; clientRef?: string | null; at?: string; source?: string; senderKey?: string | null }): ContactSuppressed {
  const email = suppressionEmail(input.email);
  const senderKey = input.senderKey || null;
  return {
    key: suppressionKey(email, input.reason, senderKey ?? OWN_SENDER),
    email,
    reason: input.reason,
    scope: input.scope,
    source: input.source ?? PLUGIN_ID,
    clientKind: input.clientKind === "company" || input.clientKind === "contact" ? input.clientKind : null,
    clientRef: input.clientRef ?? null,
    // A hard bounce is per address, not per sender: it carries none.
    ...(senderKey && input.scope === "marketing" ? { senderKey } : {}),
    at: input.at ?? new Date().toISOString(),
  };
}

/** Tells the CRM and Campaigns. Never throws. */
export async function announce(env: Env, companyId: string, payload: ContactSuppressed): Promise<boolean> {
  try {
    await env.ctx.events.emit(HANDOFF_EVENTS.contactSuppressed, companyId, payload as unknown as Record<string, unknown>);
    return true;
  } catch (error) {
    env.ctx.logger.info("contact.suppressed emit failed; the hourly job announces it again", { email: payload.email, error: errorMessage(error) });
    return false;
  }
}

/**
 * After triage: an opt-out suppresses the sender for marketing; a hard
 * bounce suppresses the dead addresses for all mail. Returns what it added.
 */
export async function suppressFromInbound(env: Env, account: AccountRow, row: MessageRow, ownAddresses: Set<string>): Promise<Array<{ email: string; scope: SuppressionScope; reason: SuppressionReasonKey }>> {
  if (row.direction !== "inbound") return [];
  const companyId = account.company_id;
  const added: Array<{ email: string; scope: SuppressionScope; reason: SuppressionReasonKey }> = [];
  const sender = row.from_addr?.email ? suppressionEmail(row.from_addr.email) : null;
  if (sender && !row.bounce && !row.bulk && !ownAddresses.has(sender) && isOptOutRequest(row.subject ?? "", row.snippet ?? "")) {
    // An opt-out is on the list of whoever the mailbox sends as: the company's own, or the client the mailbox belongs to.
    const senderKey = accountSenderKey(account);
    const stored = await env.store.upsertSuppression({ companyId, email: sender, scope: "marketing", reason: "unsubscribed", source: PLUGIN_ID, detail: `Asked to stop in message ${row.id}`, senderKey });
    if (stored.created) {
      added.push({ email: sender, scope: "marketing", reason: "unsubscribed" });
      await announce(env, companyId, suppressionPayload({ email: sender, reason: "unsubscribed", scope: "marketing", clientKind: row.client_kind, clientRef: row.client_ref, senderKey }));
      await announceOptOut(env, companyId, { email: sender, senderKey, source: "reply", wording: firstLine(row.snippet ?? ""), at: row.received_at ?? undefined });
    }
  }
  for (const email of await hardBounceRecipients(env.store, companyId, row)) {
    if (ownAddresses.has(email)) continue;
    const stored = await env.store.upsertSuppression({ companyId, email, scope: "all", reason: "bounced", source: PLUGIN_ID, detail: `Hard bounce in message ${row.id}` });
    if (stored.created || stored.widened) {
      added.push({ email, scope: "all", reason: "bounced" });
      await announce(env, companyId, suppressionPayload({ email, reason: "bounced", scope: "all" }));
    }
  }
  return added;
}

// ---------------------------------------------------------------------------
// The shared list
// ---------------------------------------------------------------------------

/** The events the Mailbox listens to: every other plugin that suppresses addresses. */
export function suppressionEvents(): string[] {
  return SUPPRESSION_SOURCES.filter((source) => source !== PLUGIN_ID).map((source) => pluginEvent(source, HANDOFF_EVENTS.contactSuppressed));
}

function senderOf(eventType: string): string | null {
  const suffix = `.${HANDOFF_EVENTS.contactSuppressed}`;
  return eventType.startsWith("plugin.") && eventType.endsWith(suffix) ? eventType.slice("plugin.".length, -suffix.length) : null;
}

/** `contact.suppressed` from the CRM or Campaigns. */
export async function onContactSuppressed(env: Env, event: PluginEvent): Promise<void> {
  const companyId = event.companyId;
  const body = (event.payload && typeof event.payload === "object" ? event.payload : {}) as Record<string, unknown>;
  const email = typeof body.email === "string" ? suppressionEmail(body.email) : "";
  const reason = REASONS.includes(body.reason as SuppressionReasonKey) ? (body.reason as SuppressionReason) : null;
  if (!companyId || !isValidEmail(email) || !reason) return;
  const scope: SuppressionScope = body.scope === "all" || body.scope === "marketing" ? body.scope : suppressionScope(reason);
  const source = typeof body.source === "string" && body.source ? body.source.slice(0, 120) : senderOf(String(event.eventType)) ?? "unknown";
  // A hard bounce is per address; an opt-out is on the sender's list. No sender (an older plugin): every sender, as before.
  const senderKey = scope === "marketing" && typeof body.senderKey === "string" ? body.senderKey.trim().slice(0, 200) : "";
  try {
    await env.store.upsertSuppression({ companyId, email, scope, reason, source, detail: null, senderKey });
  } catch (error) {
    env.ctx.logger.error("Mailbox suppression failed", { email, error: errorMessage(error) });
  }
}

/** Hourly: announce again what the Mailbox suppressed in the last 3 days. */
export async function reannounceSuppressions(env: Env, now = Date.now()): Promise<number> {
  const since = new Date(now - REANNOUNCE_HOURS * 3_600_000).toISOString();
  let sent = 0;
  for (const row of await env.store.ownSuppressionsSince(PLUGIN_ID, since, 500)) {
    // An erased person's marker has no address to announce.
    if (row.email_hash) continue;
    if (await announce(env, row.company_id, suppressionPayload({ email: row.email, reason: row.reason, scope: row.scope, senderKey: row.sender_key, at: row.updated_at || row.created_at }))) sent += 1;
  }
  return sent;
}
