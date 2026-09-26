# Setup (`partnersinbiz.setup`)

Guided setup for each Paperclip company. Pick the modules a company uses, see what each PiB plugin still needs, fix it with deep links or **Do it for me**, and copy settings from another company. A weekly **Finish setup** issue lists what is still missing, so nobody has to remember to check.

- Plugin key: `partnersinbiz.setup` (kit `SETUP_PLUGIN`)
- Namespace: `plugin_setup_48494712db` (slug `setup`)
- Page: `/<company>/setup` · sidebar entry "Setup" (order 10) · dashboard widget "Setup progress"

## What it does

1. **Modules per company.** `module_choices` holds `{ crm: true, seo: false, … }` per company. No row means every module is on, so existing companies keep working. Saving emits `plugin.partnersinbiz.setup.modules.updated` (kit `ModulesPayload`). An hourly job re-sends it for every company that has a row, because events are at-most-once. Other plugins keep a copy with kit `registerModuleWatch` and skip switched-off companies with `isModuleEnabled`. Sidebars call kit `setup-client` `moduleEnabled()`, which reads `GET /api/plugins/partnersinbiz.setup/api/modules?companyId=`.
2. **Status projection.** The plugin subscribes to `plugin.<key>.setup.status` for every PiB plugin and keeps the newest `SetupStatus` per company and plugin in `statuses`. An older `checkedAt` never replaces a newer one.
3. **Setup page.**
   - **Step 1, Modules:** module cards with on/off switches and whether each plugin is installed. On a company's first visit this step opens first. When CRM is off, the page suggests turning it back on for Social, SEO, Billing or Campaigns, but does not force it.
   - **Step 2, Checklist:** one section per enabled module.
     - The page asks the plugin for its live status at `GET /api/plugins/<key>/api/setup-status`. If that fails it falls back to the stored status, and then to one "Update or enable the plugin" item.
     - Each section shows progress, status chips, details, deep links, steps, what the agent does next, and **Do it for me**, which runs `POST /api/plugins/<plugin>/actions/<key>` and then checks again.
   - **Guided setup:** shows one missing required item at a time, in order: settings, then keys and connections, then agents, then first data. CRM and Mailbox come first within each phase, and an item never comes before the items it waits on.
   - **Copy from another company:**
     1. Reads each enabled plugin's settings from the source company and from this company (`GET /api/plugins/:id/config?companyId=`).
     2. Removes secret refs and schema secret fields. Secrets are company-scoped and must be picked again.
     3. Removes UUID-shaped values, which are ids of the other company's agents, projects or users.
     4. Fills in only what this company does not have yet. Missing, `null`, `""` and `[]` count as not set.
     5. Shows a preview, then saves with `POST /api/plugins/:id/config`, which needs an instance admin.
     6. Lists the secrets to pick again, with links.
4. **Dashboard widget:** overall and per-module progress with a "Continue setup" link. It hides once everything required is done.
5. **Weekly Finish setup issue** (Mondays 07:00 SAST, `0 5 * * 1` UTC, and after every module change):
   - Opens one issue per company that has a saved module choice. The issue is assigned to the person who saved the choice.
   - It lists the missing required items of enabled modules, with deep links. It also lists enabled, installed modules that never reported a status, as "settings not saved yet".
   - Status events keep the open issue up to date (they never open a new one), and the issue closes itself once nothing required is missing.

## Settings

The page saves Setup's own settings the first time someone saves the modules. The jobs need those saved settings to act for the company. `weeklyIssue: false` turns the issue off.

## Actions and routes

| Kind | Key | Notes |
|---|---|---|
| action | `setup.load` | Page data. Pass `installed` to record which plugins are installed (instance-wide). |
| action | `setup.save-modules` | `{ modules, installed? }`. Board users only. Saves, emits, and refreshes the Finish setup issue. |
| action | `setup.refresh-issue` | Opens, updates or closes the Finish setup issue now. |
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
