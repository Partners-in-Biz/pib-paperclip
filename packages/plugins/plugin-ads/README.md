# Paid ads

Paperclip plugin `partnersinbiz.ads`. Version 0.1.0.

Reads Meta and Google Ads performance into one picture for PiB's own ads and for each client's, keeps monthly budget caps with pacing, raises anomaly alerts, and turns every campaign or budget change into a **proposal with the numbers** that goes to the Reviewer, then a person (and the client, through the CRM, where the scope asks). It is the governed-spend module the audit asked for (Q1a-7, Q9-4, Q10-14), not a port of the old 91-route Ads manager.

**What it never does.** It never spends money, creates, pauses, resumes or re-budgets anything by itself. Reading is automatic and read-only. A change runs only after a recorded human approval, only where changes are switched on (twice: company settings, then the scope), only inside the cap (or where the approver said "over the cap"), and only once per approval. Changes are **off** until a person switches them on. A created campaign is always paused.

## What an agent gets

20 tools (`partnersinbiz.ads:<tool>`), one skill `pib-ads` with references:

| Reading | |
|---|---|
| `list-ad-accounts`, `list-ad-connections` | accounts with scope, currency, status, cap and spend; sign-ins and the accounts each can see |
| `get-ads-summary` | spend, impressions, clicks, conversions, CPC, CPA, ROAS across Meta and Google, grouped by platform, campaign, day, account or scope; totals per currency |
| `list-ad-campaigns`, `get-spend-ledger` | campaigns with status, budget and 7 days of numbers; the append-only spend ledger |
| `get-budget-status`, `list-ad-alerts` | cap, spend, pace, projections, headroom; spend spike, no delivery, cost per result over target, budget nearly used, numbers not updating |
| `list-ad-proposals`, `get-ad-proposal` | proposals and the full picture of one (numbers, cap lines, sign-offs, next step, the message for the client) |

| Doing | |
|---|---|
| `register-ad-account`, `sync-ad-account`, `set-ad-scope-rules` | put an account under a scope (read-only); read now; set the target cost per result and add banned words (never remove one) |
| `check-ad-creative` | machine check of ad copy: banned words, length, claims platform policy rejects, https landing page, special categories. Never clears copy |
| `propose-ad-change`, `revise-ad-proposal`, `cancel-ad-proposal` | `create_campaign`, `change_budget`, `pause_campaign`, `resume_campaign`, `creative_check` |
| `record-ad-review` | the **Reviewer's** verdict (pass, or changes with notes). Refused for any other agent, including the one that made the proposal, and for a person (who approves or refuses instead); refused in a company with no Reviewer |
| `record-client-request` | which CRM client request asked the client |
| `acknowledge-ad-alert` | say what you concluded about an alert |
| `execute-ad-change` | run an approved change: needs the owner's approval id; the plugin re-checks everything |

There is **no** tool to approve, set a cap, switch changes on or connect a platform. Those are people's: page actions that need a signed-in person (the host's actor, never a value from the payload).

## Governance

