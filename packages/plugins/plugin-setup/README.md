# Setup (`partnersinbiz.setup`)

Guided setup for each Paperclip company. Hire the company's agents (**Team**), pick the modules it uses, see what each PiB plugin still needs, fix it with deep links or **Do it for me**, and copy settings from another company. **New company** brings a whole new company up in one run. A weekly **Finish setup** issue lists what is still missing, so nobody has to remember to check.

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

The roles are the kit's `TEAM_ROLES` (`@partnersinbiz/pib-plugin-kit/team`): Operator and Reviewer (Cockpit), Account Manager (CRM), SEO Specialist, Social agent, Bookkeeper, Payroll Clerk. Every role's skills end with the company operating manual (`pib-company-os`). Each row shows the role's run profile (model, run timeout, concurrency) from the kit's `TeamRole.runProfile` (`RunProfileLine`), and when the linked agent's own settings were read and lack it (`agentRunProfileProblems`) the row says what to set. A plugin cannot change an agent's settings, so the line points to the agent's Configuration or to `new-company.py` on the server and never claims it fixed anything. The Cockpit's `roleDriftCheck` is the server-side watchdog for the same drift. Setup shows one row per role of a switched-on module whose plugin is installed (`teamRolesFor`). Pure helpers live in `src/team.ts`; the page calls the role's own plugin over HTTP with the board session (`src/ui/team-client.ts`), like "Do it for me".

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

## New company (0.5.0)

Tab **New company** on the Setup page (`#new-company`, also `?section=new-company`). One run, resumable, for a company that has nothing yet. The ops side (agents, projects, secrets: things a plugin cannot write) is the three scripts in `operations/vps/` and `operations/vps/docs/new-company.md`, the end-to-end checklist.

**When a company is created.** `registerCompanyBootstrap` (kit) remembers it, opens the owner ONE issue, "Set up <company>", and catches up lazily for companies that predate 0.5.0. The first module save adopts that issue into the live "Finish setup: N steps left" issue, so the owner never has two (`adoptSetupIssue`).

**The run** (`setup.bootstrap-company`, board user only). Ten steps in `BOOTSTRAP_STEPS` (`src/bootstrap.ts`), each recorded in `bootstrap_runs`. The worker does what it can (module choice, the Finish setup issue, the hire tasks); the page does what the worker cannot, with the board session, and records each result with `setup.bootstrap-record`:

