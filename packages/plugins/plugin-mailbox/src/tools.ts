import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";

const text = { type: "string" } satisfies JsonSchema;
function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

export const MAILBOX_TOOLS: PluginToolDeclaration[] = [
  {
    name: "create-draft",
    displayName: "Create mailbox draft",
    description: "Draft a message on a delegated mailbox. This does not send it.",
    parametersSchema: schema(["accountId", "subject"], { accountId: text, subject: text, body: text }),
  },
  {
    name: "send-draft",
    displayName: "Send mailbox draft",
    description: "Queue a draft for sending only when the delegation allows send.",
    parametersSchema: schema(["messageId"], { messageId: text }),
  },
  {
    name: "list-inbox",
    displayName: "List inbox",
    description: "Return the inbound messages for a mailbox, newest first.",
    parametersSchema: schema(["accountId"], { accountId: text, limit: { type: "integer" } }),
  },
  {
    name: "mark-read",
    displayName: "Mark message read",
    description: "Mark an inbound message as read.",
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
];
