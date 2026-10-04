import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import { MAIL_CATEGORIES } from "@partnersinbiz/pib-plugin-kit";

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

const str = (description: string): JsonSchema => ({ type: "string", description });
const addresses = (what: string): JsonSchema => ({ type: "array", items: { type: "string" }, description: `${what}: a@b.com or Name <a@b.com>.` });
const accountId = str("Mailbox account id from list-mailboxes.");
const messageId = str("Mailbox message id (from list-inbox, get-message or an issue) or the Gmail message id.");
const limit = (max: number, fallback: number): JsonSchema => ({ type: "integer", minimum: 1, maximum: max, description: `How many to return (default ${fallback}, at most ${max}).` });
const category = { type: "string", enum: [...MAIL_CATEGORIES], description: "Triage category." } satisfies JsonSchema;

export const MAILBOX_TOOLS: PluginToolDeclaration[] = [
  {
    name: "list-mailboxes",
    displayName: "List mailboxes",
    description:
      "The company's mail accounts: address, Gmail status, which one is the default sender, the client a mailbox belongs to (if any), and your delegation on each (mayRead, mayDraft, maySend). A mailbox you have no access on carries askToOwner: pass it to partnersinbiz.cockpit:ask-owner once and a yes grants the access by itself. Call it first to get an accountId.",
    parametersSchema: schema([], {}),
  },
  {
    name: "create-draft",
    displayName: "Create mailbox draft",
    description:
      "Draft a message on a mailbox you may draft on. It does not send. Add to (and replyToMessageId to answer a message) so send-draft can send it.",
    parametersSchema: schema(["accountId", "subject"], {
      accountId,
      subject: str("Subject line. Replies usually keep the original with Re:."),
      body: str("Plain-text body. Say who we are; never paste passwords or secrets."),
      html: str("Optional HTML body; the plain body stays as the text version."),
      to: addresses("Recipients"),
      cc: addresses("Copy"),
      bcc: addresses("Blind copy"),
      replyToMessageId: str("The message this answers (mailbox or Gmail id); keeps the Gmail thread."),
      replyTo: str("Where replies should go when it is not the mailbox itself (a client's address): a@b.com or Name <a@b.com>."),
      fromName: str("Display name for From (a client's name when drafting for them). Default: the mailbox's own name."),
    }),
  },
  {
    name: "send-draft",
    displayName: "Send mailbox draft",
    description:
      "Send a draft through Gmail when your delegation allows sending (maySend). Without a connected Gmail account it is queued for a person. Addresses on the do-not-email list are left out.",
    parametersSchema: schema(["messageId"], { messageId: str("The draft's id from create-draft.") }),
  },
  {
    name: "list-inbox",
    displayName: "List inbox",
    description: "Inbound messages for a mailbox, newest first, with triage (category, urgency, needs reply, client) and attachment ids.",
    parametersSchema: schema(["accountId"], {
      accountId,
      limit: limit(500, 50),
      category,
      needsReply: { type: "boolean", description: "True: only mail that likely needs a reply." },
    }),
  },
  {
    name: "mark-read",
    displayName: "Mark message read",
    description: "Mark an inbound message as read (also in Gmail).",
    parametersSchema: schema(["messageId"], { messageId }),
  },
  {
    name: "create-email-template",
    displayName: "Create email template",
    description: "Save reusable email copy (subject and body).",
    parametersSchema: schema(["name", "subject"], {
      name: str("Template name."),
      subject: str("Subject line."),
      body: str("Plain-text body."),
    }),
  },
  {
    name: "list-email-templates",
    displayName: "List email templates",
    description: "The saved email templates (id, name, subject, body).",
    parametersSchema: schema([], {}),
  },
  {
    name: "list-threads",
    displayName: "List threads",
    description: "Message threads (Gmail threads, else grouped by subject), newest first. Without accountId: every mailbox you may read.",
    parametersSchema: schema([], {
      accountId: str("Mailbox account id from list-mailboxes. Omit for every mailbox you may read."),
      limit: limit(500, 50),
    }),
  },
  {
    name: "search-mail",
    displayName: "Search mail",
    description: "Search a Gmail mailbox with a Gmail query (e.g. from:acme.com newer_than:30d has:attachment). Headers and snippets only; read one with get-message.",
    parametersSchema: schema(["query"], {
      query: str("Gmail search query."),
      accountId: str("Mailbox account id. Default: the first mailbox you may read."),
      limit: limit(25, 10),
    }),
  },
  {
    name: "get-message",
    displayName: "Read a message",
    description: "One message's text from Gmail on demand (text only, truncated), with its attachments (attachmentId, filename, type, size) and triage.",
    parametersSchema: schema(["messageId"], {
      messageId,
      maxChars: { type: "integer", minimum: 200, maximum: 50000, description: "Longest text to return (default 8000)." },
    }),
  },
  {
    name: "get-attachment",
    displayName: "Get an attachment",
    description:
      "Fetch one attachment: filename, mime, bytes and an https url valid 15 minutes (private storage). Statement files (CSV, OFX, QIF, TXT, MT940) up to 200 KB also come back as text. The result feeds partnersinbiz.accounting:import-statement: text as content, or the url.",
    parametersSchema: schema(["messageId", "attachmentId"], {
      messageId,
      attachmentId: str("attachmentId from get-message, list-inbox or the Bank statement received issue."),
      account: str("The mailbox (account id or address) when several are connected. Omit to find it from the message id."),
    }),
  },
  {
    name: "correct-triage",
    displayName: "Correct mail triage",
    description: "Fix a message's triage. The correction is logged for accuracy stats and the Gmail labels are updated.",
    parametersSchema: schema(["messageId"], {
      messageId,
      category,
      urgency: { type: "integer", minimum: 0, maximum: 3, description: "0 can wait, 1 normal, 2 soon, 3 urgent." },
      needsReply: { type: "boolean", description: "Whether it needs a written reply from us." },
      client: str("company:<crm id>, contact:<crm id>, or none."),
    }),
  },
  {
    name: "check-sender-domain",
    displayName: "Check a sender domain",
    description:
      "Reads the DNS of a domain mail is sent from (public DNS, nothing is changed): MX, SPF with its lookup count, DKIM at the usual selectors, DMARC. Returns healthy, warn or bad with each problem and its fix, sendReady, and the exact records to add for a new client domain (onboarding). A domain at the email provider is judged on the provider's records and its status at the provider is read again first. DNS is edited by the person who controls the domain: hand them the steps with one partnersinbiz.cockpit:ask-owner, then check again. By default the domain is also watched every day.",
    parametersSchema: schema([], {
      domain: str("The domain to check, e.g. client.co.za (or use address)."),
      address: str("A sender address; its domain is checked."),
      selectors: str("Extra DKIM selectors to try, comma separated (e.g. mailer1, brevo). The usual ones are always tried."),
      watch: { type: "boolean", description: "Keep checking this domain every day and report problems on the Cockpit (default true)." },
      clientKind: { type: "string", enum: ["company", "contact"], description: "With clientRef: the client this domain belongs to (kept with the check)." },
      clientRef: str("The CRM id of that client."),
    }),
  },
  {
    name: "add-sending-domain",
    displayName: "Add a sending domain",
    description:
      "Lets mail go out as a client's own domain through the email provider (Resend), beside Gmail. Registers the domain at the provider, creates its send-only account (a From address, with a reply-to somebody reads) and returns the EXACT DNS records to add, in order, and who adds them. DNS is edited by the owner, or the client or their web host, never by an agent: put the steps in ONE partnersinbiz.cockpit:ask-owner, wait, then run check-sender-domain. Marketing from the domain is held to a daily cap that ramps up for the first 13 days. Needs the provider switched on and its API key saved (the Setup item Email provider); without them it says what the owner must do. Use a subdomain (updates.client.co.za): it keeps the client's reputation apart from their main mail. Calling it again for the same domain only returns where it stands.",
    parametersSchema: schema(["domain"], {
      domain: str("The domain to send as, e.g. updates.client.co.za."),
      fromAddress: str("The From address, on that domain. Default hello@<domain>."),
      fromName: str("The name shown as the sender, e.g. the client's name. Default: the client's name from the CRM."),
      replyTo: str("Where replies go: an address somebody reads, usually the client's own. A send-only address has no inbox, so without one replies are lost."),
      clientKind: { type: "string", enum: ["company", "contact"], description: "With clientRef: the client this domain sends for. The domain then sends only that client's mail, with that client's do-not-email list." },
      clientRef: str("The CRM id of that client (find it with partnersinbiz.crm:find-records). Leave out for the company's own domain."),
      region: { type: "string", enum: ["us-east-1", "eu-west-1", "sa-east-1", "ap-northeast-1"], description: "The provider's region for the domain (default us-east-1). It cannot be changed later." },
    }),
  },
  {
    name: "list-sending-domains",
    displayName: "List sending domains",
    description:
      "The company's domains at the email provider: status (not_started, pending, verified, failed), whether mail may go out now, the send-only account, the records still to add, today's cap and warm-up day (and what is left of it), and the last 7 days' bounce and complaint rates against the limits (2% and 0.1%). refresh: true asks the provider to look at the DNS again first (at most every 6 hours per domain; the Mailbox also does it every hour).",
    parametersSchema: schema([], {
      domain: str("One domain. Omit for every sending domain."),
      refresh: { type: "boolean", description: "Ask the provider to verify the DNS again before answering." },
    }),
  },
  {
    name: "sender-domain-health",
    displayName: "Sender domain health",
    description:
      "The last stored check of each sending domain (no DNS lookup): status, healthy, sendReady (SPF, DKIM and DMARC in place), problems and when it was checked. Use it before launching a campaign from a domain: it must be healthy. Nothing is blocked by this; the caller decides.",
    parametersSchema: schema([], { domain: str("One domain or an address at it. Omit for every sending domain of the company.") }),
  },
  {
    name: "map-client-mail",
    displayName: "Map client mail",
    description:
      "Say that mail from or to a domain or address belongs to a client (a website form relayed by the client's host, a BCC copy, an alias we forward). Such mail is then filed under the client and its leads go to the CRM in the client's scope, with the visitor as the person. Find the client with partnersinbiz.crm:find-records first. Flagged mail of the last 30 days is filed too. list-client-mail-maps shows mail waiting for a mapping.",
    parametersSchema: schema(["matchType", "pattern", "clientKind", "clientRef"], {
      matchType: { type: "string", enum: ["sender_domain", "sender_address", "recipient_domain", "recipient_address"], description: "sender_*: mail FROM the client's site or system. recipient_*: mail TO the client's address or an alias we forward." },
      pattern: str("A domain (ahslaw.co.za) or an exact address, matching matchType. Never your own domain or a free mail domain."),
      clientKind: { type: "string", enum: ["company", "contact"], description: "company or contact." },
      clientRef: str("The CRM id of the client."),
      note: str("Optional: why (e.g. the AHS Law website form)."),
    }),
  },
  {
    name: "list-client-mail-maps",
    displayName: "List client mail mappings",
    description: "The client mail mappings, and the sender domains of mail that looks like a client's but has no mapping yet (last 30 days, with a sample messageId to read with get-message). Map those with map-client-mail.",
    parametersSchema: schema([], {}),
  },
  {
    name: "remove-client-mail-map",
    displayName: "Remove a client mail mapping",
    description: "Delete a mapping. Mail already filed keeps its client; new mail from that sender is the company's own again.",
    parametersSchema: schema(["mapId"], { mapId: str("The mapping id from list-client-mail-maps.") }),
  },
  {
    name: "mail-status",
    displayName: "Mail send status",
    description: "Status of a send another plugin asked for, by its key: sending, sent, failed or retrying, with the Gmail or provider ids, the error, any recipients left out as suppressed, and, for mail the email provider took, what happened to it afterwards (delivered, delayed, bounced, complained).",
    parametersSchema: schema(["key"], { key: str("The send request key, e.g. billing:invoice:<id>:send.") }),
  },
];
