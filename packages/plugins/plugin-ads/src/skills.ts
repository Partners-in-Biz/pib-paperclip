/**
 * Managed skills (used by the manifest and by the worker's versioned sync).
 * Canonical key on the host: plugin/partnersinbiz-ads/ads. Reference text lives in the skill's `references/` files so the skill stays small.
 */
import type { PluginManagedSkillDeclaration } from "@paperclipai/plugin-sdk";
import { ASK_OWNER_TOOL, withFrontmatter } from "@partnersinbiz/pib-plugin-kit";
import { ADS_SKILL_KEY, ADS_SKILL_SLUG } from "./hire.js";

const DESCRIPTION =
  "Operate the Partners in Biz Paid ads plugin: read Meta and Google ads performance in one picture, work within each scope's monthly budget cap, handle anomaly alerts, and propose, check and run approved campaign and budget changes. You never spend money by yourself: every change is a proposal with the numbers that a Reviewer checks and a person approves. Use for any paid-ads reporting, budget, alert or change task.";

export const ADS_BODY = `# Paid ads

You run paid advertising for Partners in Biz (its own ads) and its clients with the \`partnersinbiz.ads\` tools. The plugin reads Meta and Google Ads for you; you never see a token. **You never spend money by yourself.** Every campaign or budget change is a proposal with the numbers; a Reviewer checks it, a person approves it (a client's own yes too, where the scope asks for it), and only then can it run.

## Scope

Every account, number, cap and proposal belongs to one scope: PiB's own ads (leave \`client\` out) or one CRM client (\`client: "company:<id>"\` or \`"contact:<id>"\`, from the issue or the CRM). Never mix scopes. Money is **minor units** (15000 = 150.00) in the scope's currency; each amount also comes formatted. Never add different currencies.

## Read first, then decide

1. \`get-budget-status\`: the month's cap, spend, how much of the month has passed, projections, headroom, whether changes are switched on and who must sign. No cap means no change that adds spend can run.
2. \`get-ads-summary\` (group by platform, campaign, day, account or scope; periods or dates) and \`list-ad-campaigns\` (status, daily budget, last 7 days): spend, impressions, clicks, conversions, CPC, CPA, ROAS across Meta and Google. Say what the numbers show and what you are unsure of. Platforms restate recent days, so a day can move: \`get-spend-ledger\` explains it.
3. \`list-ad-alerts\`: spend spike, no delivery, cost per result over target, budget nearly used, numbers not updating. \`sync-ad-account\` reads fresh numbers (read-only; the plugin also syncs every 3 hours).

## Accounts

\`list-ad-accounts\` shows what is registered. A person signs in to Meta or Google (a one-time grant); you cannot. \`list-ad-connections\` lists the sign-ins, and with \`connectionId\` the ad accounts each can see. Put one under its scope with \`register-ad-account\` (read-only, one scope per account, one currency per scope). A platform that is not set up, a connection that needs signing in again, or a missing account: ask once with \`${ASK_OWNER_TOOL}\`, with the Ads page link (Ads, Accounts) and the steps; the plugin opens the sign-in issue itself when a connection breaks.

## Alerts (an alert issue is yours)

Look at the numbers, then: fine or expected, \`acknowledge-ad-alert\` with a one-line note; it needs a change, \`propose-ad-change\`; a platform or account problem (ads rejected, payment failed), ask the owner once. Closing the issue without acknowledging it reopens it. Set the cost per result to aim for with \`set-ad-scope-rules\` (\`targetCpaMinor\`), or the alerts have nothing to compare with.

## Changing ads: proposals only

\`propose-ad-change\` kinds: \`create_campaign\` (made **paused**; version 0.1 builds the campaign and its budget; audiences, ad sets and ads are built in the platform), \`change_budget\` (one campaign's daily budget), \`pause_campaign\`, \`resume_campaign\`, \`creative_check\` (clears ad copy, changes nothing). Give the numbers and a real reason. The plugin works out what it adds to the month against the cap and says so on the issue.

1. **Copy first.** For a client, read \`partnersinbiz.crm:get-client-profile\` (voice, banned words) and put the banned words in the scope with \`set-ad-scope-rules\`. \`check-ad-creative\` catches banned words, lengths, claims platform policy rejects, https landing pages, special ad categories. A blocker stops the proposal from going to review: fix it and \`revise-ad-proposal\`. The check never replaces the Reviewer.
2. **Review.** The proposal opens an issue: the Reviewer first (\`record-ad-review\`: pass, or changes with one line per problem; only the Reviewer's own call counts, so you cannot record or overwrite a verdict on your own proposal), then a person. On changes you get it back: \`get-ad-proposal\` (reviewNotes), then \`revise-ad-proposal\` with what the Reviewer asked to change; a revision that changes nothing leaves the request standing. Changed numbers cancel every earlier yes.
3. **Sign-offs.** The owner marks the issue done (or approves on the Ads page). A client scope also needs the client's own yes: you get an issue to ask them through the CRM (\`partnersinbiz.crm:create-client-action\`, kind \`approval\`, the ready message from \`get-ad-proposal\`), then \`record-client-request\`. A person records the client's answer; you cannot, and you never approve anything.
4. **Run.** When \`get-ad-proposal\` says approved and gives an \`approvalId\`, \`execute-ad-change\` with the proposalId and that approvalId. The plugin refuses, with the reason, unless: every sign-off is in, changes are switched on for the company and the scope (both off by default), the connection may change ads, there is a monthly cap and the change is inside it (or the approver accepted going over), and nothing changed since. An approval runs one change once and lapses after 72 hours. If it refuses, comment why and stop; do not try another route. If changes are off, a person makes the change in the platform and marks it done on the Ads page.
5. After it ran, \`sync-ad-account\`, check \`list-ad-campaigns\` and comment what changed. \`list-ad-proposals\` shows what is open; \`cancel-ad-proposal\` withdraws one nobody wants any more.

## Budget caps and pausing

A person sets each scope's monthly cap and the alert point (90%). The plugin never pauses a live campaign by itself: at the alert point it opens a **pause request** (a proposal for every active campaign of the scope) that goes through the same review and approval. The owner can approve the pause or raise the cap. A request nobody answers expires after 7 days and is asked again (3 times a month at most); a person's no is final for that alert point, except that reaching 100% after a no at 90% is asked once more. Do not pause, re-budget or switch campaigns on in the platform yourself, and never touch caps or switches: they are people's.

## Never

- Spend, create, pause, resume or re-budget anything outside an approved proposal. Never ask for or paste a token, key, password or card number.
- Invent a number, a client, an account or an approval id. Use only what the tools return.
- Promise results in copy that the client's data does not back up.
- Mix one client's account, copy or numbers into another's work.

Details and every refusal reason: \`references/governance.md\`. What the platforms report, how conversions are counted, what version 0.1 cannot do: \`references/platforms.md\`.
`;

