import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

const str = (description: string): JsonSchema => ({ type: "string", description });
const int = (description: string): JsonSchema => ({ type: "integer", description, minimum: 0 });
const oneOf = (values: readonly string[], description: string): JsonSchema => ({ type: "string", enum: [...values], description });
const list = (description: string): JsonSchema => ({ type: "array", items: { type: "string" }, description });

const client = str('Whose ads: leave out for PiB\'s own ads, or "company:<id>" / "contact:<id>" for one CRM client (the id from the CRM). One scope per call; never mix scopes.');
const clientOrAll = str('Whose ads: leave out for PiB\'s own ads, "company:<id>" / "contact:<id>" for one CRM client, or "all" for every scope (read-only overviews; never use it to decide work for one client).');
const period = oneOf(["last_7d", "last_30d", "this_month", "last_month"], "A ready-made period. Default last_7d. Or pass since and until.");

const creative: JsonSchema = {
  type: "object",
  description: "The ad copy. At least a headline or primaryText.",
  additionalProperties: false,
  properties: {
    headline: str("Headline. Google allows 30 characters, Meta shows about 40."),
    primaryText: str("Main text. Meta shows about 125 characters before cutting it."),
    description: str("Description line (Google 90 characters)."),
    callToAction: str("Button text, e.g. Learn more."),
    landingUrl: str("The https page the ad sends people to."),
  },
};

const proposalFields: Record<string, JsonSchema> = {
  accountId: str("The ad account's id from list-ad-accounts (the plugin's id, not the platform's). Needed for create_campaign and change_budget."),
  name: str("create_campaign: the new campaign's name. creative_check: a label for the copy."),
  objective: str("create_campaign: Meta OUTCOME_LEADS, OUTCOME_TRAFFIC, OUTCOME_SALES, OUTCOME_AWARENESS, OUTCOME_ENGAGEMENT or OUTCOME_APP_PROMOTION; Google SEARCH (the only Google type version 0.1 creates). Default OUTCOME_LEADS / SEARCH."),
  dailyBudgetMinor: int("create_campaign: the daily budget in minor units of the account's currency (15000 means 150.00)."),
  startDate: str("create_campaign: YYYY-MM-DD it should start. Leave out to start when someone switches it on."),
  endDate: str("create_campaign: YYYY-MM-DD it should end. Leave out for no end date (the approval then shows an open-ended commitment)."),
  specialAdCategories: list("Meta special ad categories that apply (CREDIT, EMPLOYMENT, HOUSING, ISSUES_ELECTIONS_POLITICS...). Empty when none apply."),
  audience: str("create_campaign: who it is for, in words. Audiences and ad sets are built in the platform in version 0.1; this is for the approver and the person building it."),
  creative,
  notes: str("Anything the approver should know."),
  campaignExternalId: str("change_budget: the campaign's platform id from list-ad-campaigns."),
  newDailyBudgetMinor: int("change_budget: the new daily budget in minor units."),
  targets: {
    type: "array",
    description: "pause_campaign / resume_campaign: the campaigns, each { accountId, campaignExternalId } from list-ad-campaigns (up to 25).",
    items: { type: "object", additionalProperties: false, required: ["accountId", "campaignExternalId"], properties: { accountId: str("The plugin's account id."), campaignExternalId: str("The campaign's platform id.") } },
  },
  platform: oneOf(["meta", "google"], "creative_check: which platform's rules to check the copy against."),
  reason: str("Why, in a sentence or two, with the numbers that justify it. The Reviewer and the approver read this."),
};

