/**
 * Who a marketing email is sent as, and whose do-not-email list applies (Q1a-3).
 *
 * The gaps this closes the contract for (the Campaigns and Mailbox builders
 * implement them):
 * - Campaigns saved `fromName`, `fromLocal` and `replyTo` for a campaign, showed
 *   them to the approver, then discarded them: the mail went out from the
 *   Mailbox default account (PiB's own Gmail) with no Reply-To. `resolveSender`
 *   picks a client's identity and REFUSES to fall back to the default account
 *   for a client's mail; `mailSenderFields` carries the identity on the send
 *   request (`MailSendRequested.from/fromName/replyTo/unsubscribeUrl`).
 * - Suppression was company-wide with no client dimension, so a client's
 *   unsubscribe silenced PiB's own marketing and every other client's.
 *   `senderKeyOf` names the list (`own`, `company:<id>`, `contact:<id>`) and
 *   `suppressionBlocks` applies it: an unsubscribe or complaint is per sender; a
 *   hard bounce (`scope: "all"`) is per address and blocks every sender. A row
 *   with no `senderKey` (written before kit 0.2) keeps blocking everyone's
 *   marketing: never emails someone who opted out.
 * - Unsubscribe was mailto-only. `signUnsubscribeToken` / `verifyUnsubscribeToken`
 *   make a link token both sides understand (Campaigns puts it in the email,
 *   the Mailbox verifies it on a public webhook and announces `contact.suppressed`).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { MailAddress } from "./contracts.js";
import { suppressionEmail, type SuppressionReason } from "./cockpit.js";

/** The sender key for PiB's own marketing (no client). */
export const OWN_SENDER = "own";

/** The list a send or an opt-out belongs to: `own`, `company:<id>` or `contact:<id>`. */
export function senderKeyOf(scope: { clientKind?: string | null; clientRef?: string | null } | null | undefined): string {
  const ref = scope?.clientRef?.trim();
  if (!ref) return OWN_SENDER;
  return `${scope?.clientKind === "contact" ? "contact" : "company"}:${ref}`;
}

/** The dedupe key of a suppression announcement: the old `suppress:<email>:<reason>` for own, with the sender appended for a client's. */
export function suppressionKey(email: string, reason: SuppressionReason, senderKey: string = OWN_SENDER): string {
  const base = `suppress:${suppressionEmail(email)}:${reason}`;
  return senderKey === OWN_SENDER ? base : `${base}:${senderKey}`;
}

export interface SuppressionRowLike {
  scope: "marketing" | "all";
  /** Absent on rows from before kit 0.2: company-wide. */
  senderKey?: string | null;
}

/**
 * True when this suppression stops this send. `all` (a hard bounce) stops every
 * send. A marketing suppression stops marketing sends from the same sender, and
 * from every sender when the row has no sender (legacy). A transactional send
 * (`marketing: false`) is only stopped by `all`.
 */
export function suppressionBlocks(row: SuppressionRowLike, send: { marketing: boolean; senderKey?: string | null }): boolean {
  if (row.scope === "all") return true;
  if (!send.marketing) return false;
  return !row.senderKey || row.senderKey === (send.senderKey ?? OWN_SENDER);
}

// ---------------------------------------------------------------------------
// Sender identities
// ---------------------------------------------------------------------------

export interface SenderIdentity {
  /** Which list this identity sends for (`senderKeyOf`). */
  senderKey: string;
  /** The Mailbox account address to send from (a client's own connected Gmail). */
  fromAddress: string;
  fromName?: string | null;
  replyTo?: string | null;
}

export type SenderResolution =
  | { ok: true; identity: SenderIdentity | null; senderKey: string }
  | { ok: false; senderKey: string; error: string };

/**
 * The identity a send uses. Own marketing may use the default account (`identity`
 * null) when no own identity is set. A client's marketing needs that client's
 * identity: with none, the send is refused rather than going out as PiB's own
 * Gmail, which is what Campaigns did.
 */
export function resolveSender(identities: SenderIdentity[], scope: { clientKind?: string | null; clientRef?: string | null } | null | undefined): SenderResolution {
  const senderKey = senderKeyOf(scope);
  const identity = identities.find((entry) => entry.senderKey === senderKey) ?? null;
  if (identity || senderKey === OWN_SENDER) return { ok: true, identity, senderKey };
  return { ok: false, senderKey, error: `No sender is set up for ${senderKey}. Connect the client's mailbox (or set a From address and reply-to for them) before sending their email; it will not go out from the default account.` };
}

/** The send-request fields an identity sets. */
export function mailSenderFields(identity: SenderIdentity | null, extra: { unsubscribeUrl?: string | null } = {}): { from?: string; fromName?: string; replyTo?: MailAddress; unsubscribeUrl?: string } {
  return {
    ...(identity?.fromAddress ? { from: identity.fromAddress } : {}),
    ...(identity?.fromName ? { fromName: identity.fromName } : {}),
    ...(identity?.replyTo ? { replyTo: { email: identity.replyTo } } : {}),
    ...(extra.unsubscribeUrl ? { unsubscribeUrl: extra.unsubscribeUrl } : {}),
  };
}

// ---------------------------------------------------------------------------
// One-click unsubscribe tokens
// ---------------------------------------------------------------------------

export interface UnsubscribePayload {
  companyId: string;
  email: string;
  senderKey: string;
}

function b64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function sign(body: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(body).digest());
}

/** A token for a link in the email. Needs a secret of at least 16 characters. */
export function signUnsubscribeToken(payload: UnsubscribePayload, secret: string): string {
  if (secret.length < 16) throw new Error("The unsubscribe secret is too short (16 characters at least).");
  const body = b64url(Buffer.from(JSON.stringify({ c: payload.companyId, e: suppressionEmail(payload.email), s: payload.senderKey })));
  return `${body}.${sign(body, secret)}`;
}

/** The payload from a token, or null when it was not signed with this secret or is malformed. */
export function verifyUnsubscribeToken(token: string, secret: string): UnsubscribePayload | null {
  const at = token.indexOf(".");
  if (at <= 0 || secret.length < 16) return null;
  const body = token.slice(0, at);
  const given = Buffer.from(token.slice(at + 1), "base64url");
  const expected = Buffer.from(sign(body, secret), "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { c?: unknown; e?: unknown; s?: unknown };
    if (typeof value.c !== "string" || typeof value.e !== "string" || !value.e.includes("@")) return null;
    return { companyId: value.c, email: value.e, senderKey: typeof value.s === "string" && value.s ? value.s : OWN_SENDER };
  } catch {
    return null;
  }
}
