import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";

const text = { type: "string" } satisfies JsonSchema;
function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

export const PARTNER_TOOLS: PluginToolDeclaration[] = [
  {
    name: "propose-link",
    displayName: "Propose partner link",
    description: "Propose a link with another Paperclip company. It stays pending until both accept.",
    parametersSchema: schema(["otherCompanyId"], { otherCompanyId: text }),
  },
  {
    name: "propose-grant",
    displayName: "Propose record grant",
    description: "Propose a named CRM record or invoice share. Do not copy the record.",
    parametersSchema: schema(["linkId", "recordType", "recordId", "granteeCompanyId"], {
      linkId: text,
      recordType: text,
      recordId: text,
      granteeCompanyId: text,
    }),
  },
];
