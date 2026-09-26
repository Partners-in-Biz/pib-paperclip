# SEO

Paperclip plugin `partnersinbiz.seo` (v0.4.0): 90-day SEO sprints for Partners in Biz's own sites and its clients.

- A **sprint** is one site on the Outrank-90 template: 42 tasks over weeks 0–13, then open-ended compounding. Sprints also seed 15 directory backlinks.
- **Scope.** A sprint without a client is PiB's own. A client sprint references one CRM company or CRM contact (`client_kind` + `client_ref`, name from the CRM projection). `/seo` shows only own sprints; `/seo?client=company:<id>` or `?client=contact:<id>` is that client's workspace (shared client bar, opened from the CRM). Opening a sprint in the wrong scope redirects to its own.
- Each sprint has a **root issue** ("SEO sprint: <site> (<client>)") in the managed **SEO** project. Every task becomes a **sub-issue** on the day it is due; client sprint issues start with `[<client>]` unless the title already names the client. Agent tasks go to the linked **SEO agent** (see *Hiring the SEO agent*); tasks that need a person go to the sprint owner.
- `GET /api/plugins/partnersinbiz.seo/api/client-summary?companyId=&kind=company|contact&id=<crm id>` (board auth) returns `{ headline, stats }` for the CRM client workspace.
- The plugin never calls a model. The agent works issues with the `partnersinbiz.seo:*` tools (skill `pib-seo-sprint`).

## Timeline

Day 0 = start (launch) date. Week 0 = pre-launch (due immediately). Week *n* ≥ 1 covers days 7n−6 … 7n. Day-90 audit tasks are due on day 90. Phase follows the week (0; 1–4; 5–10; 11–13; 14+ = compounding).

## Jobs

| Job | Schedule | Does |
|---|---|---|
| `seo-daily` | `5 * * * *` | Once per sprint per local day after `dailyHourLocal` (default 06:00 SAST): clock/status, root issue, GSC pull (8 days to yesterday), PageSpeed (home + 3 rotating pages), Bing link counts, audit snapshots (day 0/30/60/90, then every 30 days), open due sub-issues, measure optimizations (14 days after approval), re-sync task status from issues, store today's plan. |
| `seo-weekly` | `0 5 * * 1` (07:00 SAST Mon) | Detectors → health → up to 2 proposals per 7 days in the first 4 weeks (5 later) → one approval issue for the sprint owner. |

Jobs have no invocation scope: they only act for companies whose SEO settings are saved.

## Owner mapping

People: verify GSC, Request indexing (no API exists), Bing verification, cross-link from another property, founder link-trade DMs, community posts. Everything else is agent work. Agent tasks with `autopilotEligible: false` (alt text, noindex, publishing posts/pillar/cluster, repurposing, pSEO, guest-post pitch, CWV fixes, the day-90 announcement) need the owner's sign-off in `safe` mode: the agent hands them over with `block-task` + `review: true` and the owner marks the issue done.

## Setup (once)

1. **Google Cloud** (can be the YouTube project): enable *Google Search Console API* and *PageSpeed Insights API*. OAuth consent screen scope `https://www.googleapis.com/auth/webmasters`. Web OAuth client with the authorized redirect URI shown on the SEO page: `https://<paperclip host>/_plugins/<plugin installation id>/ui/oauth-callback.html` (the host serves plugin files only by installation id; it changes only if the plugin is reinstalled). Optional: an API key restricted to PageSpeed Insights.
2. **SEO settings** (Settings → Plugins → SEO), save for the PiB company: Public base URL, token encryption key (secret), timezone, daily hour, default autopilot, Google client ID + secret (secret), PageSpeed key (optional secret), Bing key (optional secret).
3. **SEO page → Activate SEO agent** opens a hire task (see below). Once the agent is linked, **Resume** it when its adapter has a working model key, and enable the routine triggers ("Run today's SEO" 06:30, "Weekly SEO review" Mon 07:00, Africa/Johannesburg).
4. For each sprint: **Integrations → Connect Google Search Console** (property auto-selected when it matches the site).

## Hiring the SEO agent

The plugin does not create its agent. Every agent is hired the same way, through a normal Paperclip task, so it lands in the org chart.

- **Activate SEO agent** (own SEO page only) opens a *New task* popup prefilled with a hire request: name and title (SEO Specialist), role `general`, adapter `hermes_local` then `claude_local`, the `pib-seo-sprint` skill, budget, a short AGENTS.md (the procedure lives in the skill) and what the plugin sets up afterwards. Edit it, pick who does the hire (defaults to the CEO agent; or yourself) and create it. The task has origin `plugin:partnersinbiz.seo` / `hire:seo-specialist`.
- **Auto-link.** When exactly one agent created after the task matches (has the skill, or is named/titled "SEO Specialist"), the plugin links it: on agent events, on SEO page load, and from the hourly `seo-daily` job. More than one match waits for a person.
- **Wiring** (on link and on **Re-sync**): syncs the skill, reconciles the SEO project, assigns both routines to the agent (an existing routine held by another agent is moved over with its active/paused status kept), merges `tools:use` for plugin tools into its grants, points every sprint at it and hands it waiting agent tasks. The steps are commented on the hire task. The plugin cannot attach skills to an agent; if `pib-seo-sprint` is missing it says so.
- **Link agent / Change agent** links any existing agent by hand (new matches listed first); **Unlink** forgets the link (the agent, its routines and tasks are untouched).
- Agents activated before 0.4.0 (host-managed, `agents` in the manifest) are still found and keep working; linking another agent takes precedence.

## Development

```
pnpm test                 # vitest
npx tsc --noEmit -p .     # typecheck (run `pnpm --filter @paperclipai/plugin-sdk ensure-build-deps` from the repo root once)
node ./esbuild.config.mjs # dist/ (worker, manifest, ui, ui/oauth-callback.html + .js)
```

Migrations 001–010 may be applied on installed instances; never edit them — add `011_seo.sql` and up.
