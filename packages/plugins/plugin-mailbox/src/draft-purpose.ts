/**
 * One open draft per client and purpose, and drafts only a person may send (PAR-12249).
 *
 * - `purposeKey` names client + purpose. A newer draft with the same key on the same mailbox replaces the older open one.
 *   An agent's key is always in that agent's own namespace (`agent:<id>:`), so it never reaches another agent's or a plugin's draft.
 * - `purpose` is what the mail is for. Every agent draft is held for a person (`holdForPerson`) unless its purpose is one the
 *   client asked for (REPLY_PURPOSES: reply, followup, invoice) and it is not marked `unasked`. No purpose means held (PAR-1558:
 *   unasked client mail waits for a person). A held draft is refused to an agent's `send-draft` when a recipient is an existing
 *   client; a person sends it from the Mailbox page.
 * - `reply` and `followup` count only on a draft that answers a stored message (`replyToMessageId`): a label alone does not lift
 *   the hold (PAR-14558). Residual limit: `invoice` has no message to point at, so an agent that labels an upsell `invoice`, or
 *   answers an old client message with one, is trusted; the label is on the draft for a person to audit.
 */
import { MAIL_EVENTS, type MailAddress, type MailDraftClosed, type MailDraftKept } from "@partnersinbiz/pib-plugin-kit";
import { MailboxError } from "./domain.js";
import { isFreeMailDomain } from "./free-mail.js";
import type { DraftExtras, MessageRow } from "./gmail/types.js";

export const HOLD_REASON_UNASKED = "Mail an existing client did not ask for (an idea, proposal, upsell, referral or review ask, or a draft with no purpose) is never sent by an agent. A person reads it in the Mailbox drafts and sends it.";
export const HOLD_REASON_NO_THREAD = "A reply or follow-up that answers no stored message (no replyToMessageId) is not shown to be mail the client asked for, so an agent does not send it to an existing client. A person reads it in the Mailbox drafts and sends it.";
export const HOLD_REASON_PLUGIN = "A plugin made this draft for a person to read and send. An agent does not send it to an existing client.";

export function cleanPurpose(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase().replace(/[\s_]+/g, "-").slice(0, 60);
  // One spelling for the tool text and the allow-list: follow-up and follow_up are followup.
  return v === "follow-up" ? "followup" : v || null;
}

/** Mail the client asked for: the only purposes an agent's draft to an existing client may be sent with by the agent itself. */
export const REPLY_PURPOSES = new Set(["reply", "followup", "invoice"]);
/** Of REPLY_PURPOSES, the ones that answer a message: they count only on a draft that names it (`replyToMessageId`). */
const THREAD_PURPOSES = new Set(["reply", "followup"]);

/**
 * The hold for an agent's draft, or null when the agent may send it (when its delegation allows). Default hold: only a purpose
 * on the reply allow-list, not marked unasked, goes without one, and `reply`/`followup` only with the message they answer
 * (PAR-14558: the label alone is the agent's word). An untagged draft is held (PAR-1558).
 */
export function holdFor(purpose: string | null, unasked: boolean, replyToMessageId: string | null = null): { reason: string } | null {
  if (unasked || !purpose || !REPLY_PURPOSES.has(purpose)) return { reason: HOLD_REASON_UNASKED };
  if (THREAD_PURPOSES.has(purpose) && !replyToMessageId) return { reason: HOLD_REASON_NO_THREAD };
  return null;
}

/**
 * `purpose:recipient` unless the caller passed its own key; null when there is neither. With `owner` (an agent's id) the key is
 * put in that agent's namespace, so an agent can only ever replace its own drafts, never another agent's or a plugin's.
 */
export function purposeKeyFor(explicit: unknown, purpose: string | null, to: MailAddress[], owner: string | null = null): string | null {
  const first = to[0]?.email?.trim().toLowerCase();
  const key = typeof explicit === "string" && explicit.trim() ? explicit.trim() : purpose && first ? `${purpose}:${first}` : null;
  if (!key) return null;
  return (owner ? `agent:${owner}:${key}` : key).slice(0, 300);
}

export interface PurposeDraftStore {
  draftsByPurpose(companyId: string, accountId: string, purposeKey: string): Promise<MessageRow[]>;
  deleteDraft(companyId: string, id: string): Promise<boolean>;
}

/** A removed draft: called after the delete, so the plugin that asked for it can hear `mail.draft.closed` (status replaced). */
export type OnReplaced = (row: MessageRow) => Promise<void>;

/** A draft a person edited or asked to have rewritten holds their work: a newer draft never replaces it (PAR-12249). */
export function isKeptByPerson(row: Pick<MessageRow, "draft">): boolean {
  return Boolean(row.draft?.rewrite || row.draft?.editedByPerson || row.draft?.by?.kind === "user");
}

/** After `keepId` was saved: removes the older open drafts with the same key and announces each. Returns their ids. */
export async function replaceOlderDrafts(store: PurposeDraftStore, companyId: string, accountId: string, purposeKey: string, keepId: string, onReplaced: OnReplaced | null = null): Promise<string[]> {
  const removed: string[] = [];
  for (const row of await store.draftsByPurpose(companyId, accountId, purposeKey)) {
    if (row.id === keepId || isKeptByPerson(row)) continue;
    if (!(await store.deleteDraft(companyId, row.id))) continue;
    removed.push(row.id);
    // A plugin's draft must not vanish silently: its rows would point at a draft that is gone (PAR-14558).
    if (onReplaced) await onReplaced(row);
  }
  return removed;
}