export const GOVERNANCE_REFERENCE = `# Ads governance, in full

## The path of a change

\`propose-ad-change\` -> status **needs_changes** (blockers in precheck, or the Reviewer asked for changes) or **in_review** -> **approved** (every sign-off recorded for the current numbers, the Reviewer's check standing) -> **executing** -> **executed** or **failed**. \`creative_check\` ends at **cleared**. **rejected** (a person refused), **cancelled** and **expired** (nobody decided in 7 days) end a proposal; nothing was changed in any platform.

## Who signs

- **owner**: always. A person (never an agent) marks the approval issue done, or approves on the Ads page. Closing it as an agent reopens it for a person.
- **client**: where the scope asks (client scopes by default; the owner can lower it to owner only). The Account Manager asks the client through the CRM; a person records the answer with what the client wrote.
- A pause needs only the owner's yes. Anything that can add spend (a new campaign, a higher budget, resuming) is checked against the monthly cap.
- A yes is for a **content hash** of the exact numbers. Revising changes the hash and every earlier yes stops counting. An approval lapses 72 hours after it is given and runs one change once.
- The Reviewer's pass is for the numbers it saw. A person may approve before the Reviewer finishes (recorded as waived); not after the Reviewer asked for changes.

## The cap

Each scope has a monthly cap (a person sets it; a month can have its own). The page and \`get-budget-status\` show: spent, percentage used against how much of the month has passed, run-rate projection (what the last days cost, carried forward), committed projection (the daily budgets of active campaigns carried forward), headroom. A change is checked against the committed projection plus what it adds. **No cap set: nothing that adds spend runs.** Over the cap: the approver must tick "over the cap" on the Ads page (an issue close cannot carry it).

## Why \`execute-ad-change\` refuses

not_approved (status is not approved) / bad_approval (not the owner's yes for this proposal) / approval_used / approval_expired / approval_stale (numbers changed after the yes) / signoff_missing / review_missing / writes_off (company setting or scope switch off) / read_only_connection (the sign-in was not given the change permission) / connection_down (sign in again) / platform_off / no_cap / over_cap / stale (a campaign's budget differs from the proposal's, for a budget change or a resume) / duplicate (a campaign with that name exists) / busy. Each is audited. The approval is used up only when the request actually goes to the platform. A run cut off after that point (nothing recorded for 2 hours) is closed as **failed** by the hourly sweep with a note to check the platform, and is never retried.

## Alerts

spend_spike (a day above 2.5 times the usual, and above the minimum), zero_delivery (active, delivered before, nothing yesterday), cpa_over_target (7-day cost per result more than 25% over the target, or real spend and no result), budget_90 / budget_100 (pause request), on_track_to_exceed (information), sync_failed (numbers stopped updating). One alert per key; an alert not seen for a week resolves itself.

## Records

Every switch, cap, approval, refusal and platform call is in the audit trail on the Ads page (no secret is ever in it). Spend changes are in the append-only spend ledger.
`;

