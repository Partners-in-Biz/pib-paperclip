# SEO

Paperclip plugin `partnersinbiz.seo` (v0.2.0): 90-day SEO sprints for Partners in Biz clients.

- A **sprint** is one client site (client = CRM company, `client_ref`) on the Outrank-90 template: 42 tasks over weeks 0–13, then open-ended compounding. Sprints also seed 15 directory backlinks.
- Each sprint has a **root issue** ("SEO sprint: <site> (<client>)") in the managed **SEO** project. Every task becomes a **sub-issue** on the day it is due. Agent tasks go to the managed **SEO Specialist**; tasks that need a person go to the sprint owner.
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
3. **SEO page → Activate SEO agent**: creates the paused SEO Specialist, the SEO project and the two paused routines, and grants the agent `tools:use` for plugin tools. Then approve the hire if asked, **Resume** the agent, and enable the routine triggers ("Run today's SEO" 06:30, "Weekly SEO review" Mon 07:00, Africa/Johannesburg).
4. For each sprint: **Integrations → Connect Google Search Console** (property auto-selected when it matches the site).

## Development

```
pnpm test                 # vitest
npx tsc --noEmit -p .     # typecheck (run `pnpm --filter @paperclipai/plugin-sdk ensure-build-deps` from the repo root once)
node ./esbuild.config.mjs # dist/ (worker, manifest, ui, ui/oauth-callback.html + .js)
```

Migrations 001–009 are applied on installed instances; never edit them — add `010_seo.sql` and up.