/**
 * `replaceOlderDrafts` after the new draft is saved, never failing: the new draft is stored, so an error here must not make
 * the caller report a failure (a retry would then save a second copy). The older drafts stay until the next replacement.
 */
export async function replaceOlderDraftsSafely(store: PurposeDraftStore, companyId: string, accountId: string, purposeKey: string, keepId: string, log: (message: string, meta: Record<string, unknown>) => void, onReplaced: OnReplaced | null = null): Promise<string[]> {
  try {
    return await replaceOlderDrafts(store, companyId, accountId, purposeKey, keepId, onReplaced);
  } catch (error) {
    log("Older drafts not replaced", { purposeKey, keepId, error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

/** A plugin's draft was sent, deleted or replaced: the event that tells the plugin (null for a draft no plugin asked for). */
export function draftClosedEvent(row: Pick<MessageRow, "id" | "draft">, status: MailDraftClosed["status"], replacedBy: string | null = null): MailDraftClosed | null {
  const requestKey = row.draft?.requestKey;
  const context = row.draft?.requestContext;
  if (!requestKey || !context) return null;
  return { key: requestKey, status, mailboxDraftId: row.id, ...(status === "replaced" ? { replacedBy } : {}), context };
}

type EventCtx = { events: { emit: (name: string, companyId: string, payload: Record<string, unknown>) => Promise<void> }; logger: { info: (message: string, meta?: Record<string, unknown>) => void } };

/** Emits `mail.draft.closed` for a plugin's draft; never throws (the send, delete or replacement already happened). */
export async function announceDraftClosed(ctx: EventCtx, companyId: string, row: Pick<MessageRow, "id" | "draft">, status: MailDraftClosed["status"], replacedBy: string | null = null): Promise<void> {
  const event = draftClosedEvent(row, status, replacedBy);
  if (!event) return;
  try {
    await ctx.events.emit(MAIL_EVENTS.draftClosed, companyId, event as unknown as Record<string, unknown>);
  } catch (error) {
    ctx.logger.info("Draft closed event not emitted", { key: event.key, status, error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Emits `mail.draft.kept` the first time a person takes a plugin's draft over (an edit or a rewrite request): the plugin stops
 * counting on a newer draft to replace it (PAR-14558). `before` is the row as it was; never throws.
 */
export async function announceDraftKept(ctx: EventCtx, companyId: string, before: Pick<MessageRow, "id" | "draft">): Promise<void> {
  const requestKey = before.draft?.requestKey;
  const context = before.draft?.requestContext;
  if (!requestKey || !context || isKeptByPerson(before)) return;
  const event: MailDraftKept = { key: requestKey, mailboxDraftId: before.id, context };
  try {
    await ctx.events.emit(MAIL_EVENTS.draftKept, companyId, event as unknown as Record<string, unknown>);
  } catch (error) {
    ctx.logger.info("Draft kept event not emitted", { key: requestKey, error: error instanceof Error ? error.message : String(error) });
  }
}

export interface ClientRecipientStore {
  clientRecipients(companyId: string, emails: string[], domains: string[]): Promise<string[]>;
}

/**
 * An agent's `send-draft` on a held draft (PAR-12249; scope corrected by Peet, 16 Nov 2026: existing clients only).
 * - The hold is the draft's own, else the default for its purpose (a draft saved without one, by a person or before the
 *   default hold, is held unless its purpose is on the reply allow-list).
 * - No hold: nothing to check here.
 * - A recipient is a contact at, or shares a domain or billing email with, a company that is or was a customer: refused.
 * - The CRM lookup fails: refused (fail closed), with the reason. Unsure is never a send.
 * - No recipient matches a customer record (a prospect or lead): the hold does not apply, cold mail goes out.
 */
export async function assertHeldDraftMaySend(store: ClientRecipientStore, companyId: string, row: Pick<MessageRow, "draft" | "to_addrs" | "cc_addrs" | "bcc_addrs">): Promise<void> {
  const hold = row.draft?.holdForPerson ?? holdFor(cleanPurpose(row.draft?.purpose), false, row.draft?.replyToMessageId ?? null);
  if (!hold) return;
  const emails = [...new Set([...(row.to_addrs ?? []), ...(row.cc_addrs ?? []), ...(row.bcc_addrs ?? [])].map((a) => a.email.trim().toLowerCase()).filter(Boolean))];
  const domains = [...new Set(emails.map((e) => e.split("@")[1] ?? "").filter((d) => d && !isFreeMailDomain(d)))];
  let clients: string[];
  try {
    clients = await store.clientRecipients(companyId, emails, domains);
  } catch (error) {
    throw new MailboxError(`Not sent: this draft is held (${hold.reason}) and the CRM check of its recipients failed (${error instanceof Error ? error.message : String(error)}), so it cannot be shown that they are not clients. A person reads it in the Mailbox drafts and sends it.`);
  }
  if (clients.length) {
    throw new MailboxError(`Not sent: ${hold.reason} ${clients.join(", ")} ${clients.length === 1 ? "is" : "are"} an existing client in the CRM. Leave it in the drafts; do not send it.`);
  }
}
