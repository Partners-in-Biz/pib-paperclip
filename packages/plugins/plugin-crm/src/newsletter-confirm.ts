/**
 * The click on a newsletter confirmation link (intake `newsletter`, `action: "confirm"`; plan PAR-10817 "Confirm", steps 3 to 9).
 * The webhook in lead-capture.ts did steps 1 and 2 first: signed calls only, the confirm bucket `<source id>:confirm`.
 *
 * Only here does a subscriber become a contact: lifecycle `lead`, `custom.origin` `newsletter` (the lead counts leave it out), the
 * source's tags added in one statement, a `newsletter` consent record and a `newsletter_confirmed` activity. No issue, no lead
 * scoring, no speed-to-lead. Every step is safe to repeat, so two clicks at once, or a retry after an error, end in the same rows.
 */
import { createHash } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { consentSubjectKey, senderKeyOf } from "@partnersinbiz/pib-plugin-kit";
import { recordConsent } from "./consent.js";
import { addContactTags, contactsByEmail, insertActivityOnce, insertContactOnce } from "./db.js";
import { createContact, NEWSLETTER_ORIGIN } from "./domain.js";
import { leadCaptureKey } from "./lead-form.js";
import { confirmCapture, getConsent, type LeadSource } from "./lead-store.js";
import { verifyConfirmToken } from "./newsletter-token.js";

/** Confirm hits are logged under this id, never the source's own, so bad tokens cannot use up the signup cap. */
export const confirmBucket = (sourceId: string) => `${sourceId}:confirm`;
export const CONFIRM_RATE = { perMinute: 30, perHour: 200 } as const;

export type ConfirmOutcome = { ok: true; status: "confirmed" | "already_confirmed" } | { ok: false; reason: string };

/**
 * The id a new subscriber gets: a UUID made from the workspace and the address, so two clicks at the same moment insert one
 * contact (the second insert does nothing) instead of two.
 */
export function subscriberContactId(companyId: string, email: string): string {
  const hex = createHash("sha256").update(`crm-newsletter-contact:${companyId}:${email.trim().toLowerCase()}`).digest("hex");
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const hasAll = (have: readonly string[], want: readonly string[]) => {
  const lowered = new Set(have.map((tag) => tag.toLowerCase()));
  return want.every((tag) => lowered.has(tag.toLowerCase()));
};

/** Steps 3 to 9. `ipHash` names the visitor who clicked. A refusal changes nothing. */
export async function processConfirm(
  ctx: PluginContext,
  source: LeadSource,
  input: { token: unknown; now: Date; ipHash: string | null; salt: string },
): Promise<ConfirmOutcome> {
  const { companyId } = source;
  const consentText = source.consentText ?? "";
  // 3. Signature, source, age and the wording the person saw.
  const check = verifyConfirmToken({ id: source.id, confirmSecret: source.confirmSecret ?? "", consentText }, input.token, input.now.getTime());
  if (!check.ok) return { ok: false, reason: `token_${check.reason}` };
  const { email, pagePath, issuedAt } = check.claims;

  // 4. An address that asked not to be mailed (or bounced) stays as it is.
  const contacts = await contactsByEmail(ctx, companyId, email);
  if (contacts.some((contact) => contact.emailStatus === "unsubscribed" || contact.emailStatus === "bounced")) return { ok: false, reason: "suppressed" };

  const client = source.clientKind && source.clientRef ? { kind: source.clientKind, id: source.clientRef } : null;
  const existing = contacts[0] ?? null;
  // 9. Already tagged with consent on file: a second click changes nothing.
  if (existing && hasAll(existing.tags, source.applyTags)) {
    const senderKey = senderKeyOf(client ? { clientKind: client.kind, clientRef: client.id } : null);
    const consent = await getConsent(ctx, companyId, senderKey, consentSubjectKey({ email }) ?? "", "newsletter");
    if (consent?.granted) return { ok: true, status: "already_confirmed" };
  }

  // 5. New: a lead that the lead counts leave out, with only the source's tags. Existing: only the tags change (step 6).
  let contactId = existing?.id ?? null;
  if (!contactId) {
    const draft = createContact({ id: subscriberContactId(companyId, email), companyId, name: email, emails: [email], lifecycle: "lead", custom: { origin: NEWSLETTER_ORIGIN }, tags: [...source.applyTags] });
    await insertContactOnce(ctx, draft);
    contactId = draft.id;
  }
  // 6. One UPDATE that appends the missing tags, whoever owns the tags field.
  await addContactTags(ctx, companyId, contactId, source.applyTags);

  // 7. The consent the person gave by clicking: the wording of the source (the token proves it did not change).
  await recordConsent(ctx, {
    companyId,
    client,
    email,
    contactId,
    purpose: "newsletter",
    basis: "consent",
    granted: true,
    source: "form",
    wording: consentText,
    formId: source.id,
    url: pagePath,
    ipHash: input.ipHash,
    recordedAt: input.now.toISOString(),
  });

  // 8. The capture row of the signup, when it is still there, and one activity per link.
  await confirmCapture(ctx, companyId, leadCaptureKey(source.id, email, new Date(issuedAt), input.salt), contactId);
  await insertActivityOnce(ctx, {
    companyId,
    recordType: "contact",
    recordId: contactId,
    kind: "newsletter_confirmed",
    body: `Confirmed the newsletter signup on ${source.label}.`,
    sourceKey: `crm:nl-confirmed:${source.id}:${contactId}:${issuedAt}`,
    meta: { sourceId: source.id, pagePath },
  });
  return { ok: true, status: "confirmed" };
}
