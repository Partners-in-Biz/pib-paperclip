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
];
