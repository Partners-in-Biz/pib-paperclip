import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import { MAIL_CATEGORIES } from "@partnersinbiz/pib-plugin-kit";

const text = { type: "string" } satisfies JsonSchema;
const addresses = { type: "array", items: { type: "string" }, description: "Addresses as a@b.com or Name <a@b.com>." } satisfies JsonSchema;
function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

export const MAILBOX_TOOLS: PluginToolDeclaration[] = [
  {
    name: "create-draft",
    displayName: "Create mailbox draft",
    description:
      "Draft a message on a delegated mailbox. This does not send it. Add `to` (and `replyToMessageId` to answer a message) so `send-draft` can send it.",
    parametersSchema: schema(["accountId", "subject"], {
      accountId: text,
      subject: text,
      body: { type: "string", description: "Plain-text body." },
      html: { type: "string", description: "Optional HTML body." },
      to: addresses,
      cc: addresses,
      bcc: addresses,
      replyToMessageId: { type: "string", description: "Mailbox message id (or Gmail id) this draft answers; keeps the Gmail thread." },
    }),
  },
  {
    name: "send-draft",
    displayName: "Send mailbox draft",
    description: "Send a draft through Gmail when the delegation allows sending. Without a connected Gmail account it is queued for a person instead.",
    parametersSchema: schema(["messageId"], { messageId: text }),
  },
  {
    name: "list-inbox",
    displayName: "List inbox",
    description: "Return the inbound messages for a mailbox, newest first, with triage (category, urgency, needs reply, client).",
    parametersSchema: schema(["accountId"], {
      accountId: text,
      limit: { type: "integer" },
      category: { type: "string", enum: [...MAIL_CATEGORIES] },
      needsReply: { type: "boolean" },
    }),
  },
  {
    name: "mark-read",
    displayName: "Mark message read",
    description: "Mark an inbound message as read (also in Gmail).",
    parametersSchema: schema(["messageId"], { messageId: text }),
  },
  {
    name: "create-email-template",
    displayName: "Create email template",
    description: "Save a reusable email template with a subject and body.",
    parametersSchema: schema(["name", "subject"], { name: text, subject: text, body: text }),
  },
  {
    name: "list-email-templates",
    displayName: "List email templates",
    description: "Return the saved email templates for this workspace.",
    parametersSchema: schema([], {}),
  },
  {
    name: "list-threads",
    displayName: "List threads",
    description: "Return the message threads for a mailbox (Gmail threads, else grouped by subject), newest first.",
    parametersSchema: schema([], {
      accountId: text,
      limit: { type: "integer" },
    }),
  },
  {
    name: "search-mail",
    displayName: "Search mail",
    description: "Search a delegated Gmail mailbox with a Gmail query (e.g. from:acme.com newer_than:30d has:attachment). Returns headers and snippets only.",
    parametersSchema: schema(["query"], {
      query: text,
      accountId: { type: "string", description: "Defaults to the first mailbox this agent may read." },
      limit: { type: "integer", description: "Up to 25." },
    }),
  },
  {
    name: "get-message",
    displayName: "Read a message",
    description: "Fetch one message's text from Gmail on demand (text only, truncated; attachments are listed, not downloaded).",
    parametersSchema: schema(["messageId"], {
      messageId: { type: "string", description: "Mailbox message id or Gmail message id." },
      maxChars: { type: "integer", description: "Default 8000, at most 50000." },
    }),
  },
  {
    name: "correct-triage",
    displayName: "Correct mail triage",
    description: "Fix a message's triage. The correction is logged for accuracy stats and the Gmail labels are updated.",
    parametersSchema: schema(["messageId"], {
      messageId: text,
      category: { type: "string", enum: [...MAIL_CATEGORIES] },
      urgency: { type: "integer", minimum: 0, maximum: 3, description: "0 can wait, 1 normal, 2 soon, 3 urgent." },
      needsReply: { type: "boolean" },
      client: { type: "string", description: "company:<crm id>, contact:<crm id>, or none." },
    }),
  },
  {
    name: "mail-status",
    displayName: "Mail send status",
    description: "Status of a send request another plugin made (by its key): sending, sent, failed or retrying, with the Gmail ids or the error.",
    parametersSchema: schema(["key"], { key: text }),
  },
];
