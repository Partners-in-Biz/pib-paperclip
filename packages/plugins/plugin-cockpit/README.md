# Cockpit (`partnersinbiz.cockpit`)

One place to run the company: what waits on you, what the agents did, money, pipeline, marketing, delivery, agent cost and quality, and system health. The Cockpit also owns the company's team roles: the **Operator** (chief of staff) and the **Reviewer** (quality reviewer).

- Plugin key: `partnersinbiz.cockpit` (kit `COCKPIT_PLUGIN`)
- Namespace: `plugin_cockpit_b8a99e8b16` (slug `cockpit`)
- Page: `/<company>/cockpit` (tabs Overview and Team, `?tab=team`) · sidebar "Cockpit" (order 5, above Setup) · dashboard widget "Company today"

## How it works

1. **Projection.** The plugin subscribes to `plugin.<key>.cockpit.snapshot` and `plugin.<key>.setup.status` for every PiB plugin. It keeps the newest report per company, plugin and kind in `snapshots`, in one upsert. An older `checkedAt` never replaces a newer one. The subscription decides which plugin a report belongs to.
2. **Page (Overview).**
   - **Today:** a summary line plus a health light, which shows the worst status across all plugins.
   - **Waiting on you:** merges several sources and removes duplicates by key and by issue. Money and legal come first, then oldest first within each kind. The sources are:
     - every plugin's `waiting` items, taken live from `GET /api/plugins/<key>/api/cockpit` for plugins that are installed, ready and switched on, or from the projection when a plugin cannot answer
     - open approvals (`/api/companies/:id/approvals`)
     - your open issues (`/issues?assigneeUserId=me&status=todo,in_progress,in_review,blocked`)
     - Setup's missing required items (links to `/setup`)
   - **Money / Pipeline / Marketing / Delivery:** the plugins' KPIs, grouped.
   - **What the agents did:** 24 hours or 7 days. Combines plugin activity, host activity (`/activity`) and runs (`/heartbeat-runs`), grouped by agent.
   - **Agents:** each agent's status, last run, runs in the last 7 days, and spend against budget this month. Spend and budget come from the agent record, overridden by `costs/by-agent?from=<month start>` and the agent's monthly `budgets/overview` policy. Quality metrics come from the snapshots. A chip appears at 80% of budget or when the agent is in error.
   - **System health:** every plugin's checks, worst first, each with its fix and a link. Adds "plugin not reporting" when a plugin that is switched on has sent no snapshot for 3 hours. Shows the last database backup from `GET /api/health` (`databaseBackup.latestBackup`) and warns when it is more than 3 hours old.
   - Modules switched off in Setup (kit `setup-client` `fetchModules`) are hidden.
3. **Team (Team tab).**
   - **Pick agents:** choose an existing agent for Operator and Reviewer, or click **Hire** to open a hire task (kit `agent-hire` plus `NewTaskDialog`). The Cockpit links the new agent when it appears.
   - **Owner:** defaults to you.
   - **Review switch:** "Review outward-facing work before I approve".
   - **Save:** emits `roles.updated` (kit `RolesPayload`). The first save also saves the Cockpit settings (`{ healthIssue: true }`).
   - **When an agent is linked:** it gets a `tools:use` grant for plugin tools and its managed skill (`pib-operator` / `pib-reviewer`). For the Operator, the Cockpit also creates or reassigns the two routines.
4. **Hourly jobs.** Both only run for companies with saved Cockpit settings.
   - **`reemit-roles`** (`10 * * * *`): sends the roles again and links any pending hires.
   - **`health-alerts`** (`20 * * * *`): keeps one **System health** issue per company. The issue covers bad checks, plugins that are not reporting, and agents in error or at 80% or more of budget. It is assigned to the Operator when one is linked, otherwise to the owner. The assignee is woken when new problems appear. The issue closes when everything is ok. Set `healthIssue: false` to turn it off.

## Operator and Reviewer

| Role | Title | Budget | Skill | Routines |
|---|---|---|---|---|
| Operator | Chief of staff | $30/month | `pib-operator` | "Daily operations review" 07:00 SAST · "Weekly retro" Mondays 08:00 SAST |
| Reviewer | Quality reviewer | $20/month | `pib-reviewer` | none. Works on approval issues that plugins route to it (kit `reviewerAgentId`) |

- **Daily routine:** the Operator reads `company-brief`, fixes what it can by assigning, commenting and waking agents, and posts the **Daily brief** with `post-daily-brief`.
- **Daily brief issue:** one "Daily brief: week of <Monday>" issue per week, assigned to the owner. The previous week's issue closes when the next one opens.
- **Limits:** the Operator never approves money or legal items and never changes budgets.
- **Reviewer:** comments **PASS** or **CHANGES NEEDED**, then hands the issue back to the person. It never approves or sends anything.

## Tools, actions, routes

| Kind | Key | Notes |
|---|---|---|
| tool | `company-brief` | Compact JSON: waiting, health, KPIs, activity, and agents with spend and budget. `windowHours` sets the activity window. |
| tool | `health-issues` | Problems worst first. `includeWarnings` includes warnings. |
| tool | `waiting-on-owner` | What waits on the owner, in the same order as the page. |
| tool | `agent-scorecards` | One scorecard per agent (7 days). |
| tool | `post-daily-brief` | `{ body }`: posts a comment on this week's Daily brief issue. |
| action | `cockpit.load` | Page data: projection, roles, team, own snapshot. `installed` and `uiBase` are remembered. |
| action | `cockpit.save-team` | Board users only. Saves the team, links or unlinks agents, emits the roles, refreshes the health issue. |
| action | `cockpit.hire-options` / `cockpit.start-hire` | `{ role: "operator" \| "reviewer" }` |
| action | `cockpit.refresh-health` | Refreshes the System health issue now. |
| route | `GET /cockpit` | The Cockpit's own `CockpitSnapshot` (its job health and whether an Operator is linked). |
| route | `GET /setup-status` | Setup checklist: settings saved, owner set, Operator linked, Reviewer linked (optional), routines active. |

Core reads (`coreReadTables`):

- `issues`, for the owner's open issues in the brief
- `heartbeat_runs`, for runs and failures

Approvals are read with `ctx.approvals.list` and agents with `ctx.agents.list`.

## Develop

```bash
npx vitest run --config ./vitest.config.ts
npx tsc --noEmit
node ./esbuild.config.mjs
```