1. `propose-ad-change` stores the numbers, a hash of them, the cap and pacing impact, and the copy check, and opens one issue (`ads-approval:<id>`). The Reviewer gets it first (when the company reviews outward work), then the approver. A person marks the issue **done** to approve or **cancelled** to refuse; an agent closing it is reopened (kit `reopenApprovalForPerson`). The plugin's own close after a decision comes back from the host as an `issue.updated` event by actor `plugin` and is ignored (the live host delivers a plugin's own updates to that plugin; the test harness echoes them the same way). A change that goes over the cap can only be approved on the page with "over the cap" ticked.
2. A client scope (the default for clients) also needs the **client's own yes**. The Account Manager gets an issue (`ads-client-ask:<id>`) with the ready message to send through the CRM's client-action path (`create-client-action`, kind `approval`); a person then records the client's answer on the page with what the client wrote.
3. The Reviewer's verdict is the Reviewer's: only the agent in the company's Reviewer role (the Cockpit's roles copy) can record one, never on a proposal it asked for itself. A Reviewer's "changes" stays until the numbers change or the Reviewer itself passes them: revising with nothing changed does not clear it. An approval is for a **content hash**: any change to the numbers cancels every earlier yes and the Reviewer looks again. It lapses after 72 hours, runs one change once (atomic claim), and a pause needs only the owner.
4. `execute-ad-change` refuses, with a reason and an audit entry, unless: the proposal is approved; the approval id is the owner's yes for this proposal, unused, current; every other sign-off is in; the Reviewer's check stands; changes are on for the company **and** the scope; the connection holds the change permission; a monthly cap exists and the change is inside it; the numbers still match (a budget change or a resume is refused when the campaign's budget moved since). Only then is the approval used up and the platform asked. A run cut off after that point (nothing recorded for 2 hours) is closed as `failed` by the hourly sweep with a note to check the platform; it is never retried.
5. At the scope's alert point (90% by default) the plugin opens a **pause request**: one proposal for every active campaign of the scope, through the same path. It never pauses by itself. It does not nag and does not go quiet: an open request gets one note when the budget reaches 100%; a person's no is final for that alert point, except that 100% after a no at 90% is asked once more; a request that expired unanswered is asked again (3 times a month at most); a pause that ran ends it.

Statuses: `needs_changes`, `in_review`, `approved`, `executing`, `executed`, `cleared` (copy only), `failed`, `rejected`, `cancelled`, `expired` (7 days).

## Settings (save once per company)

`publicBaseUrl`, `encryptionKey` (secret), `timezone`, `writes.enabled` (master switch, off), `alerts.*`, `platforms.meta.{enabled, appId, appSecret, systemUserToken, requestWrite, apiVersion}`, `platforms.google.{enabled, clientId, clientSecret, developerToken (legacy, optional), requestWrite, apiVersion}`, `platforms.mock.enabled` (rehearsal only). Every platform is **off** until switched on and complete. `requestWrite` is each platform's "the connection may change ads" switch (Meta asks for `ads_management`; Google has one sign-in permission that reads and changes, so there the switch is ours): without it a connection is read-only whatever the other switches say. Redirect URI to register with Meta and Google (shown on the Ads page): `<publicBaseUrl>/_plugins/<plugin installation id>/ui/oauth-callback.html`.

Two facts checked against the platforms' docs on 2026-10-04: Google retired developer tokens on 2026-09-09 (API access levels now belong to the Cloud project that owns the OAuth client; the `developer-token` header is optional and ignored, sent only if one is saved), and Meta's Graph API is at v26.0 (the default here is v25.0, supported until 2028). **Nothing here has run against Meta or Google yet**: the first live read is a check, not a formality.

## Data model (migration `001_ads.sql`, schema `plugin_ads_caac8387d2`)

`scopes` (own or one client: cap, alert point, target CPA, **allow_writes default false**, who must sign, banned words), `budget_overrides`, `connections` (tokens sealed with AES-GCM; `can_write`), `ad_accounts`, `campaigns`, `daily` (campaign x day rollups), `spend_ledger` (append-only: one entry per change to a day's spend; the ledger decides from its own last total, so a crash between the two writes is repaired by the next read), `alerts` (one row per dedupe key), `proposals`, `approvals` (a database check makes anything but `user:*` impossible), `audit`, `oauth_sessions`, and the CRM client projection (`crm_companies`, `crm_contacts`). Money is integer minor units in the scope's currency; a scope has one currency, and accounts in another are left out of its totals. Dates are read as text (a `date` column would shift with the driver's timezone).

## Jobs

`sync-insights` (every 3 h at :11: read, then alerts and pause requests, per company with saved settings), `refresh-connections` (hourly: renew tokens, flag a sign-in that must be redone, resolve old alerts, link a hire), `setup-status` (hourly at :23: expire proposals, publish setup status and the Cockpit snapshot, sync the skill for every company).

Reading rules: every sync re-reads everything since the last **good** read plus the 3 days before it (platforms restate recent days), so an outage is backfilled and the month-to-date stays whole: after a 6-day gap a read covers 9 days. A first sync reads 30 days, or back to the start of the month if that is longer. A gap over 90 days reads 90 and is audited (`sync.gap_truncated`); the oldest days are then missing. A failed read, and a short one (an agent asking for `days: 1`, the look after a change), never count as the last good read. A page that holds more answers than the adapter follows (Meta 40 pages, Google 20) fails the read instead of passing a part off as the whole. A day we hold that the platform no longer returns is set to zero and the ledger records the drop, but only when the platform returned something for the window: an empty answer for every day never wipes real spend. The agent tool `sync-ad-account` reads at most 10 accounts per call; the job reads up to 40. A new sign-in takes over the accounts of an old one when it is the same person (Meta) or the old one needs signing in again (Google does not say who signed in); an account the new sign-in cannot see stays where it is. An agent can register accounts but cannot bring back one a person removed, and cannot move a scope to another currency while it has a cap (a person can; the cap is cleared and set again, because it was an amount in the old currency).

## Other plugins

- **CRM**: client names and projects through the kit's projections; the CRM's `create-client-action` carries the client ask. The plugin listens for `plugin.partnersinbiz.crm.client.brand.updated` (`{ clientKind, clientRef, bannedWords, brandNote }`, a contract the CRM does not emit yet) so banned words reach a scope without trusting an agent to copy them.
- **Cockpit**: snapshot with spend, budget, waiting changes, alerts and health; the Reviewer and Operator roles come from the roles copy (`registerRoleWatch`).
- **Setup**: `GET /setup-status` and the hourly event. Until the settings are saved the plugin reports one optional item, so a company that does not run ads never sees a "steps left" count. The role `ads-manager` and the module `ads` are not in the kit yet (see "Shared pieces to add").

## Not in version 0.1

Ad sets, audiences, creatives and ads are built in the platform (a created campaign is a paused shell with its budget); LinkedIn and TikTok; conversion-API events; experiments; lifetime budgets and ad-set budgets on Meta, and shared budgets on Google, are refused with the reason. A Meta campaign whose budget sits on its ad sets shows no daily budget, so its spend is in the run-rate projection but not in the committed one. The page cannot be viewed in a browser from the build environment: it is typechecked and bundled, not looked at.

## Shared pieces to add (not part of this package)

Kit: `MODULES.ads` and `PIB_PLUGINS.ads`; `TEAM_ROLES` entry `ads-manager` (see the wiki for the exact text); the plugin in the contract tests' `PLUGINS` lists. UI package: an `ads` module accent and icon, and a Marketing nav entry. Ops: `deploy-plugins.sh` and `smoke-plugins.sh` learn the plugin name, and a first-install path.

## Tests

`pnpm test` (218 tests: pure maths, adapters against a scripted `fetch`, and the services on a real embedded Postgres with the host's SQL rules). Fixtures build secret-shaped values (token prefixes) at runtime or use obvious fakes; GitHub push protection rejects real-looking keys. The test world echoes every plugin issue update back as an `issue.updated` event by actor `plugin`, as the live host does. `pnpm typecheck && pnpm build`.
