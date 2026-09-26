# SEO

Paperclip plugin `partnersinbiz.seo` (v0.6.0): 90-day SEO sprints for Partners in Biz's own sites and its clients.

- A **sprint** is one site on the Outrank-90 template: 42 tasks over weeks 0–13, then open-ended compounding. Sprints also seed 15 directory backlinks.
- **Scope.** A sprint without a client is PiB's own. A client sprint references one CRM company or CRM contact (`client_kind` + `client_ref`, name from the CRM projection). `/seo` shows only own sprints; `/seo?client=company:<id>` or `?client=contact:<id>` is that client's workspace (shared client bar, opened from the CRM). Opening a sprint in the wrong scope redirects to its own.
- Each sprint has a **root issue** ("SEO sprint: <site> (<client>)") in the managed **SEO** project. Every task becomes a **sub-issue** on the day it is due; client sprint issues start with `[<client>]` unless the title already names the client. Every task goes to the linked **SEO agent** (see *Hiring the SEO agent*); code and content tasks open in the sprint's **site project** (the repo workspace). What only a person can do is batched in one weekly **Needs you** issue (see *Autonomy*).
- `GET /api/plugins/partnersinbiz.seo/api/client-summary?companyId=&kind=company|contact&id=<crm id>` (board auth) returns `{ headline, stats }` for the CRM client workspace.
- The plugin never writes content. The agent works issues with the `partnersinbiz.seo:*` tools (skill `pib-seo-sprint`). Tool results are always JSON objects (kit `toolOk` / `toolFail`), so MCP `structuredContent` is never null.
- **Keyword intent (0.5.0).** `discover-keywords` and `add-keywords` (for keywords without an intent) ask Jev for the Outrank-90 bucket (problem / solution / brand), sending only the keyword phrase and the site name, 8 calls at a time (kit `decideMany`). At or above the `update` threshold (0.7) Jev's answer is used; otherwise the word-rule guess (`inferIntent`) stays. Candidates carry `intentSource: jev | rules`. Every answer is logged in `decisions` (migration `011_seo.sql`). Settings: `jev` block (TypeSafe key as a Paperclip secret); empty = rules only.
- **Exploration (0.5.0).** Weekly proposals rank a signal's candidate hypotheses with UCB over the sprint scoreboard (kit `rankHypothesisTypes`): untried types first, then mean result plus an exploration bonus. Ties keep the candidate order.

## Timeline

Day 0 = start (launch) date. Week 0 = pre-launch (due immediately). Week *n* ≥ 1 covers days 7n−6 … 7n. Day-90 audit tasks are due on day 90. Phase follows the week (0; 1–4; 5–10; 11–13; 14+ = compounding).

## Jobs

| Job | Schedule | Does |
|---|---|---|
| `seo-daily` | `5 * * * *` | Once per sprint per local day after `dailyHourLocal` (default 06:00 SAST): clock/status, root issue, plan upgrade to v3 (once), GSC pull (8 days to yesterday; the service account finds the property itself), PageSpeed (home + 3 rotating pages), Bing link counts, audit snapshots (day 0/30/60/90, then every 30 days), open due sub-issues, measure optimizations (14 days after approval), raise missing one-time grants on Needs you and close the ones now done (weekly rollover), the 14-day indexing follow-up, re-sync task status from issues, store today's plan. |
| `seo-weekly` | `0 5 * * 1` (07:00 SAST Mon) | Detectors → health → up to 2 proposals per 7 days in the first 4 weeks (5 later) → one approval issue for the sprint owner. |

Jobs have no invocation scope: they only act for companies whose SEO settings are saved.

## Autonomy (0.6.0)

The SEO agent runs the whole sprint. Plan v3 of Outrank-90 has **no person tasks**; sprints seeded earlier are upgraded by the daily run (open person tasks → agent: issue reassigned, title and description rewritten, agent woken; agent tasks blocked on a person are retried; done tasks untouched).

- **Site link per sprint** (`link-site`, Integrations → Site repo): the Paperclip project whose workspace holds the site repo, default branch, framework, hosting and the **change policy**. Code and content tasks (meta, schema, sitemap/robots, verification files, alt text, noindex, canonical, internal links, new pages/posts, fixes like a broken WebSite SearchAction) open as sub-issues of the sprint root **in the site project**, so the agent runs in the repo workspace. Until a project is linked they wait and one Needs you item asks for the link. `noRepo` (CMS or client-managed): change sets go through Needs you. The plugin cannot create project workspaces; the UI links to Projects → New project with the steps.
- **Change policy.** `merge_seo_scope` (default): the agent branches `seo/<task-key>`, opens a PR, waits for CI and the Vercel preview, verifies the preview with the check tools and merges itself when `check-change-scope` says every changed file is SEO scope; otherwise the PR stays open on Needs you. `pr_only`: never merges. `full`: merges any SEO-plan change when checks pass. Agents may only lower the policy. After the deploy it re-checks production and closes the task with the PR, commit and check output.
  - **SEO scope:** `<head>` metadata (title, description, canonical, robots meta, Open Graph/Twitter); JSON-LD; sitemap and robots; verification and key files (google-site-verification, BingSiteAuth.xml, IndexNow key); image alt text; internal links; new blog/landing pages from approved briefs; redirects that fix SEO problems. Never: dependencies/lockfiles, CI, env files, hosting/build config, middleware, API routes, database, auth/payments, tooling config, next.config other than redirects.
  - Git and GitHub: Paperclip uses the company secret `GITHUB_TOKEN` for project workspaces and gives it to the agent as `$GITHUB_TOKEN`. The skill's `references/site-changes.md` does everything with git + the GitHub REST API (curl); `gh` is optional.
