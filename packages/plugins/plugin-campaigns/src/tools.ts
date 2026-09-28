import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

const str = (description: string): JsonSchema => ({ type: "string", description });
const int = (description: string, minimum = 0): JsonSchema => ({ type: "integer", minimum, description });

const campaignId = str("Campaign id, from create-campaign or list-campaigns.");
const enrollmentId = str("Enrollment id: one contact in one campaign (from launch-campaign, enroll-contact, or the step or reply issue).");
const variant = { type: "string", enum: ["a", "b"], description: "Step version: a (the original) or b (the A/B test version)." } satisfies JsonSchema;

/** Who the campaign is for. Omit all three for PiB's own work. */
const clientParams: Record<string, JsonSchema> = {
  client: str("The client this is for: company:<CRM company id> or contact:<CRM contact id> (a sole trader). Omit for PiB's own work; \"own\" moves a draft back to own work."),
  clientKind: { type: "string", enum: ["company", "contact"], description: "Kind of clientRef (default company). Alternative to client." },
  clientRef: str("CRM company or contact id. Alternative to client. Omit for PiB's own work."),
};

const audienceMode = {
  type: "string",
  enum: ["tags", "client_contacts", "client_contact"],
  description:
    "Who launch enrolls. tags: CRM contacts with any of audienceTags; no tags means ALL contacts, allowed only when the approval says 'All contacts (N)'. client_contacts: the contacts at the client company, narrowed by audienceTags (default for a company client). client_contact: the client contact alone (default for a contact client).",
} satisfies JsonSchema;

const audienceTags = { type: "array", items: { type: "string" }, description: "CRM tags; a contact with any of them is in the audience. Case does not matter." } satisfies JsonSchema;

const delivery = {
  type: "string",
  enum: ["issue", "email"],
  description:
    "issue (default): each due step opens an issue for the campaign's agent, who sends the email. email: the Mailbox sends each due step from Gmail as marketing mail, with the merge tokens filled in.",
} satisfies JsonSchema;

const campaignFields: Record<string, JsonSchema> = {
  name: str("Short internal name, e.g. 'Spring website offer'."),
  description: str("Internal notes: the goal and who it is for. Not sent."),
  fromName: str("Sender name to show, e.g. 'Peet at Partners in Biz'. The Mailbox's default account sends it."),
  fromLocal: str("Local part for the sender address (letters, digits, . _ -). Default campaigns."),
  replyTo: str("Address replies should go to, when not the sending account."),
  audienceTags,
  audienceMode,
  delivery,
  ...clientParams,
  startAt: str("ISO date or time. The first step is not due before it; empty starts on approval."),
  endAt: str("ISO date or time the campaign is meant to end. For reporting only."),
};

const stepBody = str("Plain-text body. Merge tokens: {{first_name}}, {{last_name}}, {{name}}, {{company}}, {{email}}; add a fallback as {{first_name|there}}. Say who we are, why they get it, and how to opt out (reply STOP).");
const stepSubject = str("Email subject. The same merge tokens work here.");

