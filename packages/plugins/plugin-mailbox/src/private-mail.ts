/**
 * Mail whose text must not outlive its send (0.6.1).
 *
 * The CRM sends a client a signing email (and a report, a feedback request, a sign-off) as `context.kind === "client_message"`. The
 * signing link in it is a bearer token: whoever holds it can sign for the client. The CRM keeps the email only until the Mailbox
 * answers, then blanks its own copy. This module is the Mailbox's half: for this kind of mail,
 *
 * - once the send has **settled** (sent, or failed for good) `send_requests.request` loses `text`, `html` and `attachments` (the
 *   attachment links are presigned). A **pending retry still needs the body** and keeps it. A send that never settled (the sender's outbox
 *   gives up after about three days and cannot tell the Mailbox) is scrubbed after `PRIVATE_STALE_DAYS`;
 * - the sent copy the Mailbox stores (`messages.snippet`) is empty, and `get-message`, `search-mail` and the inbox lists do not hand the
 *   text of such a message to anyone. What Gmail itself keeps in its own Sent folder is Google's and the Mailbox cannot edit it: it is
 *   why the Mailbox never lets an agent read it.
 *
 * Nothing here changes mail of any other kind.
 */
import type { MailSendRequested } from "@partnersinbiz/pib-plugin-kit";

/** The context kind of mail with a private link in it (the CRM's e-sign, reports, feedback and sign-off emails). */
export const PRIVATE_MAIL_KIND = "client_message";

/** A send nobody settled is scrubbed this long after it was asked for (the senders' outbox retries for about three days). */
export const PRIVATE_STALE_DAYS = 4;

/** The request fields that can hold the link, or a link that is a credential of its own (a presigned attachment address). */
export const PRIVATE_REQUEST_FIELDS = ["text", "html", "attachments"] as const;

export function isPrivateMail(context: { kind?: string | null } | null | undefined): boolean {
  return context?.kind === PRIVATE_MAIL_KIND;
}

/** The request as it may be kept once the send has settled. */
export function scrubbedRequest(request: MailSendRequested): MailSendRequested {
  const copy: Record<string, unknown> = { ...request };
  for (const field of PRIVATE_REQUEST_FIELDS) delete copy[field];
  return copy as unknown as MailSendRequested;
}

/** True when a stored private request has lost its body: a retry by hand cannot rebuild it. */
export function bodyIsGone(row: { context: { kind?: string | null } | null | undefined; request: Partial<MailSendRequested> | null | undefined }): boolean {
  return isPrivateMail(row.context) && !row.request?.text && !row.request?.html;
}

export const PRIVATE_BODY_NOTE = "This is a client message that may carry a private link (a signing link, a report). The Mailbox does not keep or show its text; ask the plugin that sent it.";

/** Why a retry by hand of a settled private send is refused. */
export const PRIVATE_RETRY_NOTE = "This client message's text is not kept once its send has ended, so it cannot be sent again from here. Send it again from the plugin that made it (the CRM issues a new message and, for a signing email, a new link).";