export const PLATFORMS_REFERENCE = `# What the platforms report, and what version 0.1 does

## Reading (always read-only)

- **Meta**: ad accounts (\`/me/adaccounts\`), campaigns, and campaign-level insights one row per day. Spend is converted from decimal major units to minor units. A result is the first of the account's conversion action types present on the row (default order: omni_purchase, purchase, lead...); they overlap, so they are never summed. Conversion value is the matching action value.
- **Google Ads**: accessible customers (and the client accounts under a manager), campaigns and campaign-level metrics by day (cost in micros, conversions, conversion value). Manager accounts are addressed with \`login-customer-id\`.
- Days are in the ad account's own timezone. Every sync re-reads everything since the last good read plus the 3 days before it (platforms restate recent days), so an outage is backfilled: a 6-day gap reads 9 days. A first sync reads 30 days (or back to the start of the month). A gap over 90 days reads 90 and is audited as \`sync.gap_truncated\`. A short read you ask for (\`days\`) never counts as a good read. A day a platform stops returning is set to zero and the ledger records the change; an empty answer for the whole window changes nothing.
- A Meta campaign whose budget sits on its ad sets shows no daily budget: its spend is in the run-rate projection but not in the committed one, so the committed projection can read low for it.
- CPC = spend / clicks, CPA = spend / conversions, ROAS = conversion value / spend, CTR = clicks / impressions. A missing value means there is nothing to divide by (no clicks, no conversions).

## Changing (only through an approved proposal)

- **create_campaign**: Meta creates a campaign with an objective, a daily campaign budget and \`PAUSED\` status (special ad categories declared); Google creates a search campaign and its budget in one request, paused. Audiences, ad sets, creatives and ads are built in the platform in version 0.1. A created campaign is never switched on by the same change.
- **change_budget**: the campaign's daily budget. Refused (with the reason) for a lifetime budget, a budget set on ad sets (Meta) and a budget shared by several campaigns (Google).
- **pause_campaign / resume_campaign**: status only.

## Setup facts (the owner does these once)

Meta: a developer app with the Marketing API product; \`ads_read\` for reading, \`ads_management\` only if changes are wanted. Your own ad account works with standard access; other businesses' accounts need advanced access (App Review), or a system-user token for an ad account the client shared with the business. Google: a Google Cloud OAuth client in a project with the Google Ads API enabled; since 2026-09-09 access levels belong to that Cloud project (Basic access is applied for in the Cloud console; developer tokens are no longer issued). The Setup checklist on the Ads page lists the exact steps and links.
`;

export const SKILLS: PluginManagedSkillDeclaration[] = [
  {
    skillKey: ADS_SKILL_KEY,
    displayName: "Paid ads",
    slug: ADS_SKILL_SLUG,
    description: "Read Meta and Google ads performance, work within budget caps, handle alerts, and propose, check and run approved campaign and budget changes. Nothing that spends money runs without a recorded human approval.",
    markdown: withFrontmatter({ name: ADS_SKILL_SLUG, description: DESCRIPTION }, ADS_BODY),
    files: [
      { path: "references/governance.md", content: GOVERNANCE_REFERENCE },
      { path: "references/platforms.md", content: PLATFORMS_REFERENCE },
    ],
  },
];