| Step | Where | What |
|---|---|---|
| modules | worker | saves the module choice (every module on unless the options say otherwise; a choice already saved is kept) |
| setup-settings | page | saves Setup's own settings so its jobs act for the company (Q7-7) |
| plugin-settings | page | saves every installed plugin's settings from its schema defaults, or copies another company's the way the Copy section does |
| skills | page | runs a plugin's skill sync (`SKILL_SYNC_ACTIONS`) only when the skills are missing |
| roles | page | one hire task per missing required kit role, through the owning plugin's own `start-hire` (the CEO executes it) |
| templates | page | one hire task per template of the standard team that is switched on |
| company-wiki | page | the Company wiki set-up |
| starter-pack | page | the memory starter pack, only when approved and ticked |
| finish-issue | worker | opens the Finish setup issue |
| owner-list | page (the owner's list) | ONE batched list of what only a person can do, with deep links, computed by the page and recorded with the step; the worker appends it to the Finish setup issue and drops a plugin item from it once that plugin reports it done (`currentGrants`) |

Rules: idempotent (repeating changes nothing that is done; live facts override stored state); a failed item fails that item, never the run; run state is `created`, `running`, `partial` or `complete`; an agent already holding a role is never hired again (reading the plugin's own `hire-options` status). Plugins that cannot be called (not installed, an older version without the action) show on their row with the reason.

**Unknown is not empty.** The page reads the plugin list and the company's agent list with the board session. When either read fails (or the plugin list has no PiB plugin in it) the run does not treat the company as having none: `RunnerEnv.installed` is `null` and the steps that need it (`plugin-settings`, `skills`, `roles`, `company-wiki`, `owner-list`) end `failed` with "The plugin list could not be read ... Try again", change nothing, and the run shows "Some steps need attention", never "Complete". An unreadable agent list opens no hire task at all (the `roles` and `templates` items and the owner list fail with "The company's agent list could not be read"): a company with no agent gets the CEO's hire task, a company whose agents cannot be read gets none. A repeat reads both lists again, so a failed read heals by running again. A hire task that is already open still counts without the agent list.

**Before a first run on a company that already works** (six or more live agents, run never started) the page shows a warning and asks for a confirmation (`matureCompanyWarning`). A run whose page was closed shows "In progress" with a hint to run again, not "Running".

**The Wiki Maintainer** is made by the LLM Wiki plugin in the Company wiki step. A ticked Wiki Maintainer template is therefore skipped by the templates step (so the two cannot race into a duplicate), blocked when the LLM Wiki plugin is not installed, and counts as staffed when an agent with the plugin's role (`knowledge-maintainer`) exists.

**Q7-7.** The host runs a plugin's job only for a company whose settings for that plugin are saved. Setup's two jobs now log how many companies they skipped for that reason, and the run saves Setup's settings in its second step.

**Hiring agent (Q7-4).** `pickHiringAgent` (`src/hiring.ts`): the agent with role `ceo`, else the one titled CEO or Chief Executive, else the single head of the org chart (no `reportsTo`); it must be able to run (not terminated or paused) and not have `canCreateAgents: false`. Hire tasks go to that agent by default (the Team row's Hire dialog and the run). A company with none gets the "No hiring agent" problem and its fix (`NO_HIRING_FIX`: make or promote one agent, titled CEO, in Agents). Other plugins' hire-options still default to `role === "ceo"`; Setup overrides the assignee on its side.

### The team template pack

`templates/manifest.json` plus `templates/agents/*.md`, versioned (`pack: pib-standard-team`, `version: 1`). Taken from the live Partners in Biz agents on 2026-10-03 and cleaned up: development branch not main, no per-task worktrees on Penny, evidence in the final comment, slow work detached, review hand-offs. Eleven templates: CEO, Delivery Lead, Planner, Plan Critic, Senior Developer, Developer, Code Reviewer, Mac Builder, Growth Marketing Lead, Summarizer, Wiki Maintainer. Each has `runProfile` (or `fromKitRole`), `desiredSkills`, `reportsTo`, `match` (so an existing agent is recognised), `provisioning` (`hire` or `host`/`plugin` for ones the pack only describes) and `defaultOn`. The kit `TEAM_ROLES` are NOT in the pack; the Growth Marketing Lead reuses the Social role's run profile. Shared blocks (`_execution-contract.md`, `_dev-conventions.md`) are expanded into each file, and `{{company}}`, `{{prefix}}`, `{{owner}}`, `{{ceo}}`, `{{ceoLink}}`, `{{wikiRoot}}` are filled per company. When the company cannot be read (no prefix, no CEO name) the text stays honest: agent links become plain names and the task says why.

**The role in a template is the role of the hire request.** It must be one the host's `agent-hires` accepts (`AGENT_ROLES`: ceo, cto, cmo, cfo, security, engineer, designer, pm, qa, devops, researcher, general); the pack validator and a test that runs every rendered payload through a field-by-field copy of the host's `createAgentHireSchema` refuse anything else. The Wiki Maintainer therefore hires with `general`; the agent the LLM Wiki plugin makes has the role `knowledge-maintainer` (which `agent-hires` would reject) and is recognised through `match.roles` only. The Hermes adapter does read `timeoutSec` and `maxTurnsPerRun` (it passes `--max-turns`), so a pack profile is not cosmetic on a Hermes agent.

`scripts/embed-templates.mjs` (the `prebuild` step) turns the pack into `src/pack/data.generated.ts`, so the worker and the page carry it without file access. A test fails when the generated file is stale. Templates reach the CEO as a hire task (`setup.template-draft` previews it, `setup.start-template-hire` opens it): a table of the agent's settings, its skills, the exact AGENTS.md in a 4-backtick block, and an `agent-hires` JSON payload the CEO's `paperclip-create-agent` skill can use. Adapters are chosen per template (`adapterPreference`) from what the company already uses.

### Memory starter pack (Q7-13)

`templates/memory/starter-pack.json`: 14 company-wide platform lessons in the Cockpit memory export format (`pib-company-memory` v1), built on 2026-10-03 from the live memory store by a read-only SELECT of company-wide pinned facts. No client facts, no secrets; 22 other facts were reviewed and are listed under `_excluded` with the reason. It is **off by default and marked "needs owner OK"** (`_pack.needsOwnerOk`): the owner's rule is that agent memory starts empty and is never wired to another store. The Setup page shows each fact, approves the exact version by content hash (`setup.approve-starter-pack`, stored in `starter_pack_approvals`), and only then does the run import it, through the Cockpit's `memory.import` action (a Cockpit that has it is needed). Changing one word changes the hash and the approval no longer applies.

### Actions and routes added

| Kind | Key | Notes |
|---|---|---|
| action | `setup.new-company` | Reads the New company state. A person gets the starter pack's facts to read; an agent gets the counts only. The owner list is the stored one minus the plugin items the plugins now report done. |
| action | `setup.bootstrap-company` | `{ options?, installed? }`. Board user only. Starts or resumes the run. |
| action | `setup.bootstrap-record` | Page-run step results (`stepId`, `status`, `detail`, `items`, `grants`). Board user only. |
| action | `setup.template-draft` | Renders a template's hire task without creating it. |
| action | `setup.start-template-hire` | Opens the hire task for the hiring agent (or the chosen assignee), once per template. |
| action | `setup.approve-starter-pack` | `{ hash }`. Approves a pack version for this instance. |
| action | `setup.starter-pack-import` | Hands the page the import body only when the current version is approved. |
| route | `GET /templates?companyId=` | The pack and every kit role's run profile, rendered for the company. Read by the ops scripts, so none keeps a copy. |
| capability | `issues.wakeup` | New. The hire tasks Setup opens for the CEO must wake it. Needs a stop-first deploy. |
| migration | `002_bootstrap.sql` | New tables `bootstrap_runs`, `template_hires`, `starter_pack_approvals`, `starter_pack_imports`. `001_setup.sql` is untouched. |

## Settings

The page saves Setup's own settings the first time someone saves the modules. The jobs need those saved settings to act for the company. `weeklyIssue: false` turns the issue off.

**PAR and PARA never saved them** (checked 2026-10-03 with `new-company.py --verify`), so Setup's hourly and weekly jobs skip both until an instance admin presses **Save Setup's settings** (the warning on Setup -> New company) or saves Setup's settings in Settings -> Plugins. Do that once after deploying 0.5.0. It is a plugin-settings save by a board session, not something the worker can do for itself.

## Actions and routes (modules, status, memory)

| Kind | Key | Notes |
|---|---|---|
| action | `setup.load` | Page data. Pass `installed` to record which plugins are installed (instance-wide). |
| action | `setup.save-modules` | `{ modules, installed? }`. Board users only. Saves, emits, and refreshes the Finish setup issue. |
| action | `setup.refresh-issue` | Opens, updates or closes the Finish setup issue now. |
| action | `setup.report-memory` | `{ snapshot }` from the page (board users only). Stores the Company wiki checklist and keeps an open Finish setup issue current. |
| route | `GET /modules?companyId=` | `{ modules, updatedAt }`, where `modules` is `null` when no choice is saved. Used by every plugin's sidebar. |
| job | `reemit-modules` | Hourly re-send of every saved choice, for companies whose Setup settings are saved. |
| job | `weekly-finish-setup` | Mondays 05:00 UTC. |

## Contract for other plugins

See `pib-plugin-kit/src/setup.ts`. Each plugin does three things:

- serves `SETUP_STATUS_ROUTE`
- pushes `publishSetupStatus` from a periodic job
- calls `registerModuleWatch` in `setup()`

`item.href` is a Paperclip path without the company prefix, or an https URL. `item.action` names a plugin action that the page can run for the person.

## Develop

```bash
node ./scripts/embed-templates.mjs   # regenerates src/pack/data.generated.ts from templates/ (the build does this)
npx vitest run --config ./vitest.config.ts
npx tsc --noEmit
node ./esbuild.config.mjs
```

Change a template in `templates/`, bump `version` in `templates/manifest.json`, regenerate and commit the generated file; a test fails if they disagree. Never edit an applied migration: add `003_*.sql`.
