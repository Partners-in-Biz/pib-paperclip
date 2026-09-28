# Cockpit (`partnersinbiz.cockpit`)

One place to run the company: what waits on you, what the agents did, money, pipeline, marketing, delivery, agent cost and quality, and system health. The Cockpit also owns the company's team roles: the **Operator** (chief of staff) and the **Reviewer** (quality reviewer).

- Plugin key: `partnersinbiz.cockpit` (kit `COCKPIT_PLUGIN`)
- Namespace: `plugin_cockpit_b8a99e8b16` (slug `cockpit`)
- Page: `/<company>/cockpit` (tabs Overview, Flows `?tab=flows`, Profile `?tab=profile` and Memory `?tab=memory`) · sidebar "Cockpit" (order 5, above Setup; its count turns red for money or legal) · dashboard widget "Company today". The team is staffed in **Setup → Team** (`/setup?section=team`); an old `?tab=team` link is sent there.
- Settings must be saved once per company: the hourly jobs **and** the event handling (answers to questions, onboarding, the CRM client copy) only act for companies with saved Cockpit settings.

## How it works

1. **Projection.** The plugin subscribes to `plugin.<key>.cockpit.snapshot` and `plugin.<key>.setup.status` for every PiB plugin. It keeps the newest report per company, plugin and kind in `snapshots`, in one upsert. An older `checkedAt` never replaces a newer one. The subscription decides which plugin a report belongs to.
2. **Page (Overview).**
   - **Today:** a summary line plus a health light, which shows the worst status across all plugins.
   - **Waiting on you:** merges several sources and removes duplicates by key and by issue. Questions agents asked the owner come first (money and legal red, the rest amber, with age, the question, the options and an **Answer** link to the issue), then money and legal, then oldest first within each kind. The sources are:
     - open questions from `ask-owner` (`cockpit.load` → `asks`)
     - every plugin's `waiting` items, taken live from `GET /api/plugins/<key>/api/cockpit` for plugins that are installed, ready and switched on, or from the projection when a plugin cannot answer
     - open issues with no assignee, older than a day: one item with the count and the first five as links (`cockpit.load` → `unassigned`)
     - open approvals (`/api/companies/:id/approvals`)
     - your open issues (`/issues?assigneeUserId=me&status=todo,in_progress,in_review,blocked`)
     - Setup's missing required items (links to `/setup`)
   - **Flows:** the company graph in one card: the sentence from the Flows tab and each flow as a row of dots (amber stuck, module colour busy, dashed off), linking to the flow on the Flows tab.
   - **Money / Pipeline / Marketing / Delivery:** the plugins' KPIs, grouped.
   - **What the agents did:** 24 hours or 7 days. Combines plugin activity, host activity (`/activity`) and runs (`/heartbeat-runs`), grouped by agent.
   - **Agents:** each agent's status, last run, runs in the last 7 days, and spend against budget this month. Spend and budget come from the agent record, overridden by `costs/by-agent?from=<month start>` and the agent's monthly `budgets/overview` policy. Quality metrics come from the snapshots. A chip appears at 80% of budget or when the agent is in error.
   - **System health:** every plugin's checks, worst first, each with its fix and a link. A check that links to Setup → Team (an empty, paused or failing Operator or Reviewer) says **Fix in Setup**. Adds "plugin not reporting" when a plugin that is switched on has sent no snapshot for 3 hours. Shows the last database backup from `GET /api/health` (`databaseBackup.latestBackup`) and warns when it is more than 3 hours old.
   - Modules switched off in Setup (kit `setup-client` `fetchModules`) are hidden.
3. **Team (in Setup → Team).** The Cockpit has no Team tab. Setup → Team hires, picks, changes or removes the Operator and Reviewer through the Cockpit's actions (`cockpit.hire-options`, `cockpit.start-hire`, `cockpit.save-team`, `cockpit.load` for `team` and `roles`), and sets the owner and the review switch.
   - **Save:** emits `roles.updated` (kit `RolesPayload`).
   - **When an agent is linked:** it gets a `tools:use` grant for plugin tools and its managed skill (`pib-operator` / `pib-reviewer`). For the Operator, the Cockpit also creates or reassigns the two routines.
   - **Overview:** "No Operator yet" and the Operator / Reviewer health checks link to Setup → Team ("Fix in Setup").
