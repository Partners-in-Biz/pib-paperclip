import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import { ACTIVITY_KINDS, COMPLETION_MODES, DEAL_STATUSES, FIELD_TYPES, FIND_KINDS, FIND_MAX, LIFECYCLES, NEXT_ACTIONS, RECORD_TYPES, SEQUENCE_DELIVERIES } from "./domain.js";

/**
 * The CRM's agent tools. Every parameter has a description, and an enum where
 * the values are fixed. Results are JSON with ids, `company:<id>` /
 * `contact:<id>` refs and deep links.
 */

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return {
    type: "object",
    required,
    properties,
    additionalProperties: false,
  };
}

const text = (description: string): JsonSchema => ({ type: "string", description });
const textList = (description: string): JsonSchema => ({ type: "array", items: { type: "string" }, description });
const oneOf = (values: readonly string[], description: string): JsonSchema => ({ type: "string", enum: [...values], description });
const int = (description: string, extra: Record<string, unknown> = {}): JsonSchema => ({ type: "integer", description, ...extra });
const bool = (description: string): JsonSchema => ({ type: "boolean", description });
const bag = (description: string): JsonSchema => ({ type: "object", additionalProperties: true, description });

const P = {
  companyRecordId: text("CRM company id (from find-records or get-company). company:<id> also works."),
  contactId: text("CRM contact id (from find-records or get-contact). contact:<id> also works."),
  dealId: text("Deal id (from list-deals or get-company)."),
  sequenceId: text("Sequence id (from list-sequences)."),
  productId: text("Product id (from the create-product result)."),
  client: text("The client: company:<id> or contact:<id> (from find-records)."),
  name: text("Name as the client writes it."),
  domain: text("Website domain without https, e.g. acme.co.za. Email leads from this domain are linked to the company."),
  lifecycle: oneOf(LIFECYCLES, "lead: new, not qualified. prospect: qualified, talking about work. customer: has bought (set for you when a deal is won or an invoice is paid). churned: stopped buying, or a lead that is not a fit (stops their sequences)."),
  currency: text("3-letter currency code, e.g. ZAR (the default)."),
  tagsNew: textList("Labels, e.g. retainer or priority."),
  tagsReplace: textList("The full tag list: it replaces the current tags."),
  custom: bag("Extra fields declared with define-field, as { fieldKey: value }."),
  emails: textList("Email addresses; the first one gets email."),
  phones: textList("Phone numbers with the country code, e.g. +27 82 123 4567."),
  nextActionKind: oneOf(NEXT_ACTIONS, "The next thing to do with this person."),
  nextActionDueAt: text("When the next action is due: ISO date or date-time, e.g. 2026-10-01."),
  recordType: oneOf(RECORD_TYPES, "The kind of record."),
  recordId: text("The record's id."),
  amountMinor: int("Value in minor units (cents): 150000 is R 1,500.00.", { minimum: 0 }),
};

