import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

const str = (description: string): JsonSchema => ({ type: "string", description });

const recordType = {
  type: "string",
  enum: ["contact", "company", "deal", "invoice"],
  description: "What is shared: a CRM contact, company or deal, or a Billing invoice.",
} satisfies JsonSchema;

export const PARTNER_TOOLS: PluginToolDeclaration[] = [
  {
    name: "list-links",
    displayName: "List partner links",
    description:
      "Partner links of this company: the other company's Paperclip id, status (pending or active) and who has accepted. Use an active link's id with propose-grant.",
    parametersSchema: schema([], {
      status: { type: "string", enum: ["pending", "active"], description: "Only links in this state. Omit for all." },
    }),
  },
  {
    name: "list-grants",
    displayName: "List record grants",
    description:
      "Named records shared through partner links: outgoing (our records we share) and incoming (shared with us), with status proposed, active or revoked.",
    parametersSchema: schema([], {
      direction: { type: "string", enum: ["outgoing", "incoming"], description: "outgoing: our records shared with a partner. incoming: a partner's records shared with us. Omit for both." },
      status: { type: "string", enum: ["proposed", "active", "revoked"], description: "Only grants in this state. Omit for all." },
      recordType,
    }),
  },
  {
    name: "propose-link",
    displayName: "Propose partner link",
    description: "Propose a link with another Paperclip company. It stays pending until a person at each company accepts it on the Partners page.",
    parametersSchema: schema(["otherCompanyId"], {
      otherCompanyId: str("The other Paperclip company's id (not a CRM id). A person can find it on the Partners page."),
    }),
  },
  {
    name: "propose-grant",
    displayName: "Propose record grant",
    description:
      "Propose sharing one named record of ours with the partner on an active link. Nothing is copied. A person at our company accepts it on the Partners page before the partner sees it.",
    parametersSchema: schema(["linkId", "recordType", "recordId", "granteeCompanyId"], {
      linkId: str("Active link id from list-links."),
      recordType,
      recordId: str("The record's id in the CRM or Billing (the id part of company:<id> or contact:<id>, a deal id, or an invoice id)."),
      granteeCompanyId: str("The partner company's Paperclip id: the other company on the link."),
    }),
  },
  {
    name: "revoke-grant",
    displayName: "Revoke record grant",
    description: "Stop sharing a record. Only the company that owns it can revoke; the CRM or Billing share is removed with it.",
    parametersSchema: schema(["grantId"], {
      grantId: str("Grant id from list-grants (an outgoing grant)."),
    }),
  },
];
