/**
 * Data-subject erasure and consent for the Mailbox (Q10-13, POPIA).
 *
 * The CRM starts an approved erasure (`contact.erase.requested`, which carries
 * the approving person; the kit refuses one without). The Mailbox erases what it
 * holds about the address and answers with what it erased and what it keeps.
 *
 * Erased: every stored message to or from the address (headers, snippet,
 * triage, drafts), the decisions logged about them, the Reply-needed issues'
 * title and description (the issue stays, its text is replaced), the send
 * records' recipients and request bodies (the record stays so a repeated send
 * request is still refused as a duplicate), a lead that was waiting to reach the
 * CRM, and the Mailbox's copy of the CRM contact.
 *
 * Kept, and said so in the answer:
 * - **A do-not-email marker.** A one-way hash of the address (the same SHA-256
 *   the CRM's ledger keeps), no address, name or text. It stops every send to the
 *   person from now on, and the sync never imports their old mail again (mail
 *   received before the erasure is skipped; mail they send afterwards is a new
 *   message). This is the "never mail them again" record erasure has to leave.
 * - **Gmail itself.** The Mailbox may read, label and send but cannot delete mail
 *   permanently, and a thread can involve other people and the company's records,
 *   so the Gmail copies stay until a person deletes them there.
 * - **Agents' comments** on a Reply-needed issue (they live in the host).
 *
 * Safety: an address that belongs to one of the company's own mailboxes is
 * refused (it would erase the whole mailbox); the request is then reported
 * `failed`, stays open, and `staleErasuresCheck` makes it visible.
 *
 * `scope: marketing_only` (a withdrawn consent) erases nothing: it puts the
 * address on the marketing do-not-email list.
 *
 * Consent: a withdrawn marketing consent from another plugin
 * (`consent.recorded`, `granted: false`) puts the address on that sender's
 * marketing list. A given consent never removes anyone: a person who unsubscribed
 * is only mailed again when a person removes them.
 */
import {
  consentKey,
  consentSubjectKey,
  HANDOFF_EVENTS,
  senderKeyOf,
  type ConsentRecorded,
  type ContactEraseRequested,
  type EraseOutcome,
} from "@partnersinbiz/pib-plugin-kit";
import { errorMessage, type Env } from "./gmail/env.js";
import { erasureHash } from "./hash.js";
import { isValidEmail } from "./gmail/headers.js";
import { PLUGIN_ID } from "./namespace.js";

export const ERASED_TEXT = "[erased on request]";

export { erasureHash };

/** The addresses an erasure covers: the request's own and the contact's other addresses from the CRM copy. */
export async function subjectEmails(store: Pick<Env["store"], "crmContactEmails">, companyId: string, request: ContactEraseRequested): Promise<string[]> {
  const emails = new Set<string>();
  const given = request.subject.email?.trim().toLowerCase();
  if (given && isValidEmail(given)) emails.add(given);
  if (request.subject.contactId) for (const email of await store.crmContactEmails(companyId, request.subject.contactId)) if (isValidEmail(email)) emails.add(email.toLowerCase());
  return [...emails];
}

/**
 * Erases one person from the Mailbox's data (see the file header). `now` is for
 * tests. Returns what the kit's receiver sends back as the answer.
 */