export const ADS_TOOLS: PluginToolDeclaration[] = [
  {
    name: "list-ad-accounts",
    displayName: "List ad accounts",
    description: "Registered ad accounts with their scope, platform, currency, connection status and last sync, plus each scope's monthly cap, spend so far, and whether changes are switched on. Start here.",
    parametersSchema: schema([], { client: clientOrAll }),
  },
  {
    name: "list-ad-connections",
    displayName: "List ad connections",
    description: "The platform sign-ins (Meta, Google) and their status. With connectionId it also lists the ad accounts that sign-in can see and which are already registered, so you can pick one for register-ad-account. A person signs in; you never see a token.",
    parametersSchema: schema([], { connectionId: str("Optional. List the ad accounts this connection can see.") }),
  },
  {
    name: "register-ad-account",
    displayName: "Register an ad account",
    description: "Put an ad account (one the connection can see) under PiB's own ads or one client. It is read-only and starts syncing; it does not change anything in the platform. An account belongs to one scope; a scope has one currency.",
    parametersSchema: schema(["connectionId", "externalId"], {
      connectionId: str("From list-ad-connections."),
      externalId: str("The platform's own account id (Meta: the number after act_; Google: the customer id without dashes), from list-ad-connections with connectionId."),
      client,
      conversionActions: list("Meta only: which result types count as a conversion, in order of preference (e.g. lead, purchase). Leave out for the default order."),
    }),
  },
  {
    name: "sync-ad-account",
    displayName: "Sync ad numbers now",
    description: "Read the latest campaigns and daily numbers from the platform now (read-only), then re-check the alerts. The plugin also does this every 3 hours. Use it when you need fresh numbers or after a change ran.",
    parametersSchema: schema([], { accountId: str("One account; leave out for every active account."), days: { type: "integer", minimum: 1, maximum: 90, description: "How many days back to re-read (default 3; 30 on an account's first sync)." } }),
  },
  {
    name: "get-ads-summary",
    displayName: "Cross-platform ads summary",
    description: "Spend, impressions, clicks, conversions, CPC, CPA and ROAS across Meta and Google, grouped by platform, campaign, day, account or scope, with totals per currency. Amounts are minor units plus formatted text. Never add different currencies yourself.",
    parametersSchema: schema([], {
      client: clientOrAll,
      period,
      since: str("YYYY-MM-DD start (with until)."),
      until: str("YYYY-MM-DD end; default today."),
      groupBy: oneOf(["platform", "campaign", "day", "account", "scope"], "How to group. Default platform."),
      platform: oneOf(["meta", "google"], "Only this platform."),
    }),
  },
  {
    name: "list-ad-campaigns",
    displayName: "List campaigns",
    description: "Campaigns with status, daily budget and the last 7 days of spend, clicks, conversions, CPC, CPA and ROAS. The ids here are what propose-ad-change needs.",
    parametersSchema: schema([], { client: clientOrAll, accountId: str("Only this account (the plugin's id)."), status: oneOf(["active", "paused", "archived", "other"], "Only campaigns in this state.") }),
  },
  {
    name: "get-spend-ledger",
    displayName: "Spend ledger",
    description: "The append-only ledger of spend: one entry per change to a campaign's spend for a day, newest first. Use it to explain why a month's total moved (the platforms restate recent days).",
    parametersSchema: schema([], { client: clientOrAll, accountId: str("Only this account."), month: str("YYYY-MM."), limit: { type: "integer", minimum: 1, maximum: 500, description: "How many entries (default 100)." } }),
  },
  {
    name: "get-budget-status",
    displayName: "Budget status",
    description: "Per scope: the month's cap, spend so far, percentage used against how much of the month has passed, run-rate and committed projections, headroom, the alert point (90% by default), whether changes are switched on, who must sign, and any open pause request.",
    parametersSchema: schema([], { client: clientOrAll }),
  },
  {
    name: "list-ad-alerts",
    displayName: "List ad alerts",
    description: "Anomalies the plugin raised: spend spike, no delivery, cost per result over target, budget nearly used, numbers not updating. Default: open ones.",
    parametersSchema: schema([], { client: clientOrAll, status: oneOf(["open", "acknowledged", "resolved"], "Default open.") }),
  },
  {
    name: "acknowledge-ad-alert",
    displayName: "Acknowledge an alert",
    description: "Say you looked at an alert and what you concluded (fine, expected, or a proposal is on its way). Required before you close an alert issue.",
    parametersSchema: schema(["alertId", "note"], { alertId: str("From list-ad-alerts."), note: str("One line: what you found and what happens next.") }),
  },
  {
    name: "set-ad-scope-rules",
    displayName: "Set a scope's targets and brand rules",
    description: "Set the cost per result to aim for (alerts compare against it), add banned words (copy using them cannot go to review) and a brand note. You can add banned words, never remove them. You cannot touch caps or switches: those are people's.",
    parametersSchema: schema([], {
      client,
      targetCpaMinor: int("The cost per conversion to aim for, in minor units. 0 clears it."),
      bannedWords: list("The client's banned words and phrases from their brand profile (get-client-profile in the CRM). The full list: it replaces the stored one, and words may only be added by you."),
      brandNote: str("A short note about the client's voice for the Reviewer."),
    }),
  },
  {
    name: "check-ad-creative",
    displayName: "Check ad copy",
    description: "A first machine check of ad copy: the client's banned words, text longer than the platform accepts, claims platform policy rejects, a missing or insecure landing page, special ad categories. It does not clear the copy: propose it as a creative_check or inside a campaign proposal, and the Reviewer reads it against the brand profile.",
    parametersSchema: schema(["platform"], {
      client,
      platform: oneOf(["meta", "google"], "Which platform's rules."),
      headline: str("Headline."),
      primaryText: str("Main text."),
      description: str("Description."),
      callToAction: str("Button text."),
      landingUrl: str("Landing page."),
      specialAdCategories: list("Meta special ad categories declared."),
      bannedWords: list("Extra banned words to test (the scope's stored ones are always used)."),
    }),
  },
  {
    name: "propose-ad-change",
    displayName: "Propose an ad change",
    description:
      "Ask for a campaign or budget change as a proposal with the numbers. kinds: create_campaign (made PAUSED), change_budget (daily budget of one campaign), pause_campaign, resume_campaign, creative_check (clear ad copy; changes nothing). It opens an issue that goes to the Reviewer, then a person (and the client's own yes when the scope needs it). Nothing runs until every sign-off is recorded and, even then, only when changes are switched on for the scope. Money is minor units.",
    parametersSchema: schema(["kind"], { kind: oneOf(["create_campaign", "change_budget", "pause_campaign", "resume_campaign", "creative_check"], "What to change."), client, ...proposalFields }),
  },
  {
    name: "revise-ad-proposal",
    displayName: "Revise a proposal",
    description: "Change a proposal after the Reviewer asked for changes, or to fix a blocker. Send only what changes. If the numbers change, every earlier yes stops counting and the Reviewer looks again.",
    parametersSchema: schema(["proposalId"], { proposalId: str("From propose-ad-change or list-ad-proposals."), ...proposalFields }),
  },
  {
    name: "list-ad-proposals",
    displayName: "List proposals",
    description: "Proposals with status and what each waits for. Default: the open ones (needs changes, waiting for approval, approved).",
    parametersSchema: schema([], { client: clientOrAll, status: str("open (default), or one of needs_changes, in_review, approved, executing, executed, cleared, failed, rejected, cancelled, expired.") }),
  },
  {
    name: "get-ad-proposal",
    displayName: "Get a proposal",
    description: "One proposal in full: the numbers, cap and pacing, checks, who has signed and who is missing, the Reviewer's notes, the ready-made message for the client, the approvalId (once approved) and the next step.",
    parametersSchema: schema(["proposalId"], { proposalId: str("The proposal's id.") }),
  },
  {
    name: "record-ad-review",
    displayName: "Record the Reviewer's verdict",
    description: "The Reviewer only: record pass or changes on a proposal after checking the numbers, the cap lines and the copy against the client's brand profile. A pass hands the issue to the approver; changes hand it back to the ads agent. Refused for any other agent, including the one that asked for the change. You never approve.",
    parametersSchema: schema(["proposalId", "verdict"], { proposalId: str("The proposal's id (it is on the issue)."), verdict: oneOf(["pass", "changes"], "pass, or changes with notes."), notes: str("One line per problem when verdict is changes; optional on a pass.") }),
  },
  {
    name: "record-client-request",
    displayName: "Record that the client was asked",
    description: "After you create the CRM request that asks the client for their yes (partnersinbiz.crm:create-client-action), tell the plugin which request it was. The client's yes itself is recorded by a person, from what the client wrote.",
    parametersSchema: schema(["proposalId", "clientActionId"], { proposalId: str("The proposal's id."), clientActionId: str("The CRM client request's id.") }),
  },
  {
    name: "cancel-ad-proposal",
    displayName: "Cancel a proposal",
    description: "Withdraw a proposal that is no longer wanted. Its issues are closed. Nothing was changed in any platform.",
    parametersSchema: schema(["proposalId"], { proposalId: str("The proposal's id."), reason: str("Why.") }),
  },
  {
    name: "execute-ad-change",
    displayName: "Run an approved ad change",
    description:
      "Run an approved change. Needs the proposalId and the approvalId of the owner's yes (get-ad-proposal shows it once approved). The plugin re-checks everything and refuses with the reason: every sign-off in, changes switched on for the company AND the scope, the connection allowed to change ads, a monthly cap and the change inside it, the numbers unchanged. An approval runs one change once and expires after 72 hours. A created campaign is paused.",
    parametersSchema: schema(["proposalId", "approvalId"], { proposalId: str("The approved proposal's id."), approvalId: str("The owner's approval id, from get-ad-proposal.") }),
  },
];
