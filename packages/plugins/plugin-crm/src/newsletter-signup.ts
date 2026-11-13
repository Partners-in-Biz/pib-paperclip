/**
 * A newsletter signup (intake `newsletter`, double opt-in; plan PAR-10817 "Signup", steps 4 to 7). The webhook in lead-capture.ts
 * did steps 1 to 3 first: signed calls only, the source bucket, the daily ceiling, the address checks and the settings check.
 *
 * A signup writes one capture row (outcome `pending_confirmation`, no contact) and queues one confirmation mail. It writes no
 * contact, tag, consent record or issue and runs no lead scoring: that waits for the click on the link (confirm, a later stage).
 * Every outcome here gives the caller the same answer, so it cannot learn who is on the list.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { enqueue, MAIL_EVENTS, type MailSendRequested } from "@partnersinbiz/pib-plugin-kit";
import { isCanaryEmail } from "./canary-flag.js";
import { contactsByEmail } from "./db.js";
import { textToHtml } from "./domain.js";
import { leadCaptureKey } from "./lead-form.js";
import { parseConfirmFrom, parseConfirmUrl } from "./lead-newsletter.js";
import { deleteCapture, insertCapture, type LeadSource } from "./lead-store.js";
import { PLUGIN_ID } from "./namespace.js";
import { confirmLink, MAX_PATH_BYTES, MIN_CONFIRM_SECRET_LENGTH, mintConfirmToken } from "./newsletter-token.js";

/** Outbox keys of confirmation mails: `crm:nl:<capture key>`. The send-result handler (a later stage) takes this prefix. */
export const SIGNUP_MAIL_PREFIX = "crm:nl:";
export const SIGNUP_SUBJECT = "Please confirm your subscription";
export const PENDING_CONFIRMATION = "pending_confirmation";

/** What a signup did, for the request log only; the caller always gets the same success. */
export type SignupOutcome = "pending_confirmation" | "suppressed" | "already_subscribed" | "duplicate" | "dry_run";

/**
 * The stored settings a send needs, checked again the way they are checked when the source is written: a value changed directly
 * in the database must not send mail from a stranger's address or link to a stranger's page.
 */
export function signupSettingsOk(source: LeadSource): boolean {
  try {
    return (
      parseConfirmUrl(source.confirmUrl, source.siteUrl) === source.confirmUrl &&
      parseConfirmFrom(source.confirmFrom) === source.confirmFrom &&
      typeof source.confirmSecret === "string" && source.confirmSecret.length >= MIN_CONFIRM_SECRET_LENGTH &&
      typeof source.consentText === "string" && source.consentText.length > 0
    );
  } catch {
    return false;
  }
}

/** The path of the page the visitor signed up on, as the token keeps it ("/" when none or not an address). */
export function signupPagePath(pageUrl: string | null): string {
  if (!pageUrl) return "/";
  try {
    // A parsed path is percent-encoded ASCII, so cutting it by characters stays within the byte limit.
    return new URL(pageUrl).pathname.slice(0, MAX_PATH_BYTES) || "/";
  } catch {
    return "/";
  }
}

/** The fixed confirmation text: nothing the visitor typed, no promotion, only the link. */
export function signupMailText(link: string): string {
  return [
    "Please confirm that you want to receive our newsletter.",
    `Confirm your subscription: ${link}`,
    "The link works for 7 days. If you did not ask for this, ignore this email: you will not be added to the list.",
  ].join("\n\n");
}

/** Lower-cased tags of a contact, to compare with the source's tags case-insensitively. */
const lowered = (tags: readonly string[]) => new Set(tags.map((tag) => tag.toLowerCase()));

/**
 * Steps 4 to 6. `email` passed the address checks. Throws only when the mail could not be queued: the capture row is then removed
 * again, so a retry sends.
 */
export async function processSignup(
  ctx: PluginContext,
  source: LeadSource,
  input: { email: string; pageUrl: string | null; attribution: Record<string, unknown>; now: Date; ipHash: string | null; salt: string },
): Promise<SignupOutcome> {
  const { companyId } = source;
  // 4. An address that asked not to be mailed, or one already on the list, gets nothing.
  const contacts = await contactsByEmail(ctx, companyId, input.email);
  if (contacts.some((contact) => contact.emailStatus === "unsubscribed" || contact.emailStatus === "bounced")) return "suppressed";
  if (contacts.some((contact) => { const have = lowered(contact.tags); return source.applyTags.every((tag) => have.has(tag.toLowerCase())); })) return "already_subscribed";

  // The link is made before anything is written, so a failure here leaves nothing behind.
  const token = mintConfirmToken(
    { id: source.id, confirmSecret: source.confirmSecret ?? "", consentText: source.consentText ?? "" },
    { email: input.email, pagePath: signupPagePath(input.pageUrl), issuedAt: input.now.getTime() },
  );
  const link = confirmLink(source.confirmUrl ?? "", token);

  // 5. One capture per address, source and day. Only the call whose insert wins sends: a concurrent or later signup the same day does not.
  const key = leadCaptureKey(source.id, input.email, input.now, input.salt);
  const client = source.clientKind && source.clientRef ? { kind: source.clientKind, id: source.clientRef } : null;
  const inserted = await insertCapture(ctx, { companyId, sourceId: source.id, key, outcome: PENDING_CONFIRMATION, contactId: null, client, attribution: input.attribution, consent: false, ipHash: input.ipHash });
  if (!inserted) return "duplicate";
  // The canary journey runs for real except that nothing leaves (as for every other CRM send).
  if (isCanaryEmail(input.email)) return "dry_run";

  // 6. One confirmation mail. Not marketing: it is the reply to the visitor's own request.
  const text = signupMailText(link);
  const payload: MailSendRequested = {
    key: `${SIGNUP_MAIL_PREFIX}${key}`,
    from: source.confirmFrom,
    fromName: source.label,
    to: [{ email: input.email, name: null }],
    subject: SIGNUP_SUBJECT,
    text,
    html: textToHtml(text),
    context: { plugin: PLUGIN_ID, kind: "client_message", id: key },
  };
  try {
    await enqueue(ctx, companyId, MAIL_EVENTS.sendRequested, payload as unknown as { key: string } & Record<string, unknown>);
  } catch (error) {
    await deleteCapture(ctx, companyId, key).catch((cleanup) =>
      ctx.logger.error("CRM newsletter signup: capture not removed after a failed send; this address gets no mail today", { sourceId: source.id, error: cleanup instanceof Error ? cleanup.message : String(cleanup) }),
    );
    throw error;
  }
  return PENDING_CONFIRMATION;
}
