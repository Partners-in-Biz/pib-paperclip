/**
 * What marks a record as the canary's (audit Q1b-2): pure, no database.
 *
 * The canary client is one internal test client the acceptance agent runs
 * the whole journey on (lead, qualify, quote, invoice, payment proof), so the
 * journey can be proven without a real client. It is flagged three ways, so
 * a missed check in one module cannot turn it into a real send:
 *
 * - its ids start with `canary-` (real ids are UUIDs, so they never do);
 * - its records carry `custom.canary = true` and the tag `canary`;
 * - its email addresses are on `canary.invalid`: the `.invalid` name can never
 *   exist (RFC 2606), so no mail system can deliver to it, whatever a module does.
 */
import { createHash } from "node:crypto";

export const CANARY_TAG = "canary";
export const CANARY_DOMAIN = "canary.invalid";
export const CANARY_PREFIX = "canary-";
export const CANARY_NAME = "PiB Canary Co";

function suffix(companyId: string): string {
  return createHash("sha256").update(companyId).digest("hex").slice(0, 8);
}

/** The canary company's record id in a Paperclip company: stable, so asking again finds it. */
export function canaryAccountId(companyId: string): string {
  return `${CANARY_PREFIX}${suffix(companyId)}`;
}

export function canaryContactId(companyId: string): string {
  return `${CANARY_PREFIX}contact-${suffix(companyId)}`;
}

export function canaryEmail(local = "canary"): string {
  return `${local.replace(/[^a-z0-9._-]/gi, "").toLowerCase() || "canary"}@${CANARY_DOMAIN}`;
}

export function isCanaryId(id: unknown): boolean {
  return typeof id === "string" && id.startsWith(CANARY_PREFIX);
}

/** True for an address no real person can have: it is on the canary domain, or on a name reserved for tests. */
export function isCanaryEmail(email: unknown): boolean {
  if (typeof email !== "string") return false;
  const domain = email.trim().toLowerCase().split("@").pop() ?? "";
  return domain === CANARY_DOMAIN || domain.endsWith(".invalid");
}

interface Flagged {
  id?: string;
  custom?: Record<string, unknown> | null;
  tags?: readonly string[] | null;
  emails?: readonly string[] | null;
}

/** A contact that must never be emailed for real: flagged, tagged, on a canary id, or with only canary addresses. */
export function isCanaryContact(contact: Flagged): boolean {
  if (contact.custom?.canary === true || isCanaryId(contact.id)) return true;
  if ((contact.tags ?? []).some((tag) => tag.toLowerCase() === CANARY_TAG)) return true;
  const emails = contact.emails ?? [];
  return emails.length > 0 && emails.every(isCanaryEmail);
}

export function isCanaryAccount(account: Flagged): boolean {
  return account.custom?.canary === true || isCanaryId(account.id) || (account.tags ?? []).some((tag) => tag.toLowerCase() === CANARY_TAG);
}

/** What the acceptance agent and every module must honour for the canary client. Said to the agent in the tool result and the skill. */
export const CANARY_RULES: readonly string[] = [
  "Everything outward for the canary client is a draft or a dry run: no email, SMS, post, ad, invoice or payment request reaches a real person.",
  "Its email addresses end in @canary.invalid, which no mail system can deliver to. Never put a real address on it.",
  "Approvals still happen: do the approval step as usual (the Reviewer, then a person where the module needs one), and say it is the canary in the request.",
  "Money in the canary journey is a test: a payment proof is a test row, never a real bank line.",
  "Clean up with cleanup-canary (confirm true) when the journey is done. It removes only the canary's own records.",
];
