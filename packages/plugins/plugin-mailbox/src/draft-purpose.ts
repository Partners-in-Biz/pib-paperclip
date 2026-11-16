/**
 * One open draft per client and purpose, and drafts only a person may send (PAR-12249).
 *
 * - `purposeKey` names client + purpose. A newer draft with the same key on the same mailbox replaces the older open one.
 * - `purpose` is what the mail is for. The kinds below are mail the client did not ask for: the draft is marked
 *   `holdForPerson` and an agent's `send-draft` is refused. The simplest marker: the drafting agent passes `purpose`
 *   (or `unasked: true`) to `create-draft`. A person sends it from the Mailbox page.
 */
import type { MailAddress } from "@partnersinbiz/pib-plugin-kit";
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

export const HOLD_REASON_UNASKED = "Mail an existing client did not ask for (an idea, proposal, upsell, referral or review ask) is never sent by an agent. A person reads it in the Mailbox drafts and sends it.";
export const HOLD_REASON_PLUGIN = "A plugin made this draft for a person to read and send. An agent does not send it.";

export function cleanPurpose(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 60);
  return v || null;
}

/** The hold for a draft, or null when an agent may send it (when its delegation allows). */
export function holdFor(purpose: string | null, unasked: boolean): { reason: string } | null {
  if (unasked || (purpose && UNASKED_PURPOSES.has(purpose))) return { reason: HOLD_REASON_UNASKED };
  return null;
}

/** `purpose:recipient` unless the caller passed its own key. Null when there is neither. */
export function purposeKeyFor(explicit: unknown, purpose: string | null, to: MailAddress[]): string | null {
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim().slice(0, 300);
  const first = to[0]?.email?.trim().toLowerCase();
  return purpose && first ? `${purpose}:${first}` : null;
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

export interface ClientRecipientStore {
  clientRecipients(companyId: string, emails: string[], domains: string[]): Promise<string[]>;
}

/**
 * An agent's `send-draft` on a held draft (PAR-12249; scope corrected by Peet, 16 Nov 2026: existing clients only).
 * - No hold: nothing to check here.
 * - A recipient is a contact at, or shares a domain or billing email with, a company that is or was a customer: refused.
 * - The CRM lookup fails: refused (fail closed), with the reason. Unsure is never a send.
 * - No recipient matches a customer record (a prospect or lead): the hold does not apply, cold mail goes out.
 */
export async function assertHeldDraftMaySend(store: ClientRecipientStore, companyId: string, row: Pick<MessageRow, "draft" | "to_addrs" | "cc_addrs" | "bcc_addrs">): Promise<void> {
  const hold = row.draft?.holdForPerson;
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
