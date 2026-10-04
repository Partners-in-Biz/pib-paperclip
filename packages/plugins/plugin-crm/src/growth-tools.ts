import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import { CHANNELS, UNATTRIBUTED } from "./channels.js";
import { LEAD_OUTCOMES } from "./attribution-store.js";
import { CONSENT_MODES, EVENT_KEY_STATUSES } from "./site-events-form.js";

/**
 * The growth tools: where leads, customers and money came from (attribution), and the minimal site events behind it (a write key, a
 * snippet that is only ever RETURNED, and the counts). Every parameter has a description; results are JSON with ids, refs and plain
 * money. Nothing here installs anything on a client's site.
 */

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

const text = (description: string): JsonSchema => ({ type: "string", description });
const oneOf = (values: readonly string[], description: string): JsonSchema => ({ type: "string", enum: [...values], description });
const int = (description: string, extra: Record<string, unknown> = {}): JsonSchema => ({ type: "integer", description, ...extra });
const bool = (description: string): JsonSchema => ({ type: "boolean", description });

const P = {
  client: text("The client: company:<id> or contact:<id> (from find-records). Leave out for our own website and leads."),
  clientRequired: text("The client: company:<id> or contact:<id> (from find-records)."),
  period: text("The month as YYYY-MM, e.g. 2026-09."),
  days: int("Or the last N days (default 30; for attribution-report 90 is a better start).", { minimum: 1, maximum: 400 }),
  keyId: text("The event key id (from list-event-keys)."),
};

export const GROWTH_TOOLS: PluginToolDeclaration[] = [
  {
    name: "attribution-report",
    displayName: "Where leads and money came from",
    description:
      "Source-to-revenue by channel (organic search, social, email, paid, referral, direct, other, and an unattributed bucket), with first touch and last touch, qualified leads, deals won, money paid and any cost recorded, for our own website forms (no client: lead capture -> contact -> deal -> invoice Billing says is paid) or for one client's own forms (their enquiries and what they told us became of each). Also carries the client's site visits and conversions by channel when a site events key counts them. The notes say the model's limits; repeat them to anyone who reads the numbers, and never present a number the report does not show. A client's revenue is only what they reported (record-lead-outcome).",
    parametersSchema: schema([], { client: P.client, period: P.period, days: P.days }),
  },
  {
    name: "record-channel-cost",
    displayName: "Record what a channel cost",
    description: "Record what a channel cost for one month (an agency fee for SEO, ad spend the client told you about) so the report can show cost per lead. It replaces the figure already recorded for that channel and month. Only record a cost you were given or can read; never estimate one.",
    parametersSchema: schema(["channel", "period", "amountMinor"], {
      client: P.client,
      channel: oneOf([...CHANNELS, UNATTRIBUTED], "Which channel the cost belongs to."),
      period: P.period,
      amountMinor: int("The cost in cents (R 1,500.00 is 150000).", { minimum: 0 }),
      currency: text("3-letter currency code. Default: the CRM's default currency."),
      note: text("Where the figure came from, e.g. the invoice or what the client said."),
    }),
  },
  {
    name: "list-client-leads",
    displayName: "List a client's enquiries",
    description: "A client's enquiries from its own website form, social messages and email, with where each came from (first and last touch channel) and what became of it. No email addresses or phone numbers. Use it to ask the client what became of each enquiry, then record-lead-outcome.",
    parametersSchema: schema(["client"], { client: P.clientRequired, period: P.period, days: P.days, outcome: oneOf(LEAD_OUTCOMES, "Only enquiries with this outcome.") }),
  },
  {
    name: "record-lead-outcome",
    displayName: "Record what became of an enquiry",
    description: "Record what the client told you became of one of its enquiries: contacted, qualified, won (with the value in cents when they gave it) or lost. This is what lets the client's report show which channel brought work. Only record what the client said.",
    parametersSchema: schema(["client", "key", "outcome"], {
      client: P.clientRequired,
      key: text("The enquiry's key (from list-client-leads)."),
      outcome: oneOf(LEAD_OUTCOMES, "What became of it."),
      valueMinor: int("What the work was worth, in cents, only with outcome won.", { minimum: 0 }),
      currency: text("3-letter currency code. Default: the CRM's default currency."),
    }),
  },
  {
    name: "create-event-key",
    displayName: "Make a site events key",
    description:
      "Make a write key and the snippet that counts visits, outbound clicks and named conversions (form sent, call clicked, WhatsApp clicked) on a client's site (or ours, with no client). It counts only: no name, email, phone, form content or visitor id; Do Not Track is honoured; consentMode required makes it wait for the site's own cookie banner. This tool only RETURNS the snippet and the install steps. Installing it changes the client's site: it needs the owner's OK and goes through the client's repo project or their developer, never by you on the live site. One key per client and label.",
    parametersSchema: schema([], {
      client: P.client,
      label: text("A name for the key, e.g. \"Acme website\". The same label for the same client returns the same key."),
      siteId: text("One of the client's websites (list-client-sites)."),
      siteUrl: text("Or the site's address, e.g. https://acme.co.za. Events from another site are refused."),
      consentMode: oneOf(CONSENT_MODES, "anonymous (default): counts only, nothing kept on the visitor's device but a per-tab note. required: nothing is sent until the site's own banner calls pibEvents.consent(true)."),
    }),
  },
  {
    name: "list-event-keys",
    displayName: "List site events keys",
    description: "Every site events key (or one client's) with its counts, last event and what to do next. It warns about a key that never counted an event (the snippet is probably not installed). No secrets: a write key is public by design.",
    parametersSchema: schema([], { client: P.client, ownOnly: bool("true: only our own keys, not any client's.") }),
  },
  {
    name: "update-event-key",
    displayName: "Change a site events key",
    description: "Rename a key, change its consent mode, or pause and resume it. Only a person switches one off for good (put it on Needs you).",
    parametersSchema: schema(["keyId"], {
      keyId: P.keyId,
      label: text("A new name."),
      consentMode: oneOf(CONSENT_MODES, "anonymous or required."),
      status: oneOf(EVENT_KEY_STATUSES, "paused or active. revoked is for a person only."),
    }),
  },
  {
    name: "rotate-event-key",
    displayName: "Rotate a site events key",
    description: "Make a new write key; the old one keeps counting for 7 days so the snippet can be swapped. Give the new snippet to the client's developer (never install it yourself). Once the old key stops, a snippet nobody swapped counts nothing, so rotate a key that is installed on a live site only after the owner has agreed to the swap: put one Needs-you item on the client, never a chat message.",
    parametersSchema: schema(["keyId"], { keyId: P.keyId }),
  },
  {
    name: "site-events-report",
    displayName: "Site visits and conversions",
    description: "Visits (a visit starts with its first page), pages viewed, clicks to other sites and conversions for a client's sites (or ours), by channel and by name, with the top pages, and a funnel. Counts are estimates: say so. For enquiries and revenue by source use attribution-report.",
    parametersSchema: schema([], { client: P.client, period: P.period, days: P.days }),
  },
];