- **Google via one service account** (`google.serviceAccountJson`, a secret-ref): OAuth 2.0 JWT bearer (RS256 with `node:crypto`, scopes `webmasters` + `siteverification`, tokens cached ~50 min). Every Search Console call prefers it; the per-sprint OAuth connection is the fallback (also on a 403 from the service account). Tools: `gsc-verification-token` (META/FILE for URL-prefix, DNS_TXT for domains), `gsc-verify-site` (`webResource.insert` → the service account becomes a verified owner → `sites.add` → property stored → sitemap submitted), `gsc-check-access` (client sites: the Needs you item carries the email with the service account address and the Search Console Users link).
- **Crawling:** Google has no public request-indexing API for normal pages. `indexnow-key` + `request-indexing` (sitemap, IndexNow ping to `api.indexnow.org`, URL Inspection). 14 days later the daily run re-inspects and adds optional URL-inspection links to Needs you only for pages still not indexed.
- **Bing** through its API with `bingApiKey`: `bing-add-site` (AddSite + BingSiteAuth.xml / meta), `bing-verify-site` (VerifySite + SubmitSitemap), `bing-submit` (SubmitSitemap / SubmitUrlBatch). No key → a Needs you item with the exact link.
- **Needs you** (`needs-you`, `needs-you-add`, `needs-you-resolve`): one issue per sprint per week, assigned to the sprint owner, listing only true one-time grants (link the site project, the service account key, add the service account on a client property, GitHub token, Bing key), out-of-scope PRs and messages from personal accounts — each with steps, links, copy-ready text and what the agent does next. Items dedupe by key; items the plugin can check (keys, access, repo link, task done) close on their own every morning; resolving an item hands its tasks back to the agent. A new week rolls open items into a new issue. `block-task` (not review) now lands here and the task stays with the agent.
- **Sign-off** (safe mode) stays for publishing posts, pSEO launches, pitches and public announcements: `block-task` + `review: true`. When the owner approves a hand-off that carried a PR, the agent gets a follow-up task to merge it.
- **Setup checklist** (`setup-checklist`, SEO page and each sprint's Integrations tab): status, deep link and what the agent does next for settings, service account key, GitHub access, agent, PageSpeed key, Bing key; per sprint the site repo, property, Bing site and autopilot (`safe` recommended).

## Setup (once)

1. **Google service account** (project `partners-in-biz-85059`): IAM → Service accounts → Create ("paperclip-seo") → Keys → Add key → JSON. Enable the *Site Verification API* and *Google Search Console API* (and *PageSpeed Insights API*). Store the JSON as a Paperclip secret and pick it in SEO settings → Google service account key.
2. **GitHub:** a fine-grained token for the site repos (Contents RW, Pull requests RW, Commit statuses + Checks read, Metadata read) as company secret `GITHUB_TOKEN` (Settings → Secrets).
3. **SEO settings** (Settings → Plugins → SEO), save for the PiB company: timezone, daily hour, default autopilot (`safe`), service account key, Bing Webmaster API key (bing.com/webmasters → Settings → API access), PageSpeed key (optional). Public base URL, token encryption key and the OAuth client are only needed for the OAuth fallback (redirect URI `https://<paperclip host>/_plugins/<plugin installation id>/ui/oauth-callback.html`).
4. **SEO page → Activate SEO agent** opens a hire task (see below). Once the agent is linked, **Resume** it when its adapter has a working model key, and enable the routine triggers ("Run today's SEO" 06:30, "Weekly SEO review" Mon 07:00, Africa/Johannesburg).
5. For each sprint: **Integrations → Site repo** → pick the project with the site repo workspace (create it under Projects first if needed). Everything else the agent does, and asks for anything missing through Needs you.

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

Migrations 001–012 may be applied on installed instances; never edit them — add `013_seo.sql` and up. `012_seo.sql`: sprint site link columns (`site_project_id`, `site_access`, `repo_url`, `default_branch`, `framework`, `hosting`, `change_policy`, `verification`), `sprint_tasks.issue_project_id`, and the `needs_you` table.
