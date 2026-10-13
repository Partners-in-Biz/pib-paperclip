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
      "Browse approved WhatsApp message templates stored from Twilio. Filter by language (Afrikaans or English only). Templates are indexed by ID and show a preview of the message body.",
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
      "Fetch the current list of WhatsApp content templates from Twilio Content API, check their approval status, and update the local database. Templates outside the 24-hour marketing window require pre-approval by WhatsApp. Syncing may take up to a minute for many templates.",
    parametersSchema: schema([], {}),
  },
];
