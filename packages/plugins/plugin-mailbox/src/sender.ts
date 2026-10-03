/**
 * Who a message is sent as (Q1a-3): the mailbox it goes from, the display name
 * and Reply-To, and whose do-not-email list applies. Pure functions.
 *
 * - A mailbox is the company's own (no client) or belongs to one client
 *   (`accounts.client_kind/client_ref`). Its client decides the **sender key**
 *   (kit `senderKeyOf`: `own`, `company:<id>`, `contact:<id>`), so an
 *   unsubscribe from a client's mailbox is that client's list and never silences
 *   the company's own marketing, and the other way round.
 * - A client's mailbox sends only that client's mail: a request whose context
 *   names another client (or none) is refused instead of going out as the
 *   client. The company's own mailbox keeps its old behaviour (any sender may
 *   use it): nothing changes for a company with no client mailbox.
 * - The request's `from` picks the mailbox. Without it the default account is
 *   used, and a client's mailbox is never the default.
 */
import { senderKeyOf, OWN_SENDER, type MailAddress, type MailSendRequested } from "@partnersinbiz/pib-plugin-kit";
import { toMailAddress } from "./gmail/headers.js";
import type { AccountRow } from "./gmail/types.js";

/** The sender key of a mailbox: the client it belongs to, else the company's own. */
export function accountSenderKey(account: Pick<AccountRow, "client_kind" | "client_ref">): string {
  return senderKeyOf({ clientKind: account.client_kind, clientRef: account.client_ref });
}

/** The client a request is for, as a sender key (from its context). */
export function requestSenderKey(request: Pick<MailSendRequested, "context">): string {
  return senderKeyOf({ clientKind: request.context?.clientKind, clientRef: request.context?.clientRef });
}

/**
 * Null when the request may be sent from this mailbox. A client's mailbox
 * refuses a request that is not for that client.
 */
export function accountScopeProblem(account: Pick<AccountRow, "address" | "client_kind" | "client_ref">, request: Pick<MailSendRequested, "context">): string | null {
  if (!account.client_ref) return null;
  const bound = accountSenderKey(account);
  if (requestSenderKey(request) === bound) return null;
  return `The mailbox ${account.address} belongs to a client (${bound}) and only sends that client's mail. This message is not for them, so it was not sent from there.`;
}

/**
 * A heads-up (never a block) for a client's marketing sent from one of the company's own mailboxes: the do-not-email list is per
 * sender and an opt-out is recorded for the mailbox's client, which here is the company, so the client's list would not hear of it.
 * Campaigns refuses to do this (kit `resolveSender`); the warning shows if anything else does.
 */
export function senderScopeWarnings(account: Pick<AccountRow, "address" | "client_ref">, request: Pick<MailSendRequested, "context" | "marketing">): string[] {
  if (request.marketing !== true || account.client_ref) return [];
  const wanted = requestSenderKey(request);
  if (wanted === OWN_SENDER) return [];
  return [`Marketing for ${wanted} was sent from the company's own mailbox ${account.address}: an opt-out is recorded on the company's list, not the client's. Send a client's marketing from the client's own mailbox.`];
}

/**
 * The context of a send made from a draft. A draft on a client's mailbox is that
 * client's mail, so its context says so (or the mailbox would refuse it).
 */
export function draftSendContext(account: Pick<AccountRow, "client_kind" | "client_ref">, draftId: string, plugin: string): MailSendRequested["context"] {
  return { plugin, kind: "draft", id: draftId, ...(account.client_ref ? { clientKind: account.client_kind, clientRef: account.client_ref } : {}) };
}

/** A display name that cannot break a header: one line, no angle brackets or quotes doing harm, at most 120 characters. */
export function cleanDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/[\r\n\t]+/g, " ").replace(/[<>]/g, "").replace(/\s{2,}/g, " ").trim().slice(0, 120);
  return name || null;
}

/** A Reply-To address (string or `{email, name}`), or null when it is missing; `invalid` when it is given but unusable. */
export function parseReplyTo(value: unknown): { address: MailAddress | null; invalid: boolean } {
  if (value == null || value === "") return { address: null, invalid: false };
  const address = toMailAddress(value);
  return address ? { address, invalid: false } : { address: null, invalid: true };
}

/** The Reply-To to put on a message: none when it is the sending address itself (nothing to redirect). */
export function effectiveReplyTo(replyTo: MailAddress | null | undefined, fromAddress: string): MailAddress | null {
  if (!replyTo?.email) return null;
  return replyTo.email.toLowerCase() === fromAddress.toLowerCase() ? null : replyTo;
}

/**
 * The longest https unsubscribe address accepted. The header line (`List-Unsubscribe: <https>, <mailto:...?subject=unsubscribe>`,
 * the mailto part up to about 285 characters) must stay under the 998-character line limit of RFC 5322, and is never folded.
 */
export const MAX_UNSUBSCRIBE_URL = 690;

/**
 * A usable one-click unsubscribe address (RFC 8058 needs https): the URL
 * itself, or null when it is missing; `invalid` when it is given but not an
 * https URL a header can carry (no spaces or control characters, within MAX_UNSUBSCRIBE_URL).
 */
export function parseUnsubscribeUrl(value: unknown): { url: string | null; invalid: boolean } {
  if (value == null || value === "") return { url: null, invalid: false };
  if (typeof value !== "string") return { url: null, invalid: true };
  const text = value.trim();
  if (text.length > MAX_UNSUBSCRIBE_URL || /[\s<>"\\\x00-\x1f\x7f]/.test(text)) return { url: null, invalid: true };
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "https:" || !parsed.hostname) return { url: null, invalid: true };
    // The normalised form is what goes in the header, and it can be longer than what was given.
    if (parsed.toString().length > MAX_UNSUBSCRIBE_URL) return { url: null, invalid: true };
    return { url: parsed.toString(), invalid: false };
  } catch {
    return { url: null, invalid: true };
  }
}

export { OWN_SENDER };
