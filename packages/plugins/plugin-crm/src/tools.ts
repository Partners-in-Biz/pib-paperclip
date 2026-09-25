import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return {
    type: "object",
    required,
    properties,
    additionalProperties: false,
  };
}

const text = { type: "string" } satisfies JsonSchema;
const textList = { type: "array", items: { type: "string" } } satisfies JsonSchema;
const objectBag = { type: "object", additionalProperties: true } satisfies JsonSchema;

export const CRM_TOOLS: PluginToolDeclaration[] = [
  {
    name: "create-company",
    displayName: "Create company",
    description: "Create the account a contact works for. This is a CRM company, not the Paperclip workspace.",
    parametersSchema: schema(["name"], {
      name: text,
      domain: text,
      lifecycle: text,
      currency: text,
      tags: textList,
      custom: objectBag,
    }),
  },
  {
    name: "update-company",
    displayName: "Update company",
    description: "Update a CRM company the actor can see. Filled human-owned fields are refused.",
    parametersSchema: schema(["companyRecordId"], {
      companyRecordId: text,
      name: text,
      domain: text,
      lifecycle: text,
      currency: text,
      tags: textList,
      custom: objectBag,
    }),
  },
  {
    name: "create-contact",
    displayName: "Create contact",
    description: "Create a person in this workspace.",
    parametersSchema: schema(["name"], {
      name: text,
      emails: textList,
      phones: textList,
      lifecycle: text,
      tags: textList,
      nextActionKind: text,
      nextActionDueAt: text,
      custom: objectBag,
    }),
  },
  {
    name: "update-contact",
    displayName: "Update contact",
    description: "Update a visible contact. Filled human-owned fields are refused and a fact is stored.",
    parametersSchema: schema(["contactId"], {
      contactId: text,
      name: text,
      emails: textList,
      phones: textList,
      lifecycle: text,
      tags: textList,
      nextActionKind: text,
      nextActionDueAt: text,
      custom: objectBag,
    }),
  },
  {
    name: "link-contact",
    displayName: "Link contact to company",
    description: "Link a contact to a CRM company with a role label such as buyer or staff.",
    parametersSchema: schema(["contactId", "companyRecordId"], {
      contactId: text,
      companyRecordId: text,
      roleLabel: text,
    }),
  },
  {
    name: "log-activity",
    displayName: "Log activity",
    description: "Append a timeline note on a visible contact, company, or deal.",
    parametersSchema: schema(["recordType", "recordId", "body"], {
      recordType: text,
      recordId: text,
      kind: text,
      body: text,
      issueId: text,
    }),
  },
  {
    name: "create-deal",
    displayName: "Create deal",
    description: "Create a deal. Amount is an integer in minor units plus a currency code.",
    parametersSchema: schema(["title"], {
      title: text,
      amountMinor: { type: "integer" },
      currency: text,
      companyRecordId: text,
      contactId: text,
      nextActionKind: text,
      nextActionDueAt: text,
    }),
  },
  {
    name: "move-deal",
    displayName: "Move deal",
    description: "Move a deal to a stage. Won or lost stops that contact's running enrollments.",
    parametersSchema: schema(["dealId", "stageId"], {
      dealId: text,
      stageId: text,
    }),
  },
  {
    name: "share-record",
    displayName: "Share record",
    description: "Share one visible record with a board user or an agent. Company grants come from partner links.",
    parametersSchema: schema(["recordType", "recordId", "principalType", "principalId"], {
      recordType: text,
      recordId: text,
      principalType: text,
      principalId: text,
    }),
  },
  {
    name: "define-field",
    displayName: "Define field",
    description: "Declare an extra field for contacts, companies, or deals. Values live in custom.",
    parametersSchema: schema(["recordType", "fieldKey", "label"], {
      recordType: text,
      fieldKey: text,
      label: text,
      fieldType: text,
    }),
  },
  {
    name: "enroll-contact",
    displayName: "Enroll contact",
    description: "Enroll a visible contact in a sequence. One running enrollment per contact per sequence.",
    parametersSchema: schema(["sequenceId", "contactId"], {
      sequenceId: text,
      contactId: text,
    }),
  },
  {
    name: "complete-step",
    displayName: "Complete sequence step",
    description: "Advance an enrollment. Manual steps require the Paperclip issue to be done. Sent steps require sentConfirmed.",
    parametersSchema: schema(["enrollmentId"], {
      enrollmentId: text,
      sentConfirmed: { type: "boolean" },
    }),
  },
  {
    name: "create-sequence",
    displayName: "Create sequence",
    description: "Create a sequence and its steps. completionMode is manual or sent.",
    parametersSchema: schema(["name"], {
      name: text,
      completionMode: text,
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            position: { type: "integer" },
            delayMinutes: { type: "integer" },
            title: text,
            body: text,
          },
          required: ["title"],
        },
      },
    }),
  },
  {
    name: "create-product",
    displayName: "Create product",
    description: "Add a product or service to the catalog. Amount is an integer in minor units plus a currency code.",
    parametersSchema: schema(["name"], {
      name: text,
      description: text,
      unitAmountMinor: { type: "integer" },
      currency: text,
    }),
  },
  {
    name: "update-product",
    displayName: "Update product",
    description: "Update a product in the catalog. Amount is an integer in minor units plus a currency code.",
    parametersSchema: schema(["productId"], {
      productId: text,
      name: text,
      description: text,
      unitAmountMinor: { type: "integer" },
      currency: text,
      isActive: { type: "boolean" },
    }),
  },
  {
    name: "score-contact",
    displayName: "Score contact",
    description: "Return a 0-100 lead score for a visible contact with a plain-language breakdown of what raised or lowered it.",
    parametersSchema: schema(["contactId"], {
      contactId: text,
    }),
  },
];
