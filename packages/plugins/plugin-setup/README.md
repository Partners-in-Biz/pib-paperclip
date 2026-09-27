# Setup (`partnersinbiz.setup`)

Guided setup for each Paperclip company. Hire the company's agents (**Team**), pick the modules it uses, see what each PiB plugin still needs, fix it with deep links or **Do it for me**, and copy settings from another company. A weekly **Finish setup** issue lists what is still missing, so nobody has to remember to check.

- Plugin key: `partnersinbiz.setup` (kit `SETUP_PLUGIN`)
- Namespace: `plugin_setup_48494712db` (slug `setup`)
- Page: `/<company>/setup` · sidebar entry "Setup" (order 10) · dashboard widget "Setup progress"

## What it does

1. **Modules per company.** `module_choices` holds `{ crm: true, seo: false, … }` per company. No row means every module is on, so existing companies keep working. Saving emits `plugin.partnersinbiz.setup.modules.updated` (kit `ModulesPayload`). An hourly job re-sends it for every company that has a row, because events are at-most-once. Other plugins keep a copy with kit `registerModuleWatch` and skip switched-off companies with `isModuleEnabled`. Sidebars call kit `setup-client` `moduleEnabled()`, which reads `GET /api/plugins/partnersinbiz.setup/api/modules?companyId=`.
2. **Status projection.** The plugin subscribes to `plugin.<key>.setup.status` for every PiB plugin and keeps the newest `SetupStatus` per company and plugin in `statuses`. An older `checkedAt` never replaces a newer one.
3. **Setup page.**
   - **Team** (top of the page, `#team`, opened by `?section=team`; each role at `#team-<roleKey>`, the brief settings at `#team-owner`). The company's agents are hired here, watched in the Cockpit, and a plugin page only shows a box when a role is wrong (it links to `/setup?section=team#team-<roleKey>`). See [Team](#team) below.
   - **Modules:** module cards with on/off switches and whether each plugin is installed. On a company's first visit this step opens first (the Team section appears once modules are saved, or when a link asks for it). When CRM is off, the page suggests turning it back on for Social, SEO, Billing or Campaigns, but does not force it.
   - **Checklist:** one section per enabled module. Items about an agent role (and the Cockpit's `owner` item) link to Setup → Team instead of the plugin page.
     - The page asks the plugin for its live status at `GET /api/plugins/<key>/api/setup-status`. If that fails it falls back to the stored status, and then to one "Update or enable the plugin" item.
     - Each section shows progress, status chips, details, deep links, steps, what the agent does next, and **Do it for me**, which runs `POST /api/plugins/<plugin>/actions/<key>` and then checks again.
   - **Guided setup:** shows one missing required item at a time. Step 1 is the team: missing required roles (Hire / Pick existing right in the guide), then who gets the daily brief. Then the checklist: settings, keys and connections, agents, first data. CRM and Mailbox come first within each phase, and an item never comes before the items it waits on. A checklist item about a role the Team step already checked is not asked again.
   - **Copy from another company:**
     1. Reads each enabled plugin's settings from the source company and from this company (`GET /api/plugins/:id/config?companyId=`).
     2. Removes secret refs and schema secret fields. Secrets are company-scoped and must be picked again.
     3. Removes UUID-shaped values, which are ids of the other company's agents, projects or users.
     4. Fills in only what this company does not have yet. Missing, `null`, `""` and `[]` count as not set.
     5. Shows a preview, then saves with `POST /api/plugins/:id/config`, which needs an instance admin.
     6. Lists the secrets to pick again, with links.
4. **Company wiki** (module `memory`, upstream plugin `paperclipai.plugin-llm-wiki`). LLM Wiki pushes no status and the Setup worker cannot see its folder, agent or routines, so the page checks it with the board session: LLM Wiki `POST /data/settings` (falls back to `GET /api/overview`), `GET /api/companies/:id/agents` and `GET /api/companies/:id/routines`. It sends the result as a `WikiSnapshot` to `setup.report-memory`; the worker builds the checklist itself (`memoryStatus` in `src/memory.ts`) and stores it like any pushed status, so the Finish setup issue lists it too. Items: wiki folder, Wiki Maintainer with a working adapter and active, the three routines active with schedules on, and (optional) Paperclip event ingestion. **Set up company memory** (a page action, `memory.setup`) bootstraps the folder at `<instance>/companies/<companyId>/wiki` (derived from an agent's adapter config), creates and turns on the routines and turns on ingestion, skipping what is done. The Maintainer's adapter and model stay a person's step. Switching the module off hides it from Setup only: LLM Wiki does not read the module switches.
5. **Dashboard widget:** overall and per-module progress with a "Continue setup" link. It hides once everything required is done.
6. **Weekly Finish setup issue** (Mondays 07:00 SAST, `0 5 * * 1` UTC, and after every module change):
   - Opens one issue per company that has a saved module choice. The issue is assigned to the person who saved the choice.
   - It lists the missing required items of enabled modules, with deep links (role items link to Setup → Team). It also lists enabled, installed modules that never reported a status, as "settings not saved yet".
   - Status events keep the open issue up to date (they never open a new one), and the issue closes itself once nothing required is missing.

## Team

The roles are the kit's `TEAM_ROLES` (`@partnersinbiz/pib-plugin-kit/team`): Operator and Reviewer (Cockpit), Account Manager (CRM), SEO Specialist, Social agent, Bookkeeper, Payroll Clerk. Every role's skills end with the company operating manual (`pib-company-os`). Setup shows one row per role of a switched-on module whose plugin is installed (`teamRolesFor`). Pure helpers live in `src/team.ts`; the page calls the role's own plugin over HTTP with the board session (`src/ui/team-client.ts`), like "Do it for me".

**Loading** (in parallel, per page load and after every change; `loadTeam` never throws):

| Role | State from | Hire | Pick existing / Change | Remove | Re-sync |
|---|---|---|---|---|---|
| CRM (Account Manager), SEO, Social, Accounting, Payroll | `<p>.hire-options` → `status: { agent, linkedBy, hire, candidates }` | `<p>.hire-options` prefill, then `<p>.start-hire` | `<p>.link-agent { agentId }` | `<p>.unlink-agent` | `actions.resync` when the kit names one (`crm.resync-agent`, …) |
| Operator, Reviewer | `cockpit.load { team: true }` → saved `roles` first, then `team.<role>` | `cockpit.hire-options { role }`, then `cockpit.start-hire { role, … }` | `cockpit.save-team { operatorAgentId \| reviewerAgentId }` | the same with `null` | none |

Also loaded: the company agents (`GET /api/companies/:id/agents`, for names, URL keys and the pick list) and, with the Cockpit on, the board members (`GET /api/companies/:id/user-directory`). Each linked agent's skills are read once with the kit `agent-client` (`agentSkills`): the role skills it lacks, and its extra skills' state. A plugin that is installed but not running, an action that fails, or a viewer who is not a board user shows on that row only ("Can't check" with the reason and Check again). A plugin older than its Team actions (the host has no handler, e.g. a CRM before 0.4.0) says "The CRM plugin cannot staff the Account Manager yet. Upgrade…".

**Extra skills:** a role's kit `extraSkills` (the Account Manager's `pib-invoice-draft`, `pib-campaigns`, `pib-mailbox-draft`, `pib-partner-share`) show on its row as **Also uses, when installed**, each attached, not attached, not in this company yet, or module not installed. They are never counted as missing. Picking an agent attaches the role's skills and the extra skills that exist in the company's skill library (`GET /api/companies/:id/skills`); the row's **Attach** button adds any that appeared later. An unread library attaches no extras (never guess).

**Health** is the kit's `teamRoleHealth`: missing (no agent, no open hire), hiring (hire task open, linked on the row), attention (paused, error, pending approval, or missing role skills) or ok. Rows that are ok, and optional roles nobody hired, stay one line (with Manage / Set up); the rest open with what is wrong and the fixes. `#team-<roleKey>` opens and highlights that row and scrolls to it.

**Actions:**
- **Hire** opens the `NewTaskDialog` prefilled from hire-options, the assignee defaulting to `defaultAssigneeAgentId` (usually the CEO); "Me" is offered unless the viewer is the local board placeholder.
- **Pick existing / Change** lists the company's agents, hire look-alikes first, with the roles each already holds. The Operator and the Reviewer must differ (refused in the list and by the Cockpit). After a link the page attaches the role's skills (`attachAgentSkills`; the plugin worker cannot) and shows the plugin's steps.
- **Remove** asks first; the agent itself, its routines and tasks are not changed. Not offered for an agent set up before hiring moved to tasks (`linkedBy: managed`), which an unlink cannot clear.
- **Attach missing skills** when the agent lacks any of the role's skills (the company operating manual included); **Re-sync** when the plugin has one.
- Below the roles, with the Cockpit on: **Who gets the daily brief** (`cockpit.save-team { ownerUserId }`) and, when there is a Reviewer, **Reviewer checks outward-facing work before you approve** (`{ reviewOutward }`). Both save on change.
- The first Cockpit save also saves the Cockpit settings (`{ healthIssue: true }`) when they were never saved, as its old Team tab did, so its hourly jobs can act for the company.

**Links:** checklist items for a role (`teamRoleForSetupItem`) and the Cockpit's `owner` item are rewritten where Setup shows them (`withTeamLinks` in `resolveModuleViews` and in the Finish setup issue): `href` → `teamSetupPath(role)` (owner: `/setup?section=team#team-owner`), label "Open Team", Team steps, and the plugin's own "Open a hire task" action dropped (from the checklist it would open an unassigned task; the Team row's Hire asks who hires). Stored statuses from older plugin versions are rewritten too.

## Settings

The page saves Setup's own settings the first time someone saves the modules. The jobs need those saved settings to act for the company. `weeklyIssue: false` turns the issue off.

## Actions and routes

| Kind | Key | Notes |
|---|---|---|
| action | `setup.load` | Page data. Pass `installed` to record which plugins are installed (instance-wide). |
| action | `setup.save-modules` | `{ modules, installed? }`. Board users only. Saves, emits, and refreshes the Finish setup issue. |
| action | `setup.refresh-issue` | Opens, updates or closes the Finish setup issue now. |
| action | `setup.report-memory` | `{ snapshot }` from the page (board users only). Stores the Company wiki checklist and keeps an open Finish setup issue current. |
| route | `GET /modules?companyId=` | `{ modules, updatedAt }`, where `modules` is `null` when no choice is saved. Used by every plugin's sidebar. |
| job | `reemit-modules` | Hourly re-send of every saved choice. |
| job | `weekly-finish-setup` | Mondays 05:00 UTC. |

## Contract for other plugins

See `pib-plugin-kit/src/setup.ts`. Each plugin does three things:

- serves `SETUP_STATUS_ROUTE`
- pushes `publishSetupStatus` from a periodic job
- calls `registerModuleWatch` in `setup()`

`item.href` is a Paperclip path without the company prefix, or an https URL. `item.action` names a plugin action that the page can run for the person.

## Develop

```bash
npx vitest run --config ./vitest.config.ts
npx tsc --noEmit
node ./esbuild.config.mjs
```