export const CRM_TOOLS: PluginToolDeclaration[] = [
  // -------------------------------------------------------------------------
  // Find and read
  // -------------------------------------------------------------------------
  {
    name: "find-records",
    displayName: "Find companies and contacts",
    description:
      "Search the CRM by name, email, domain, phone or tag before you create anything. Returns each match's ref (company:<id> or contact:<id>), lifecycle and a link. Give a query, a lifecycle, or both.",
    parametersSchema: schema([], {
      query: text("Name, email, domain (acme.co.za), phone or tag. Case does not matter; partial names match."),
      kind: oneOf(FIND_KINDS, "Search companies, contacts, or both (any, the default)."),
      lifecycle: oneOf(LIFECYCLES, "Only records in this lifecycle, e.g. customer."),
      limit: int(`Most results to return, 1 to ${FIND_MAX} (default 10).`, { minimum: 1, maximum: FIND_MAX }),
    }),
  },
  {
    name: "get-company",
    displayName: "Get company",
    description:
      "A company client in one read: profile (brand voice, audience, services, links), people, open deals, the last 10 activities, lifecycle, tags, leads from their own channels and workspaceLinks to each module's client workspace.",
    parametersSchema: schema(["companyRecordId"], { companyRecordId: P.companyRecordId }),
  },
  {
    name: "get-contact",
    displayName: "Get contact",
    description:
      "A contact in one read: emails, phones, email status, lifecycle, companies, open deals, running sequences, the last 10 activities, lead score and workspaceLinks. A contact without a company is a client (sole trader) and has a profile.",
    parametersSchema: schema(["contactId"], { contactId: P.contactId }),
  },
  {
    name: "list-deals",
    displayName: "List deals",
    description: "Deals with their stage, status, value and client ref. Filter by status, stage or client.",
    parametersSchema: schema([], {
      status: oneOf(DEAL_STATUSES, "open, won or lost."),
      stage: text("Stage id or stage name, e.g. Proposal (see list-stages)."),
      client: text("Only this client's deals: company:<id> or contact:<id>. A company includes its people's deals."),
      limit: int("Most deals to return, 1 to 50 (default 25).", { minimum: 1, maximum: 50 }),
    }),
  },
  {
    name: "list-stages",
    displayName: "List pipeline stages",
    description: "The pipeline's stages in order, with each stage's id, kind (open, won, lost) and deal count. Use the id with move-deal.",
    parametersSchema: schema([], {}),
  },
  {
    name: "list-sequences",
    displayName: "List sequences",
    description: "Sequences with their id, delivery (issue or email), whether email is approved, their steps and how many contacts are running.",
    parametersSchema: schema([], {}),
  },
  {
    name: "get-client-profile",
    displayName: "Get client profile",
    description:
      "How to talk for a client: brand voice, audience, services they buy from us, website, booking link, banned words and tone notes, plus which fields are still missing. Read it before you write anything for or to the client.",
    parametersSchema: schema(["client"], { client: P.client }),
  },
  {
    name: "update-client-profile",
    displayName: "Update client profile",
    description:
      "Fill in or change a client's profile (during onboarding and whenever you learn more). Only the fields you send change; send null or an empty value to clear one. A field a person set is kept: you may only fill it while it is empty.",
    parametersSchema: schema(["client"], {
      client: P.client,
      brandVoice: text("How the client sounds, in 1-3 sentences, e.g. warm, plain South African English, no jargon."),
      audience: text("Who they sell to: the people, where they are and what they care about."),
      services: textList("What they buy from us, e.g. SEO retainer, social media management, website."),
      website: text("Their website, e.g. https://acme.co.za."),
      bookingLink: text("Where their customers book or enquire, e.g. a Calendly or contact page link."),
      bannedWords: textList("Words and phrases never to use for them."),
      toneNotes: text("Anything else about tone: emoji, formality, words they prefer, topics to avoid."),
    }),
  },
  {
    name: "contact-graph",
    displayName: "Contact graph",
    description: "A contact's companies, deals and recent activity in one small view. get-contact gives more.",
    parametersSchema: schema(["contactId"], { contactId: P.contactId }),
  },
  {
    name: "field-history",
    displayName: "Field history",
    description: "The recorded field changes and refused writes for a contact, company or deal. Use it to explain why a value is what it is.",
    parametersSchema: schema(["recordType", "recordId"], { recordType: P.recordType, recordId: P.recordId }),
  },
  {
    name: "pipeline-forecast",
    displayName: "Pipeline forecast",
    description: "Open pipeline value by stage with a weighted forecast (each stage's win chance). An estimate, not a promise.",
    parametersSchema: schema([], {}),
  },
  {
    name: "export-contacts",
    displayName: "Export contacts",
    description: "The contacts you can see as CSV: id, ref, name, emails, phones, lifecycle, email status, tags and company refs.",
    parametersSchema: schema([], {}),
  },

  // -------------------------------------------------------------------------
  // Companies and contacts
  // -------------------------------------------------------------------------
  {
    name: "create-company",
    displayName: "Create company",
    description:
      "Create a CRM company: a client account, not the Paperclip workspace. Search with find-records first. Returns its id, ref company:<id> and link. Then link its people with link-contact.",
    parametersSchema: schema(["name"], {
      name: P.name,
      domain: P.domain,
      lifecycle: P.lifecycle,
      currency: P.currency,
      tags: P.tagsNew,
      custom: P.custom,
    }),
  },
  {
    name: "update-company",
    displayName: "Update company",
    description:
      "Change a CRM company. Only the fields you send change. A field a person owns that already has a value is refused and noted. Setting lifecycle churned stops its people's sequences.",
    parametersSchema: schema(["companyRecordId"], {
      companyRecordId: P.companyRecordId,
      name: P.name,
      domain: P.domain,
      lifecycle: P.lifecycle,
      currency: P.currency,
      tags: P.tagsReplace,
      custom: P.custom,
    }),
  },
  {
    name: "create-contact",
    displayName: "Create contact",
    description: "Create a person. Search with find-records first. Returns its id, ref contact:<id> and link. Link them to their company with link-contact.",
    parametersSchema: schema(["name"], {
      name: text("Full name, e.g. Thandi Mokoena."),
      emails: P.emails,
      phones: P.phones,
      lifecycle: P.lifecycle,
      tags: P.tagsNew,
      nextActionKind: P.nextActionKind,
      nextActionDueAt: P.nextActionDueAt,
      custom: P.custom,
    }),
  },
  {
    name: "update-contact",
    displayName: "Update contact",
    description:
      "Change a contact. Only the fields you send change. A field a person owns that already has a value is refused and noted. Setting lifecycle churned stops their sequences. Opt-outs go through set-email-status.",
    parametersSchema: schema(["contactId"], {
      contactId: P.contactId,
      name: text("Full name."),
      emails: textList("The full email list: it replaces the current one."),
      phones: textList("The full phone list: it replaces the current one."),
      lifecycle: P.lifecycle,
      tags: P.tagsReplace,
      nextActionKind: P.nextActionKind,
      nextActionDueAt: P.nextActionDueAt,
      custom: P.custom,
    }),
  },
  {
    name: "link-contact",
    displayName: "Link contact to company",
    description: "Link a contact to a CRM company (the people at a client). A contact may work for several companies.",
    parametersSchema: schema(["contactId", "companyRecordId"], {
      contactId: P.contactId,
      companyRecordId: P.companyRecordId,
      roleLabel: text("Their role there, e.g. owner, buyer or staff (the default)."),
    }),
  },
  {
    name: "set-email-status",
    displayName: "Set email status",
    description:
      "Record that a contact must not get marketing email: they asked to stop (unsubscribed, by any channel) or the address bounced. Stops their sequences and tells Campaigns and the Mailbox. Only a person can allow email again.",
    parametersSchema: schema(["contactId", "status"], {
      contactId: P.contactId,
      status: oneOf(["unsubscribed", "bounced"], "unsubscribed: they asked to stop. bounced: the address does not work."),
      note: text("Why, in a few words, e.g. asked on a call on 3 Oct."),
    }),
  },
  {
    name: "log-activity",
    displayName: "Log activity",
    description: "Add an entry to the timeline of a contact, company or deal: calls, meetings, what the client said or decided.",
    parametersSchema: schema(["recordType", "recordId", "body"], {
      recordType: P.recordType,
      recordId: P.recordId,
      kind: oneOf(ACTIVITY_KINDS, "What it was (default note)."),
      body: text("What happened, in plain words. Facts only."),
      issueId: text("The Paperclip issue this belongs to, if any."),
    }),
  },
  {
    name: "share-record",
    displayName: "Share record",
    description: "Let one board user or agent see a record they cannot see yet. Partner companies get access through the Partners module, not this tool.",
    parametersSchema: schema(["recordType", "recordId", "principalType", "principalId"], {
      recordType: P.recordType,
      recordId: P.recordId,
      principalType: oneOf(["user", "agent"], "Who gets access: a board user or an agent."),
      principalId: text("That user's or agent's id."),
    }),
  },
  {
    name: "define-field",
    displayName: "Define field",
    description: "Declare an extra field for contacts, companies or deals. Its values then go in custom.",
    parametersSchema: schema(["recordType", "fieldKey", "label"], {
      recordType: P.recordType,
      fieldKey: text("Lowercase key: letters, digits and underscores, starting with a letter, e.g. vat_number."),
      label: text("The name people see, e.g. VAT number."),
      fieldType: oneOf(FIELD_TYPES, "Kind of value (default text)."),
    }),
  },
  {
    name: "score-contact",
    displayName: "Score contact",
    description:
      "A 0-100 rule score for a contact with a plain breakdown, plus (with smart sorting on) fit, intent and urgency levels 0-3 stored on the contact. A hint for who to follow up first, never a reason to change a person's fields.",
    parametersSchema: schema(["contactId"], { contactId: P.contactId }),
  },
  {
    name: "find-duplicates",
    displayName: "Find duplicate contacts",
    description: "Contacts that share an email address. Merge only after a person confirmed they are the same person.",
    parametersSchema: schema([], {}),
  },
  {
    name: "merge-contacts",
    displayName: "Merge contacts",
    description:
      "Fold a duplicate contact into the primary: links, deals, activities, facts and sequences move, then the duplicate is deleted. Only after a person confirmed they are the same person.",
    parametersSchema: schema(["primaryContactId", "duplicateContactId"], {
      primaryContactId: text("The contact to keep."),
      duplicateContactId: text("The contact to fold in and delete."),
    }),
  },
  {
    name: "bulk-tag-contacts",
    displayName: "Bulk tag contacts",
    description: "Add or remove tags on many contacts at once.",
    parametersSchema: schema(["contactIds", "tags", "action"], {
      contactIds: textList("The contact ids."),
      tags: textList("The tags to add or remove."),
      action: oneOf(["add", "remove"], "add or remove the tags."),
    }),
  },
  {
    name: "import-contacts",
    displayName: "Import contacts",
    description: "Create contacts from CSV text. Only import people who agreed to hear from us or are existing clients (POPIA). Search first to avoid duplicates.",
    parametersSchema: schema(["csv"], {
      csv: text("CSV with a header row: name, emails, phones, lifecycle, tags (only name is required). Separate several values with ;."),
    }),
  },
  {
    name: "create-saved-view",
    displayName: "Create saved view",
    description: "Save a named filter view for contacts, companies or deals so a person can open it later.",
    parametersSchema: schema(["name", "recordType"], {
      name: text("The view's name, e.g. Hot leads."),
      recordType: P.recordType,
      filters: bag("The filter values to save, e.g. { lifecycle: customer, tag: retainer }."),
    }),
  },
  {
    name: "list-saved-views",
    displayName: "List saved views",
    description: "The saved filter views for this workspace.",
    parametersSchema: schema([], {}),
  },
  {
    name: "delete-saved-view",
    displayName: "Delete saved view",
    description: "Delete a saved filter view.",
    parametersSchema: schema(["viewId"], { viewId: text("The view id (from list-saved-views).") }),
  },

  // -------------------------------------------------------------------------
  // Deals and products
  // -------------------------------------------------------------------------
  {
    name: "create-deal",
    displayName: "Create deal",
    description:
      "Create a deal (a sale in progress) in the first open stage for a client. Link it with companyRecordId and/or contactId. Returns its id. Put its id on the Billing quote so acceptance closes it.",
    parametersSchema: schema(["title"], {
      title: text("What is being sold, e.g. Website rebuild."),
      amountMinor: P.amountMinor,
      currency: P.currency,
      companyRecordId: P.companyRecordId,
      contactId: P.contactId,
      nextActionKind: P.nextActionKind,
      nextActionDueAt: P.nextActionDueAt,
    }),
  },
  {
    name: "move-deal",
    displayName: "Move deal",
    description:
      "Move a deal to another stage. Won makes the client a customer, logs the win and tells Billing and the Cockpit (a first win starts onboarding). Won or lost stops the contact's sequences.",
    parametersSchema: schema(["dealId", "stageId"], {
      dealId: P.dealId,
      stageId: text("Stage id from list-stages. A stage name (e.g. Proposal) or the word won or lost also works."),
      quoteId: text("Only with stageId won: the accepted quote this deal closes (from a pick-the-deal hand-off). The deal records it."),
    }),
  },
  {
    name: "update-deal",
    displayName: "Update deal",
    description:
      "Fix a deal: its title, value or currency, who it is for (companyRecordId and/or contactId; an empty string unlinks), or its stage (a move, like move-deal). Send only what changes. A field a person locked keeps its value. A deal needs its client before Billing can quote it.",
    parametersSchema: schema(["dealId"], {
      dealId: P.dealId,
      title: text("What is being sold, e.g. Website rebuild."),
      amountMinor: P.amountMinor,
      currency: P.currency,
      companyRecordId: text("The CRM company this deal is for (company:<id> also works). An empty string unlinks it."),
      contactId: text("The CRM contact this deal is with (contact:<id> also works). An empty string unlinks it."),
      stageId: text("Move to this stage: id from list-stages, a stage name, or won or lost. Won makes the client a customer and tells Billing."),
    }),
  },
  {
    name: "create-product",
    displayName: "Create product",
    description: "Add a product or service to the catalog, to itemise deals.",
    parametersSchema: schema(["name"], {
      name: text("Product or service name, e.g. SEO retainer."),
      description: text("One line on what it includes."),
      unitAmountMinor: int("Price per unit in minor units: 150000 is R 1,500.00.", { minimum: 0 }),
      currency: P.currency,
    }),
  },
  {
    name: "update-product",
    displayName: "Update product",
    description: "Change a product in the catalog. Only the fields you send change.",
    parametersSchema: schema(["productId"], {
      productId: P.productId,
      name: text("Product or service name."),
      description: text("One line on what it includes."),
      unitAmountMinor: int("Price per unit in minor units.", { minimum: 0 }),
      currency: P.currency,
      isActive: bool("false hides it from new deals."),
    }),
  },
  {
    name: "add-deal-product",
    displayName: "Add deal product",
    description: "Add a product line to a deal to itemise what it sells.",
    parametersSchema: schema(["dealId", "productId"], {
      dealId: P.dealId,
      productId: P.productId,
      quantity: int("Units, a whole number of at least 1 (default 1).", { minimum: 1 }),
      unitAmountMinor: int("Price per unit in minor units (default: the product's price).", { minimum: 0 }),
    }),
  },
  {
    name: "list-deal-products",
    displayName: "List deal products",
    description: "The product lines on a deal.",
    parametersSchema: schema(["dealId"], { dealId: P.dealId }),
  },

  // -------------------------------------------------------------------------
  // Sequences
  // -------------------------------------------------------------------------
  {
    name: "create-sequence",
    displayName: "Create sequence",
    description:
      "Create a follow-up sequence and its steps. delivery issue (default): each due step opens an issue to do by hand. delivery email: the Mailbox sends each step as marketing email once a person approved the sequence. Every email step must say who we are and how to opt out.",
    parametersSchema: schema(["name"], {
      name: text("The sequence name, e.g. New lead follow-up."),
      completionMode: oneOf(COMPLETION_MODES, "How a step issue completes: manual (mark it done when the step is done) or sent (mark it done only once the message really went out). Email delivery ignores it."),
      delivery: oneOf(SEQUENCE_DELIVERIES, "issue (default) or email (needs a person's approval once)."),
      steps: {
        type: "array",
        description: "The steps in order. Without steps the sequence gets one Reach out step.",
        items: {
          type: "object",
          properties: {
            position: int("Order, starting at 1 (default: the list order).", { minimum: 1 }),
            delayMinutes: int("Minutes to wait after the previous step (after enrolling, for step 1). 1440 is one day.", { minimum: 0 }),
            title: text("Step name; for email delivery the subject line. Tokens work here too."),
            body: text("What to do or say; for email the text. Tokens: {{first_name}}, {{last_name}}, {{name}}, {{company}}, {{email}}, with a fallback like {{first_name|there}}."),
          },
          required: ["title"],
        },
      },
    }),
  },
  {
    name: "set-sequence-delivery",
    displayName: "Set sequence delivery",
    description:
      "Choose how a sequence's due steps go out: issue (done by hand) or email (the Mailbox sends it). The first switch to email opens an approval issue for a person; nothing is emailed until they mark it done. You cannot approve it.",
    parametersSchema: schema(["sequenceId", "delivery"], {
      sequenceId: P.sequenceId,
      delivery: oneOf(SEQUENCE_DELIVERIES, "issue or email."),
    }),
  },
  {
    name: "enroll-contact",
    displayName: "Enroll contact",
    description:
      "Start a sequence for a contact. One running enrollment per contact per sequence. Email sequences refuse contacts who opted out or bounced. Never enroll a client's leads or people without consent.",
    parametersSchema: schema(["sequenceId", "contactId"], {
      sequenceId: P.sequenceId,
      contactId: P.contactId,
    }),
  },
];
