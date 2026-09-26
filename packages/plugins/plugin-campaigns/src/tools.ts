import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";

const text = { type: "string" } satisfies JsonSchema;
const textList = { type: "array", items: { type: "string" } } satisfies JsonSchema;

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

/** Who the campaign is for. Omit all three for PiB's own work. */
const clientParams: Record<string, JsonSchema> = {
  client: {
    type: "string",
    description: "The client this is for: company:<CRM company id> or contact:<CRM contact id> (a sole trader). Omit for PiB's own work.",
  },
  clientKind: { type: "string", enum: ["company", "contact"], description: "Kind of clientRef (default company). Alternative to client." },
  clientRef: { type: "string", description: "CRM company or contact id. Alternative to client. Omit for PiB's own work." },
};

const audienceMode = {
  type: "string",
  enum: ["tags", "client_contacts", "client_contact"],
  description:
    "Who launch enrolls. tags: CRM contacts matching audienceTags (empty = everyone). client_contacts: the contacts at the client company, narrowed by audienceTags when set (default for a company client). client_contact: the client contact alone (default for a contact client).",
} satisfies JsonSchema;

const delivery = {
  type: "string",
  enum: ["issue", "email"],
  description:
    "issue (default): each due step opens an issue and a person sends the email. email: once the approved campaign is launched, the Mailbox sends each due step from Gmail ({{first_name}}, {{name}}, {{company}} are filled in).",
} satisfies JsonSchema;