4. **Hourly jobs.** Both only run for companies with saved Cockpit settings.
   - **`reemit-roles`** (`10 * * * *`): sends the roles again and links any pending hires.
   - **`health-alerts`** (`20 * * * *`): keeps one **System health** issue per company. The issue covers bad checks, plugins that are not reporting, and agents in error or at 80% or more of budget. It is assigned to the Operator when one is linked, otherwise to the owner. The assignee is woken when new problems appear. The issue closes when everything is ok. Set `healthIssue: false` to turn it off.

## Flows (the company graph)

Cockpit → **Flows** (`?tab=flows`) draws every flow in kit `FLOWS` (lead to cash, onboarding, content, campaigns, books, payroll) stage by stage, in order. Pure logic in `src/flows.ts`, drawing in `src/ui/flows.tsx`.

- **Numbers:** each plugin's snapshot `flows` (kit `FlowStageReport`), live first, else the stored copy. Parsing keeps only known stages the sending plugin owns, once each, with whole, non-negative numbers (stuck never above the count); older plugins send none and their stages show "–".
- **Each stage:** its count (and amount when reported), stuck items with the plugin's reason, and who it waits on: the role's agent by name, "You", the customer or "Automatic". It links to the stage's page (with the company prefix).
- **Switched off**, first cause wins: the module is off (Setup modules) → the plugin is not installed or not ready → its settings are not saved (the stored setup status's `settings` item; no status at all means not saved, as Setup assumes; the Cockpit uses its own saved flag) → its role has no running agent (the snapshots' `team`, the Cockpit's Operator and Reviewer, statuses from the agents list; kit `roleAgentUsable`). An off stage is muted with its reason and **Fix in Setup** (`teamSetupPath(role)`, the Setup checklist at the module, or Setup modules).
- **Top of the tab:** one sentence ("4 of 6 flows are running; 3 stages are switched off: no Account Manager (2) and Mailbox settings not saved (1).") and the fixes grouped, biggest first.
- **Stuck first:** "Stuck now" lists every stuck stage grouped by who it waits on (you, agents, customers, the system), worst first (most stuck, then the oldest); flows with stuck work come first. On a phone the list shows five, then "Show all", and flows without stuck work start folded.
- **Layout:** a line of stations when the card is wide enough for the flow's stages (container queries), a vertical line on phones and narrow cards.
- **The Cockpit's own stages** (in its snapshot `flows`): `onboarding.open` = open onboarding issues (origin kind `plugin:partnersinbiz.cockpit:onboarding`, not done or cancelled), stuck when open for more than 7 days; `onboarding.grants` = open `ask-owner` questions of kind `grant`, stuck when asked more than 3 days ago (the stale-question age).
- **The Operator's brief:** `company-brief` → `stuckFlows`, the top 5 stuck stages (same order and numbers), with who each waits on and a link.

## Done-checks

Kit done-checks (`runDoneCheck`, run from the Cockpit's one `issue.updated` handler: a second subscription to the same event would make the host deliver every event twice): when an **agent** closes one of these issues, the Cockpit checks the work; unfinished work reopens (`todo`) with what is missing and the agent is woken; the third early close goes to the Operator. A person's close is never checked.

| Origin id prefix | Done when | Finished another way |
|---|---|---|
| `cockpit:onboarding:` (and `onboarding:` from before 0.4.0) | every `- [ ]` line of the checklist is ticked (`- [x]`); the last line ("Close this issue…") is the close itself | a comment ticks the line (`- [x] SEO Specialist: …`) or skips it with a reason of two or more words (`Skipped: SEO Specialist, because the client has no website`); an issue without a checklist passes |
| `cockpit:health:` (and `health:`) | nothing is left on the System health issue (the same problems it lists) | the Cockpit closes it itself when all is ok; an agent's early close reopens with the first five problems |

The Cockpit keeps the kit's copy of the team (the state kit `registerRoleWatch` keeps in other plugins) whenever it sends `roles.updated`, and refreshes it before a check reopens an issue, so the hand-over to the Operator reaches the right agent.

## Asking the owner (`ask-owner`)

Every PiB skill's "Asking a person" section points here. One open question per issue (`asks` table, migration 003); asking again updates it.

1. The agent calls `ask-owner` on the issue it works on. The Cockpit posts the question as a comment (question, options with the recommendation first, why, steps, links), and hands the issue to the owner (roles `ownerUserId`) with status **`in_review`**. In Paperclip `in_review` is the healthy "waiting on a person" state (a board user reviewing), and an issue assigned to the owner is in their inbox; `blocked` means a dependency, not a person.
2. The question shows first in Waiting on you, in `company-brief` (`waiting`, `asks`) and in the sidebar count. After 3 days it is a health warning.
3. **The owner replies** with a comment (any board user's comment counts): the answer is stored, the issue goes back to the agent that worked on it (status `todo`; the Operator when that agent is gone) and that agent is woken with the answer in the wake reason.
4. Closing the issue resolves (done) or cancels the question; handing the issue to an agent without a reply resolves it. A reply that also closes the issue keeps the answer and leaves the issue closed. The hourly health job settles questions whose events were missed.
5. With no owner set the tool refuses with a clear message, and health warns "Nobody gets the daily brief" (fix: Setup → Team).

## Company profile

Cockpit → **Profile** (`company_profile` table): legal and trading name, VAT number, address, website, booking link, sender name and email, what we sell, audience, brand voice, banned words. Owners edit any field; agents read it with `company-profile` and fill **empty** fields only with `update-company-profile` (fields an agent filled are marked for checking). The setup item "Fill in the company profile" is done once the legal name, website, sender email, what we sell and brand voice are set.

## Hand-offs, onboarding and the team broadcast

- **CRM `deal.won`** (`plugin.partnersinbiz.crm.deal.won`): recorded as activity. On a **first win** the Cockpit opens ONE onboarding issue per client (`onboarding` table, claimed before the issue is created, so re-sent events never open a second) for the Operator, else the owner (kit `routeWork` order). It is the manual's onboarding flow as a checklist: the Account Manager hand-off (client profile, retainer), ONE `ask-owner` for every grant, the SEO first sprint and the Social first month, with a deep link per switched-on module (`/crm?client=company:<id>`, `/billing?…&tab=retainers`, `/social?…&tab=accounts`, `/seo?…&tab=integrations`).
- **Billing `invoice.paid`**: recorded as activity ("INV-000012 paid in full (R 12,345.67) by Northwind").
- **`roles.updated`** carries `operatorStatus`, `reviewerStatus` and `team` (role → `{ agentId, status }`, from each plugin's snapshot `team`; a plugin may only report the roles it owns; statuses come from the agent records, a removed agent is sent as `terminated`). It is sent on team save, hourly, and at once when a snapshot changes a role's agent or status.
- Linking an agent merges plugin tool access into its one `tools:use` grant (kit `mergePluginToolsGrant`); a grant limited some other way is left alone and the step says so.

## Company memory and CRM clients

The Cockpit keeps the kit CRM projection (`crm_companies`, `crm_contacts`). Memory recognises a client in a task or a **Learned:** comment by its CRM name, its website domain, or a contact's full name (a contact at a CRM company names that company), so a new client's first facts are filed under it. Memory tools also accept a client's CRM name or domain. The weekly `memory-review` lists company-wide facts that name a client (`misfiled`), with how to move each; the Memory tab has a one-click **Move**.

## Health

The System health issue lists bad checks at once, and **warnings unresolved for more than a day** (`health_warnings` remembers when each started; a check's own `since` counts too). The Cockpit's own checks include the owner not being set and questions older than 3 days.

## Operator and Reviewer

| Role | Title | Budget | Skills | Routines |
|---|---|---|---|---|
| Operator | Chief of staff | $30/month | `pib-operator`, `paperclip`, `pib-company-os` | "Daily operations review" 07:00 SAST · "Weekly retro" Mondays 08:00 SAST |
| Reviewer | Quality reviewer | $20/month | `pib-reviewer`, `paperclip`, `pib-company-os` | none. Works on approval issues that plugins route to it (kit `reviewerAgentId`) |

- **Managed skills:** `operator`, `reviewer` and the company operating manual `company-os` (slug `pib-company-os`, canonical key `plugin/partnersinbiz-cockpit/company-os`, carried by every PiB role). A hire matches a new agent on the role's own skill only (the shared skills are on every hire).

- **Daily routine:** the Operator reads `company-brief`, fixes what it can by assigning, commenting and waking agents, and posts the **Daily brief** with `post-daily-brief`.
- **Daily brief issue:** one "Daily brief: week of <Monday>" issue per week, assigned to the owner. The previous week's issue closes when the next one opens.
- **Limits:** the Operator never approves money or legal items and never changes budgets.
- **Reviewer:** comments **PASS** or **CHANGES NEEDED**, then hands the issue back to the person. It never approves or sends anything.

## Tools, actions, routes

| Kind | Key | Notes |
|---|---|---|
| tool | `company-brief` | Compact JSON: waiting, asks, `stuckFlows` (top 5 stuck stages), unassigned, team, health, KPIs, activity, and agents with spend and budget. `windowHours` sets the activity window. |
| tool | `health-issues` | Problems worst first. `includeWarnings` includes warnings. |
| tool | `waiting-on-owner` | What waits on the owner, in the same order as the page. |
| tool | `agent-scorecards` | One scorecard per agent (7 days). |
| tool | `post-daily-brief` | `{ body }`: posts a comment on this week's Daily brief issue. |
| tool | `ask-owner` | `{ issueId, question, why, kind, options?, links?, steps?, client?, dueBy? }`: one question to the owner on the issue (see above). |
| tool | `company-profile` | The company profile, missing fields and the edit link. |
| tool | `update-company-profile` | Any profile fields: fills empty ones only; says which set values it kept. |
| tool | `memory-*` | Company memory: recall, add, update, search, feedback, review. |
| action | `cockpit.load` | Page data: projection, roles, team, own snapshot. `installed` and `uiBase` are remembered. |
| action | `cockpit.save-team` | Board users only. Saves the team, links or unlinks agents, emits the roles, refreshes the health issue. |
| action | `cockpit.hire-options` / `cockpit.start-hire` | `{ role: "operator" \| "reviewer" }` |
| action | `cockpit.refresh-health` | Refreshes the System health issue now. |
| action | `profile.load` / `profile.save` | The Profile tab (`save` is for board users: `{ profile }`). |
| event in | `plugin.partnersinbiz.crm.deal.won` | Activity; onboarding on a first win. |
| event in | `plugin.partnersinbiz.billing.invoice.paid` | Activity. |
| event in | `issue.comment.created` / `issue.updated` | Answers and closes questions; **Learned:** lines become memory; an agent's close of an onboarding or System health issue runs its done-check. |
| event in | `plugin.partnersinbiz.crm.company.*` / `contact.*` | The CRM client copy. |
| event out | `roles.updated` | Kit `RolesPayload` with statuses and `team`. |
| route | `GET /cockpit` | The Cockpit's own `CockpitSnapshot` (its job health, the Operator, a linked Reviewer that is not working, and `flows` for its onboarding stages). |
| route | `GET /setup-status` | Setup checklist: settings saved, owner set, Operator linked, Reviewer linked (optional), routines active. |

Core reads (`coreReadTables`):

- `issues`, for the owner's open issues, unassigned work in the brief, and open onboarding issues (Flows)
- `heartbeat_runs`, for runs and failures

Approvals are read with `ctx.approvals.list` and agents with `ctx.agents.list`.

## Develop

```bash
npx vitest run --config ./vitest.config.ts
npx tsc --noEmit
node ./esbuild.config.mjs
```
