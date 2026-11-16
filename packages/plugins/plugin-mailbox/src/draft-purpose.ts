/**
 * One open draft per client and purpose, and drafts only a person may send (PAR-12249).
 *
 * - `purposeKey` names client + purpose. A newer draft with the same key on the same mailbox replaces the older open one.
 * - `purpose` is what the mail is for. The kinds below are mail the client did not ask for: the draft is marked
 *   `holdForPerson` and an agent's `send-draft` is refused. The simplest marker: the drafting agent passes `purpose`
 *   (or `unasked: true`) to `create-draft`. A person sends it from the Mailbox page.
 */
import type { MailAddress } from "@partnersinbiz/pib-plugin-kit";
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

export const HOLD_REASON_UNASKED = "Mail the client did not ask for (upsell, proposal, outreach, referral or review ask) is never sent by an agent. A person reads it in the Mailbox drafts and sends it.";
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
    if (await store.deleteDraft(companyId, row.id)) removed.push(row.id);
  }
  return removed;
}

export function heldDraftError(extras: DraftExtras | null | undefined): string | null {
  const hold = extras?.holdForPerson;
  return hold ? `Not sent: ${hold.reason} Leave it in the drafts; do not send it.` : null;
}