export const CAMPAIGN_TOOLS: PluginToolDeclaration[] = [
  {
    name: "create-campaign",
    displayName: "Create campaign",
    description:
      "Create a draft email program. Pass client for a client's campaign (it must exist in the CRM); omit it for PiB's own work. Returns the campaign id; next add steps, then request-campaign-approval.",
    parametersSchema: schema(["name"], campaignFields),
  },
  {
    name: "update-campaign",
    displayName: "Update campaign",
    description:
      "Edit a draft. Omitted fields stay. Changing the audience, sender, delivery or dates after approval was asked for cancels that approval (approvalReset true): ask again.",
    parametersSchema: schema(["campaignId"], { campaignId, ...campaignFields }),
  },
  {
    name: "list-campaigns",
    displayName: "List campaigns",
    description: "List campaigns with status, audience, approval and launch state, and enrollment counts. Pass client for one client's campaigns; omit it for PiB's own.",
    parametersSchema: schema([], { ...clientParams }),
  },
  {
    name: "add-campaign-step",
    displayName: "Add campaign step",
    description: "Add an email step to a draft campaign. Steps run in the order added. Cancels a pending approval (ask again).",
    parametersSchema: schema(["campaignId", "subject"], {
      campaignId,
      subject: stepSubject,
      body: stepBody,
      delayDays: int("Days to wait after the previous step (after launch for step 1). Default 0."),
    }),
  },
  {
    name: "launch-campaign",
    displayName: "Launch campaign",
    description:
      "Only for a paused campaign (enrolls audience contacts not in it yet, then runs) or a draft whose approval a person already marked done. An approved campaign normally launches by itself. Suppressed addresses are left out.",
    parametersSchema: schema(["campaignId"], {
      campaignId,
      contactIds: { type: "array", items: { type: "string" }, description: "CRM contact ids to enroll instead of the audience. Omit to use the audience." },
    }),
  },
  {
    name: "pause-campaign",
    displayName: "Pause campaign",
    description: "Pause an active campaign. Nothing is sent and no step issues open until resume-campaign.",
    parametersSchema: schema(["campaignId"], { campaignId }),
  },
  {
    name: "resume-campaign",
    displayName: "Resume campaign",
    description: "Resume a paused campaign so due steps go out again.",
    parametersSchema: schema(["campaignId"], { campaignId }),
  },
  {
    name: "complete-campaign",
    displayName: "Complete campaign",
    description: "End an active or paused campaign. Nothing more is sent.",
    parametersSchema: schema(["campaignId"], { campaignId }),
  },
  {
    name: "campaign-stats",
    displayName: "Campaign stats",
    description: "Enrolled, running and finished contact counts for a campaign.",
    parametersSchema: schema(["campaignId"], { campaignId }),
  },
  {
    name: "enroll-contact",
    displayName: "Enroll contact in campaign",
    description:
      "Add one CRM contact to a draft or active campaign. Only someone who fits the approved audience and agreed to hear from us. Refused for an unsubscribed or bounced address, or a second running enrollment.",
    parametersSchema: schema(["campaignId", "contactId"], {
      campaignId,
      contactId: str("CRM contact id (the id part of contact:<id>)."),
    }),
  },
  {
    name: "stop-enrollment",
    displayName: "Stop a contact's campaign",
    description: "Stop sending this campaign to one contact (not interested, wants a person, or asked). everyCampaign stops all their campaigns. Use suppress-address instead when they asked to stop getting email.",
    parametersSchema: schema(["enrollmentId"], {
      enrollmentId,
      everyCampaign: { type: "boolean", description: "True: stop every running campaign for this contact. Default false." },
    }),
  },
  {
    name: "suppress-address",
    displayName: "Add to do-not-email list",
    description:
      "Record an opt-out: the address never gets campaigns or sequences again, running campaigns stop, open step issues are cancelled, and the CRM and Mailbox are told (contact.suppressed). Use it for any 'stop', 'remove me' or complaint.",
    parametersSchema: schema(["email"], {
      email: str("The email address that asked to stop."),
      reason: { type: "string", enum: ["unsubscribe", "complaint", "manual"], description: "unsubscribe (default): they asked to stop. complaint: they complained or marked it spam. manual: a person decided." },
    }),
  },
  {
    name: "log-reply",
    displayName: "Log what was done about a reply",
    description:
      "Record what you did about a campaign reply: answered (you drafted or sent an answer in the Mailbox) or no-reply-needed (an automatic reply, or nothing to answer). The reply issue's check counts it when you close the issue.",
    parametersSchema: schema(["messageId", "outcome", "note"], {
      messageId: str("The reply's Mailbox message id (in the reply issue)."),
      outcome: { type: "string", enum: ["answered", "no-reply-needed"], description: "answered: you drafted or sent an answer. no-reply-needed: an automatic reply or nothing to answer." },
      note: str("One or two plain sentences: what you answered or decided (max 1,000 characters)."),
      mailDraftId: str("The Mailbox draft id when you drafted an answer."),
    }),
  },
  {
    name: "request-campaign-approval",
    displayName: "Request campaign approval",
    description:
      "Open the launch approval: the audience with its count ('All contacts (N)' when there are no tags), delivery, start and every step. It goes to the Reviewer first when there is one, else the approver. Once a person marks it done the campaign launches by itself.",
    parametersSchema: schema(["campaignId"], { campaignId }),
  },
  {
    name: "create-ab-variant",
    displayName: "Create A/B variant",
    description: "Add a B version of a draft's step; contacts are split evenly between A and B. Cancels a pending approval (ask again).",
    parametersSchema: schema(["campaignId", "position", "subject"], {
      campaignId,
      position: int("Step number to add a B version to (1 is the first step).", 1),
      subject: stepSubject,
      body: stepBody,
    }),
  },
  {
    name: "campaign-funnel",
    displayName: "Campaign funnel",
    description: "How many contacts are at each step (and variant), plus finished and stopped counts.",
    parametersSchema: schema(["campaignId"], { campaignId }),
  },
  {
    name: "record-step-event",
    displayName: "Record step event",
    description: "Record an open or click you saw in a real report (such as a link tracker). Never estimate. Sends, replies, bounces and unsubscribes are recorded automatically.",
    parametersSchema: schema(["enrollmentId", "eventType"], {
      enrollmentId,
      eventType: { type: "string", enum: ["open", "click"], description: "open or click." },
      stepPosition: int("Step number it happened on. Default: the contact's current step.", 1),
    }),
  },
  {
    name: "campaign-step-analytics",
    displayName: "Campaign step analytics",
    description: "Per step: sent, replies, bounces, unsubscribes, opens and clicks.",
    parametersSchema: schema(["campaignId"], { campaignId }),
  },
  {
    name: "set-step-html",
    displayName: "Set step HTML",
    description: "Set the HTML body of a draft's step; the plain body stays as the text version. Cancels a pending approval (ask again).",
    parametersSchema: schema(["campaignId", "position", "html"], {
      campaignId,
      position: int("Step number (1 is the first step).", 1),
      html: str("Full HTML body. The merge tokens work here too."),
      variant,
    }),
  },
  {
    name: "create-campaign-template",
    displayName: "Create campaign template",
    description: "Save a reusable set of steps to start new campaigns from.",
    parametersSchema: schema(["name", "steps"], {
      name: str("Template name."),
      description: str("What the template is for."),
      steps: {
        type: "array",
        description: "Steps in order.",
        items: {
          type: "object",
          properties: {
            subject: stepSubject,
            body: stepBody,
            delayDays: int("Days after the previous step."),
          },
          required: ["subject"],
        },
      },
    }),
  },
  {
    name: "list-campaign-templates",
    displayName: "List campaign templates",
    description: "The saved campaign templates (id, name, description).",
    parametersSchema: schema([], {}),
  },
  {
    name: "create-campaign-from-template",
    displayName: "Create campaign from template",
    description: "Create a draft copying a template's steps. Pass client for a client's campaign; omit it for PiB's own work.",
    parametersSchema: schema(["templateId", "name"], {
      templateId: str("Template id from list-campaign-templates."),
      name: campaignFields.name!,
      audienceMode,
      delivery,
      ...clientParams,
    }),
  },
  {
    name: "declare-ab-winner",
    displayName: "Declare A/B winner",
    description: "Record the winning variant a person chose; new enrollments then get only it. The result includes the reply-rate suggestion.",
    parametersSchema: schema(["campaignId", "winner"], {
      campaignId,
      winner: { type: "string", enum: ["a", "b"], description: "The variant a person chose." },
    }),
  },
  {
    name: "suggest-ab-winner",
    displayName: "Suggest A/B winner",
    description:
      "Compare reply rates of variants a and b from emails the Mailbox sent. Needs 20 sends per variant, else inconclusive. It only suggests: ask a person, then declare-ab-winner.",
    parametersSchema: schema(["campaignId"], { campaignId }),
  },
];
