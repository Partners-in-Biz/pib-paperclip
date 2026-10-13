import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import type { TelephonySettings, SecretStatus } from "./settings.js";

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

export const TELEPHONY_TOOLS: PluginToolDeclaration[] = [
  {
    name: "telephony-status",
    displayName: "Telephony settings and secrets status",
    description:
      "Read the current telephony configuration: call recording, SMS, WhatsApp settings, rate limits, allowed hours, configured caller IDs, and the status of each configured secret (set or missing). Secret values are never returned.",
    parametersSchema: schema([], {}),
  },
  {
    name: "whatsapp-templates",
    displayName: "WhatsApp message templates",
    description:
      "Browse approved WhatsApp message templates stored from Twilio. Filter by language (Afrikaans or English). Templates are indexed by ID and show a preview of the message body.",
    parametersSchema: schema([], {
      language: {
        type: "string",
        enum: ["af", "en"],
        description: "Filter to templates in Afrikaans (af) or English (en). Omit to show all languages.",
      },
    }),
  },
  {
    name: "whatsapp-sync-templates",
    displayName: "Sync WhatsApp templates from Twilio",
    description:
      "Fetch the current list of WhatsApp content templates from Twilio, check their approval status, and update the local database. Templates outside the 24-hour marketing window require pre-approval by WhatsApp. Syncing may take up to a minute for many templates.",
    parametersSchema: schema([], {}),
  },
  {
    name: "whatsapp-send",
    displayName: "Send a WhatsApp message",
    description:
      "Send a WhatsApp message to a contact via Twilio. Messages can be either service (transactional) or marketing. Service messages can be sent anytime; marketing messages require an approved template and can only be sent within the 24-hour customer response window. Use whatsapp-templates to pick a template ID.",
    parametersSchema: schema(["toE164"], {
      contactId: {
        type: "string",
        description: "UUID of the CRM contact to associate with this message.",
      },
      toE164: {
        type: "string",
        description: "Recipient phone number in E.164 format (e.g., +27xxxxxxxxx or +1xxxxxxxxxx).",
      },
      kind: {
        type: "string",
        enum: ["service", "marketing"],
        description: "Message category: service (transactional, anytime) or marketing (requires approved template and 24h window).",
      },
      body: {
        type: "string",
        description: "Plain text message body. Use this for service messages or simple text; omit if using templateId.",
      },
      templateId: {
        type: "string",
        description: "UUID of an approved WhatsApp template (from whatsapp-templates). Use for marketing messages or templated service messages.",
      },
      variables: {
        type: "array",
        items: { type: "string" },
        description: "Ordered list of template variable values if using templateId. Must match the template's variable count.",
      },
    }),
  },
];
