import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";

const text = { type: "string" } satisfies JsonSchema;
const textList = { type: "array", items: { type: "string" } } satisfies JsonSchema;

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

export const CAMPAIGN_TOOLS: PluginToolDeclaration[] = [
  {
    name: "create-campaign",
    displayName: "Create campaign",
    description: "Create a themed email program. audienceTags narrows which contacts are enrolled; empty means everyone.",
    parametersSchema: schema(["name"], {
      name: text,
      description: text,
      fromName: text,
      fromLocal: text,
      replyTo: text,
      audienceTags: textList,
      startAt: text,
      endAt: text,
    }),
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
    description: "Enroll every visible contact that matches the campaign audience tags and open the first step's issue.",
    parametersSchema: schema(["campaignId"], {
      campaignId: text,
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
];
