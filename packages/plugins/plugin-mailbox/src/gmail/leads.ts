/**
 * `lead.captured` for the CRM, from mail the Mailbox triaged as a lead.
 *
 * The Mailbox's own accounts are the company's own, so by default the lead is
 * the company's own lead: `clientKind` and `clientRef` stay empty (a client scope
 * would file it as that client's lead, with no follow-up) and the client triage
 * matched goes in `mentionsClient*`. A client mail mapping (`client-maps.ts`)
 * changes that for the mail it covers: the lead goes to the CRM in the client's
 * scope, and for a website form relayed by the client's own system the person is
 * the visitor in Reply-To, not the website.
 */
import type { LeadCaptured, MailAddress } from "@partnersinbiz/pib-plugin-kit";
import type { ClientMapRow, MessageRow } from "./types.js";

/** A lead worth handing to the CRM: triaged `lead`, a real sender, not bulk or phishing. */
export function isLeadCandidate(row: MessageRow): boolean {
  const triage = row.triage;
  if (row.direction !== "inbound" || !row.gmail_message_id) return false;
  if ((triage?.category ?? row.category) !== "lead") return false;
  if (row.bulk || row.bounce) return false;
  if ((triage?.phishing ?? Number(row.phishing ?? 0)) >= 0.9) return false;
  return Boolean(row.from_addr?.email);
}

/** The message in Gmail on the web, signed in as the mailbox that received it. */
export function gmailWebLink(accountAddress: string, gmailMessageId: string): string {
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(accountAddress)}#all/${encodeURIComponent(gmailMessageId)}`;
}

/**
 * `lead.captured` for the CRM, plus where the mail is: `messageId` (for
 * `get-message`), `accountId`, `threadId` and a Gmail link. `mentionsClient*`
 * is the client triage linked the mail to; it is not the lead's owner.
 */
export type MailLeadCaptured = LeadCaptured & {
  messageId: string;
  gmailMessageId: string | null;
  threadId: string | null;
  accountId: string;
  accountAddress: string | null;
  mentionsClientKind: "company" | "contact" | null;
  mentionsClientRef: string | null;
  mentionsClientName: string | null;
};

/** A mapping that filed the mail by who SENT it (the client's website or system), as opposed to who it was addressed to. */
export const bySender = (type: ClientMapRow["match_type"] | null | undefined): boolean => type === "sender_domain" || type === "sender_address";

/** The visitor behind relayed form mail: Reply-To when it is a different address from the sender. */
export function relayedPerson(row: Pick<MessageRow, "from_addr" | "reply_to_addr">): MailAddress | null {
  const reply = row.reply_to_addr;
  if (!reply?.email || reply.email.toLowerCase() === row.from_addr?.email?.toLowerCase()) return null;
  return reply;
}

/**
 * `lead.captured` for the CRM (`HANDOFF_EVENTS.leadCaptured`). With a client
 * mail `map` the lead is the client's (`clientKind`/`clientRef`), `source` is
 * `form` when the client's own system sent it, and the person is the visitor from
 * Reply-To (none when there is no Reply-To: the website's address is not a person).
 */
export function leadCapturedFrom(row: MessageRow, accountAddress: string | null = null, map: Pick<ClientMapRow, "match_type" | "client_kind" | "client_ref"> | null = null): MailLeadCaptured {
  const triage = row.triage;
  const subject = (row.subject ?? "").trim();
  const snippet = (row.snippet ?? "").trim();
  const text = subject && snippet ? `${subject}: ${snippet}` : subject || snippet;
  const mentionsKind = triage?.clientKind ?? (row.client_kind === "company" || row.client_kind === "contact" ? row.client_kind : null);
  const mentionsRef = triage?.clientRef ?? row.client_ref ?? null;
  const relayed = map ? bySender(map.match_type) : false;
  const person = relayed ? relayedPerson(row) : null;
  return {
    key: `mail:${row.gmail_message_id}`,
    source: relayed ? "form" : "email",
    name: relayed ? person?.name?.trim() || null : row.from_addr?.name?.trim() || null,
    email: relayed ? person?.email.toLowerCase() ?? null : row.from_addr?.email?.toLowerCase() ?? null,
    handle: null,
    platform: null,
    text: text.slice(0, 300),
    url: accountAddress && row.gmail_message_id ? gmailWebLink(accountAddress, row.gmail_message_id) : null,
    clientKind: map ? map.client_kind : null,
    clientRef: map ? map.client_ref : null,
    confidence: triage?.confidence ?? null,
    capturedAt: row.received_at ?? row.created_at,
    messageId: row.id,
    gmailMessageId: row.gmail_message_id,
    threadId: row.gmail_thread_id,
    accountId: row.account_id,
    accountAddress,
    mentionsClientKind: mentionsRef ? mentionsKind ?? "company" : null,
    mentionsClientRef: mentionsRef,
    mentionsClientName: mentionsRef ? triage?.clientName ?? null : null,
  };
}
