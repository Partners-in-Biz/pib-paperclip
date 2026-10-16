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
];
