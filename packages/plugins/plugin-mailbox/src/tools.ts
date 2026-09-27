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
      "The company's mail accounts: address, Gmail status, which one is the default sender, and your delegation on each (mayRead, mayDraft, maySend). Call it first to get an accountId.",
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
    name: "mail-status",
    displayName: "Mail send status",
    description: "Status of a send another plugin asked for, by its key: sending, sent, failed or retrying, with the Gmail ids, the error, and any recipients left out as suppressed.",
    parametersSchema: schema(["key"], { key: str("The send request key, e.g. billing:invoice:<id>:send.") }),
  },
];