export const CAMPAIGN_TOOLS: PluginToolDeclaration[] = [
  {
    name: "create-campaign",
    displayName: "Create campaign",
    description:
      "Create a draft email program. Pass client for a client's campaign (it must exist in the CRM); omit client for PiB's own work. audienceMode and audienceTags choose who launch enrolls.",
    parametersSchema: schema(["name"], {
      name: text,
      description: text,
      fromName: text,
      fromLocal: text,
      replyTo: text,
      audienceTags: textList,
      audienceMode,
      delivery,
      ...clientParams,
      startAt: text,
      endAt: text,
    }),
  },
  {
    name: "update-campaign",
    displayName: "Update campaign",
    description:
      "Edit a draft campaign. Omitted fields stay. Pass client to move it to a client, or client \"own\" to make it PiB's own work. Switching delivery to email after approval needs a new approval.",
    parametersSchema: schema(["campaignId"], {
      campaignId: text,
      name: text,
      description: text,
      fromName: text,
      fromLocal: text,
      replyTo: text,
      audienceTags: textList,
      audienceMode,
      delivery,
      ...clientParams,
      startAt: text,
      endAt: text,
    }),
  },
  {
    name: "list-campaigns",
    displayName: "List campaigns",
    description: "List campaigns with status, audience and enrollment counts. Pass client for one client's campaigns; omit it for PiB's own campaigns.",
    parametersSchema: schema([], { ...clientParams }),
  },
  {
    name: "add-campaign-step",
    displayName: "Add campaign step",
    description: "Add an email step to a draft campaign. delayDays is the wait before this step after the previous one.",
    parametersSchema: schema(["campaignId", "subject"], {
      campaignId: text,
      subject: text,
      body: text,
      delayDays: { type: "integer" },
    }),
  },
  {
    name: "launch-campaign",
    displayName: "Launch campaign",
    description:
      "Launch an approved campaign: enroll its audience (tagged contacts, the contacts at the client company, or the client contact) or the contactIds you pass. Due steps then open issues.",
    parametersSchema: schema(["campaignId"], {
      campaignId: text,
      contactIds: textList,
    }),
  },
  {
    name: "pause-campaign",
    displayName: "Pause campaign",
    description: "Pause an active or scheduled campaign. Running enrollments stop advancing.",
    parametersSchema: schema(["campaignId"], {
      campaignId: text,
    }),
  },
  {
    name: "resume-campaign",
    displayName: "Resume campaign",
    description: "Resume a paused campaign so due steps open again.",
    parametersSchema: schema(["campaignId"], {
      campaignId: text,
    }),
  },
  {
    name: "complete-campaign",
    displayName: "Complete campaign",
    description: "Mark an active or paused campaign completed.",
    parametersSchema: schema(["campaignId"], {
      campaignId: text,
    }),
  },
  {
    name: "campaign-stats",
    displayName: "Campaign stats",
    description: "Return enrolled, running, and completed counts for a campaign.",
    parametersSchema: schema(["campaignId"], {
      campaignId: text,
    }),
  },
  {
    name: "enroll-contact",
    displayName: "Enroll contact in campaign",
    description: "Enroll a visible contact in a campaign. One running enrollment per contact per campaign.",
    parametersSchema: schema(["campaignId", "contactId"], {
      campaignId: text,
      contactId: text,
    }),
  },
  {
    name: "complete-step",
    displayName: "Complete campaign step",
    description: "Advance an enrollment to the next step. Requires the Paperclip issue to be done.",
    parametersSchema: schema(["enrollmentId"], {
      enrollmentId: text,
    }),
  },
  {
    name: "request-campaign-approval",
    displayName: "Request campaign approval",
    description: "Open a Paperclip issue for a person to approve the campaign before it launches.",
    parametersSchema: schema(["campaignId"], {
      campaignId: text,
    }),
  },
  {
    name: "create-ab-variant",
    displayName: "Create A/B variant",
    description: "Add a B variant to a campaign step so contacts are split between the two versions.",
    parametersSchema: schema(["campaignId", "position", "subject"], {
      campaignId: text,
      position: { type: "integer" },
      subject: text,
      body: text,
    }),
  },
  {
    name: "campaign-funnel",
    displayName: "Campaign funnel",
    description: "Return how many contacts are at each step of a campaign, plus completed and stopped counts.",
    parametersSchema: schema(["campaignId"], {
      campaignId: text,
    }),
  },
  {
    name: "record-step-event",
    displayName: "Record step event",
    description: "Record an open or click on a campaign step for a contact's enrollment.",
    parametersSchema: schema(["enrollmentId", "eventType"], {
      enrollmentId: text,
      eventType: text,
      stepPosition: { type: "integer" },
    }),
  },
  {
    name: "campaign-step-analytics",
    displayName: "Campaign step analytics",
    description: "Return opens and clicks per step for a campaign.",
    parametersSchema: schema(["campaignId"], {
      campaignId: text,
    }),
  },
  {
    name: "set-step-html",
    displayName: "Set step HTML",
    description: "Set the rich HTML body of a campaign step. The plain body stays as a fallback.",
    parametersSchema: schema(["campaignId", "position", "html"], {
      campaignId: text,
      position: { type: "integer" },
      html: text,
      variant: text,
    }),
  },
  {
    name: "create-campaign-template",
    displayName: "Create campaign template",
    description: "Save a reusable campaign with its steps so you can launch it again.",
    parametersSchema: schema(["name", "steps"], {
      name: text,
      description: text,
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: { subject: text, body: text, delayDays: { type: "integer" } },
          required: ["subject"],
        },
      },
    }),
  },
  {
    name: "list-campaign-templates",
    displayName: "List campaign templates",
    description: "Return the saved campaign templates for this workspace.",
    parametersSchema: schema([], {}),
  },
  {
    name: "create-campaign-from-template",
    displayName: "Create campaign from template",
    description: "Create a new draft campaign copying the template's steps. Pass client for a client's campaign; omit it for PiB's own work.",
    parametersSchema: schema(["templateId", "name"], {
      templateId: text,
      name: text,
      audienceMode,
      delivery,
      ...clientParams,
    }),
  },
  {
    name: "declare-ab-winner",
    displayName: "Declare A/B winner",
    description:
      "Declare variant a or b as the winner of a campaign, so new enrollments use only it. Only declare what a person agreed to; the result includes the reply-rate suggestion.",
    parametersSchema: schema(["campaignId", "winner"], {
      campaignId: text,
      winner: text,
    }),
  },
  {
    name: "suggest-ab-winner",
    displayName: "Suggest A/B winner",
    description:
      "Compare reply rates of variants a and b from emails the Mailbox sent. Needs at least 20 sends per variant, otherwise the verdict is inconclusive. It only suggests: a person declares with declare-ab-winner.",
    parametersSchema: schema(["campaignId"], {
      campaignId: text,
    }),
  },
];