export async function eraseSubject(env: Pick<Env, "ctx" | "store" | "now">, companyId: string, request: ContactEraseRequested): Promise<EraseOutcome> {
  const emails = await subjectEmails(env.store, companyId, request);
  if (emails.length === 0) {
    return { counts: {}, retained: request.subject.phone ? [{ what: "Nothing by phone number", why: "The Mailbox holds email only; there is no address to match." }] : [] };
  }
  const own = new Set((await env.store.listAccounts(companyId)).map((account) => account.address.toLowerCase()));
  const clash = emails.find((email) => own.has(email));
  if (clash) {
    return { counts: {}, errors: ["The address belongs to one of this company's own mailboxes. Erasing it would delete the whole mailbox, so nothing was erased. A person must decide how to handle this request."] };
  }

  if (request.scope === "marketing_only") {
    for (const email of emails) await env.store.upsertSuppression({ companyId, email, scope: "marketing", reason: "unsubscribed", source: PLUGIN_ID, detail: `Consent withdrawn (erasure request ${request.requestId})`, senderKey: "" });
    return { counts: { marketingSuppressions: emails.length }, retained: [] };
  }

  const errors: string[] = [];
  const messages = await env.store.messagesInvolving(companyId, emails);
  const ids = messages.map((message) => message.id);
  const threads = [...new Set(messages.map((message) => message.gmail_thread_id).filter((id): id is string => Boolean(id)))];

  // Reply-needed issues keep their place and history; the person's text goes.
  let issues = 0;
  for (const issueId of await env.store.threadIssueIds(companyId, threads)) {
    try {
      await env.ctx.issues.update(issueId, { title: `Reply needed: ${ERASED_TEXT}`, description: `The mail this issue was about was erased on request (data subject erasure ${request.requestId}).` }, companyId);
      issues += 1;
    } catch (error) {
      const text = errorMessage(error);
      if (!/not found|no such|does not exist/i.test(text)) errors.push(`reply issue ${issueId.slice(0, 8)}: ${text.slice(0, 120)}`);
    }
  }

  await env.store.deleteDecisionsFor(companyId, ids);
  const deleted = await env.store.deleteMessages(companyId, ids);
  const sendKeys = await env.store.sendKeysTo(companyId, emails);
  const sends = await env.store.redactSends(companyId, sendKeys);
  await env.store.scrubInboxResults(companyId, sendKeys);
  const handoffs = await env.store.deleteLeadOutbox(companyId, emails);
  const copies = await env.store.blankCrmProjection(companyId, request.subject.contactId ?? null, emails);

  let replaced = 0;
  for (const email of emails) replaced += (await env.store.eraseSuppression({ companyId, email, hash: erasureHash(email), scope: "all" })).replaced;

  const drafts = messages.filter((message) => message.direction === "outbound" && (message.status === "draft" || message.status === "queued")).length;
  const counts: Record<string, number> = { messages: Math.max(0, deleted - drafts), drafts, replyIssues: issues, sendRecords: sends, pendingLeads: handoffs, crmCopies: copies, doNotEmailRowsReplaced: replaced, doNotEmailMarkers: emails.length };
  const retained = [
    { what: "A do-not-email marker for each address (a one-way hash; no address, name or text)", why: "So the person is never emailed again and their old mail is not imported again." },
    ...(threads.length > 0 ? [{ what: `The Gmail copies of ${threads.length} conversation${threads.length === 1 ? "" : "s"} in the connected mailbox`, why: "The Mailbox cannot delete Gmail mail permanently and a conversation can involve other people and the company's records. A person deletes it in Gmail if there is no reason to keep it." }] : []),
    ...(issues > 0 ? [{ what: "Agents' comments on the Reply-needed issues", why: "They are held by Paperclip, not the Mailbox; only the issue title and description were replaced." }] : []),
  ];
  return { counts, retained, ...(errors.length ? { errors } : {}) };
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

const MARKETING_PURPOSES = new Set(["marketing_email", "newsletter"]);

/**
 * A consent record from another plugin. A withdrawal of marketing consent puts
 * the address on that sender's marketing list; everything else is ignored here
 * (the Mailbox sends only, and never un-suppresses on a "given" record).
 */
export async function onConsentRecorded(env: Pick<Env, "ctx" | "store">, companyId: string, consent: ConsentRecorded): Promise<void> {
  if (consent.granted || !MARKETING_PURPOSES.has(consent.purpose)) return;
  const email = consent.subject.email?.trim().toLowerCase();
  if (!email || !isValidEmail(email)) return;
  const senderKey = consent.subject.clientRef ? senderKeyOf({ clientKind: consent.subject.clientKind, clientRef: consent.subject.clientRef }) : "";
  await env.store.upsertSuppression({
    companyId,
    email,
    scope: "marketing",
    reason: "unsubscribed",
    source: consent.recordedBy || "consent.recorded",
    detail: `Consent withdrawn (${consent.source}, ${consent.recordedAt})`,
    senderKey,
  });
}

/** `consent.recorded` for an opt-out the Mailbox itself saw (a reply that says stop, or a one-click link). Never throws. */
export async function announceOptOut(env: Pick<Env, "ctx">, companyId: string, input: { email: string; senderKey: string; source: "reply" | "unsubscribe_link"; wording?: string | null; at?: string }): Promise<void> {
  const at = input.at ?? new Date().toISOString();
  const client = /^(company|contact):(.+)$/.exec(input.senderKey);
  const subject = { email: input.email, clientKind: client ? (client[1] as "company" | "contact") : null, clientRef: client ? client[2]! : null };
  const key = consentKey(subject, "marketing_email", at);
  if (!key || !consentSubjectKey(subject)) return;
  const payload: ConsentRecorded = { key, subject, purpose: "marketing_email", basis: "consent", granted: false, source: input.source, evidence: { wording: input.wording?.slice(0, 120) ?? null }, recordedAt: at, recordedBy: PLUGIN_ID };
  try {
    await env.ctx.events.emit(HANDOFF_EVENTS.consentRecorded, companyId, payload as unknown as Record<string, unknown>);
  } catch (error) {
    env.ctx.logger.info("consent.recorded emit failed", { error: errorMessage(error) });
  }
}
