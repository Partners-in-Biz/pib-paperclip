/**
 * One open draft per client and purpose, and drafts only a person may send (PAR-12249).
 *
 * - `purposeKey` names client + purpose. A newer draft with the same key on the same mailbox replaces the older open one.
 *   An agent's key is always in that agent's own namespace (`agent:<id>:`), so it never reaches another agent's or a plugin's draft.
 * - `purpose` is what the mail is for. Every agent draft is held for a person (`holdForPerson`) unless its purpose is one the
 *   client asked for (REPLY_PURPOSES: reply, followup, invoice) and it is not marked `unasked`. No purpose means held (PAR-1558:
 *   unasked client mail waits for a person). A held draft is refused to an agent's `send-draft` when a recipient is an existing
 *   client; a person sends it from the Mailbox page.
 */
import { MAIL_EVENTS, type MailAddress, type MailDraftClosed } from "@partnersinbiz/pib-plugin-kit";
import { MailboxError } from "./domain.js";
import { isFreeMailDomain } from "./free-mail.js";
import type { DraftExtras, MessageRow } from "./gmail/types.js";

/** Purposes that are mail the client did not ask for. Matched case-insensitively. */
export const UNASKED_PURPOSES = new Set([
  "upsell",
  "cross-sell",
  "proposal",
  "offer",
  "outreach",
  "referral",
  "review-ask",
  "testimonial-ask",
  "promotion",
  "newsletter",
  "idea",
  "unasked",
]);

export const HOLD_REASON_UNASKED = "Mail an existing client did not ask for (an idea, proposal, upsell, referral or review ask, or a draft with no purpose) is never sent by an agent. A person reads it in the Mailbox drafts and sends it.";
export const HOLD_REASON_PLUGIN = "A plugin made this draft for a person to read and send. An agent does not send it to an existing client.";

export function cleanPurpose(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 60);
  return v || null;
}

/** Mail the client asked for: the only purposes an agent's draft to an existing client may be sent with by the agent itself. */
export const REPLY_PURPOSES = new Set(["reply", "followup", "follow-up", "invoice"]);

/**
 * The hold for an agent's draft, or null when the agent may send it (when its delegation allows). Default hold: only a purpose
 * on the reply allow-list, not marked unasked, goes without one. An untagged draft is held (PAR-1558).
 */
export function holdFor(purpose: string | null, unasked: boolean): { reason: string } | null {
  if (!unasked && purpose && REPLY_PURPOSES.has(purpose)) return null;
  return { reason: HOLD_REASON_UNASKED };
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

/** After `keepId` was saved: removes the older open drafts with the same key. Returns their ids. */
export async function replaceOlderDrafts(store: PurposeDraftStore, companyId: string, accountId: string, purposeKey: string, keepId: string): Promise<string[]> {
  const removed: string[] = [];
  for (const row of await store.draftsByPurpose(companyId, accountId, purposeKey)) {
    if (row.id === keepId) continue;
    // A draft a person edited or asked to have rewritten holds their work: it stays, they decide (PAR-12249).
    if (row.draft?.rewrite || row.draft?.editedByPerson || row.draft?.by?.kind === "user") continue;
    if (await store.deleteDraft(companyId, row.id)) removed.push(row.id);
  }
  return removed;
}

/**
 * `replaceOlderDrafts` after the new draft is saved, never failing: the new draft is stored, so an error here must not make
 * the caller report a failure (a retry would then save a second copy). The older drafts stay until the next replacement.
 */
export async function replaceOlderDraftsSafely(store: PurposeDraftStore, companyId: string, accountId: string, purposeKey: string, keepId: string, log: (message: string, meta: Record<string, unknown>) => void): Promise<string[]> {
  try {
    return await replaceOlderDrafts(store, companyId, accountId, purposeKey, keepId);
  } catch (error) {
    log("Older drafts not replaced", { purposeKey, keepId, error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

/** A plugin's draft was sent or deleted: the event that tells the plugin (null for a draft no plugin asked for). */
export function draftClosedEvent(row: Pick<MessageRow, "id" | "draft">, status: MailDraftClosed["status"]): MailDraftClosed | null {
  const requestKey = row.draft?.requestKey;
  const context = row.draft?.requestContext;
  if (!requestKey || !context) return null;
  return { key: requestKey, status, mailboxDraftId: row.id, context };
}

/** Emits `mail.draft.closed` for a plugin's draft; never throws (the send or delete already happened). */
export async function announceDraftClosed(ctx: { events: { emit: (name: string, companyId: string, payload: Record<string, unknown>) => Promise<void> }; logger: { info: (message: string, meta?: Record<string, unknown>) => void } }, companyId: string, row: Pick<MessageRow, "id" | "draft">, status: MailDraftClosed["status"]): Promise<void> {
  const event = draftClosedEvent(row, status);
  if (!event) return;
  try {
    await ctx.events.emit(MAIL_EVENTS.draftClosed, companyId, event as unknown as Record<string, unknown>);
  } catch (error) {
    ctx.logger.info("Draft closed event not emitted", { key: event.key, status, error: error instanceof Error ? error.message : String(error) });
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
  const hold = row.draft?.holdForPerson ?? holdFor(cleanPurpose(row.draft?.purpose), false);
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
