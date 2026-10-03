# SEO

Paperclip plugin `partnersinbiz.seo` (v0.11.0): 90-day SEO sprints for Partners in Biz's own sites and its clients.

- A **sprint** is one site on the 90-day plan for its **kind of business** (see *Plans by business type*): 42–46 tasks over weeks 0–13, then open-ended compounding, plus 13–15 seeded directories and business profiles.
- **Scope.** A sprint without a client is PiB's own. A client sprint references one CRM company or CRM contact (`client_kind` + `client_ref`, name from the CRM projection). `/seo` is the SEO home: **every** sprint, our own sites first, then one group per client, each with its status and the next thing due. `/seo?client=company:<id>` or `?client=contact:<id>` is that client's workspace (shared client bar, opened from the CRM). Opening a sprint in the wrong scope redirects to its own.
- Each sprint has a **root issue** ("SEO sprint: <site> (<client>)") in the managed **SEO** project. Every task becomes a **sub-issue** on the day it is due; client sprint issues start with `[<client>]` unless the title already names the client. Every task goes to the linked **SEO agent** (see *Hiring the SEO agent*); code and content tasks open in the sprint's **site project** (the repo workspace). What only a person can do is batched in one weekly **Needs you** issue (see *Autonomy*).
- `GET /api/plugins/partnersinbiz.seo/api/client-summary?companyId=&kind=company|contact&id=<crm id>` (board auth) returns `{ headline, stats }` for the CRM client workspace: due now, overdue, stuck (only when the agent cannot work), needs you, health, keywords tracked — the same numbers as the SEO page and the Cockpit.
- The plugin never writes content. The agent works issues with the `partnersinbiz.seo:*` tools (skill `pib-seo-sprint`). Tool results are always JSON objects (kit `toolOk` / `toolFail`), so MCP `structuredContent` is never null.
- **Keyword intent (0.5.0).** `discover-keywords` and `add-keywords` (for keywords without an intent) ask Jev for the Outrank-90 bucket (problem / solution / brand), sending only the keyword phrase and the site name, 8 calls at a time (kit `decideMany`). At or above the `update` threshold (0.7) Jev's answer is used; otherwise the word-rule guess (`inferIntent`) stays. Candidates carry `intentSource: jev | rules`. Every answer is logged in `decisions` (migration `011_seo.sql`). Settings: `jev` block (TypeSafe key as a Paperclip secret); empty = rules only.
- **Exploration (0.5.0).** Weekly proposals rank a signal's candidate hypotheses with UCB over the sprint scoreboard (kit `rankHypothesisTypes`): untried types first, then mean result plus an exploration bonus. Ties keep the candidate order.

## Plans by business type

Most PiB clients are South African service businesses, so a sprint follows one of four plans (`templates/plans.ts`); the sprint stores it as `template_id`:

| `businessType` | Plan | For | What it adds |
|---|---|---|---|
| `local` | Local service business (`outrank-90-local`, 46 tasks) | guest houses, clinics, biokineticists, clubs, trades | Google Business Profile (claim, complete), one exact name/address/phone everywhere, service, contact and area pages, reviews, industry listings, local partners and press; seeds Google Business Profile, Bing Places, Apple Business Connect, Facebook, Hellopeter, Foursquare, Yellow Pages, Yell, Brabys, Cylex, Snupit, saYellow, Hotfrog, Showme, YelloSA |
| `professional` | Professional services (`outrank-90-professional`, 46 tasks) | law firms, accountants, consultancies | practice-area pages, team page with credentials, case studies, area pages, professional bodies, referral partners, industry articles; seeds the local basics plus LinkedIn, Kompass and Clutch |
| `ecommerce` | Online shop (`outrank-90-ecommerce`, 45 tasks) | online shops | Google Merchant Center, category and product pages, product reviews, buying guides, collection and comparison pages; seeds Merchant Center, PriceCheck, Hellopeter, Trustpilot, Pinterest and the main SA directories |
| `saas` | Software (`outrank-90`, 42 tasks) | software | the original Outrank-90 launch plan with G2, Product Hunt and SaaS directories |

- **Choosing.** `create-sprint` takes `businessType`; without it a client gets `local` and our own sites `saas`. The SEO page preselects it from the client's CRM profile (the page, as the signed-in person, reads the CRM's `crm.client-workspace`: services, website, audience, name; `engine/business-type.ts`) and says why; for our own sites it asks.
- **Changing.** `change-plan` (tool, and the sprint's ⋯ menu) adds the new plan's missing tasks and sources (due ones open at once), rewords shared tasks nobody started, marks the old plan's unstarted tasks `na` (not needed; their issues are cancelled) and its unstarted seeded directories rejected (not relevant), and leaves started work open. Sprints created before the variants keep the software plan until someone changes it.
- A task key means the same work in every plan and has one playbook; a plan can give a shared task its own title. New seeds never carry a domain rating (only from a real source).
- New code task types: `nap-fix`, `reviews-display`, `area-pages`, `collection-pages`. The directory task's completion check now counts directories and citations.

## Numbers: due, overdue, stuck, waiting

One definition (`engine/due.ts`) for the SEO page, `list-sprints` / `get-sprint`, the CRM card and the Cockpit snapshot:

- **Due**: the plan has reached the task's day (no day = due at once) and it is not done or skipped.
- **Overdue**: due and still open 7 or more days after its day.
- **Waiting on you**: blocked (on Needs you), in sign-off, or a person's task.
- **Stuck**: due agent work while the linked SEO agent is paused, in error or waiting for approval, or no agent is linked (paused sprints are never stuck). The page marks those tasks "Stuck: agent needs attention" with **Fix in Setup → Team**; the Cockpit adds a `seo_stuck_tasks` KPI.
- **Active sprint**: running (pre-launch, active or compounding) with its 90-day plan. **Needs you** on the SEO home = open required Needs you items plus proposals waiting for approval (not on full autopilot), the same items the Cockpit lists.

## Timeline

Day 0 = start (launch) date. Week 0 = pre-launch (due immediately). Week *n* ≥ 1 covers days 7n−6 … 7n. Day-90 audit tasks are due on day 90. Phase follows the week (0; 1–4; 5–10; 11–13; 14+ = compounding).

## Jobs

| Job | Schedule | Does |
|---|---|---|
| `seo-daily` | `5 * * * *` | Once per sprint per local day after `dailyHourLocal` (default 06:00 SAST): clock/status, root issue, plan upgrade to the current template (once), GSC pull (8 days to yesterday; the service account finds the property itself), PageSpeed (home + 3 rotating pages), Bing link counts, audit snapshots (day 0/30/60/90, then every 30 days), open due sub-issues, measure optimizations (14 days after approval), raise missing one-time grants on Needs you and close the ones now done (weekly rollover), the 14-day indexing follow-up, re-sync task status from issues, store today's plan. |
| `seo-weekly` | `0 5 * * 1` (07:00 SAST Mon) | Detectors → health → up to 2 proposals per 7 days in the first 4 weeks (5 later) → one approval issue for the sprint owner. |

Jobs have no invocation scope: they only act for companies whose SEO settings are saved.

## Autonomy (0.6.0)

The SEO agent runs the whole sprint. Plan v3 of Outrank-90 has **no person tasks**; sprints seeded earlier are upgraded by the daily run (open person tasks → agent: issue reassigned, title and description rewritten, agent woken; agent tasks blocked on a person are retried; done tasks untouched).

- **Site link per sprint** (`link-site`, Integrations → Site repo): the Paperclip project whose workspace holds the site repo, default branch, framework, hosting and the **change policy**. Code and content tasks (meta, schema, sitemap/robots, verification files, alt text, noindex, canonical, internal links, new pages/posts, fixes like a broken WebSite SearchAction) open as sub-issues of the sprint root **in the site project**, so the agent runs in the repo workspace. Until a project is linked they wait and one Needs you item asks for the link. `noRepo` (CMS or client-managed): change sets go through Needs you. `wordpressSiteId` (0.10.0): a client's WordPress site through the PiB Connector (see *0.10.0*). The plugin cannot create project workspaces; the UI links to Projects → New project with the steps.
- **Change policy.** `merge_seo_scope` (default): the agent branches `seo/<task-key>`, opens a PR, waits for CI and the Vercel preview, verifies the preview with the check tools and merges itself when `check-change-scope` says every changed file is SEO scope; otherwise the PR stays open on Needs you. `pr_only`: never merges. `full`: merges any SEO-plan change when checks pass. Agents may only lower the policy. After the deploy it re-checks production and closes the task with the PR, commit and check output.
  - **SEO scope:** `<head>` metadata (title, description, canonical, robots meta, Open Graph/Twitter); JSON-LD; sitemap and robots; verification and key files (google-site-verification, BingSiteAuth.xml, IndexNow key); image alt text; internal links; new blog/landing pages from approved briefs; redirects that fix SEO problems. Never: dependencies/lockfiles, CI, env files, hosting/build config, middleware, API routes, database, auth/payments, tooling config, next.config other than redirects.
  - Git and GitHub: Paperclip uses the company secret `GITHUB_TOKEN` for project workspaces and gives it to the agent as `$GITHUB_TOKEN`. The skill's `references/site-changes.md` does everything with git + the GitHub REST API (curl); `gh` is optional.
- **Google via one service account** (`google.serviceAccountJson`, a secret-ref): OAuth 2.0 JWT bearer (RS256 with `node:crypto`, scopes `webmasters` + `siteverification`, tokens cached ~50 min). Every Search Console call prefers it; the per-sprint OAuth connection is the fallback (also on a 403 from the service account). Tools: `gsc-verification-token` (META/FILE for URL-prefix, DNS_TXT for domains), `gsc-verify-site` (`webResource.insert` → the service account becomes a verified owner → `sites.add` → property stored → sitemap submitted), `gsc-check-access` (client sites: the Needs you item carries the email with the service account address and the Search Console Users link).
- **Crawling:** Google has no public request-indexing API for normal pages. `indexnow-key` + `request-indexing` (sitemap, IndexNow ping to `api.indexnow.org`, URL Inspection). 14 days later the daily run re-inspects and adds optional URL-inspection links to Needs you only for pages still not indexed.
- **Bing** through its API with `bingApiKey`: `bing-add-site` (AddSite + BingSiteAuth.xml / meta), `bing-verify-site` (VerifySite + SubmitSitemap), `bing-submit` (SubmitSitemap / SubmitUrlBatch). No key → a Needs you item with the exact link.
- **Needs you** (`needs-you`, `needs-you-add`, `needs-you-resolve`): one issue per sprint per week, assigned to the sprint owner, listing only true one-time grants (link the site project, the service account key, add the service account on a client property, GitHub token, Bing key), out-of-scope PRs and messages from personal accounts — each with steps, links, copy-ready text and what the agent does next. Items dedupe by key; items the plugin can check (keys, access, repo link, task done) close on their own every morning; resolving an item hands its tasks back to the agent. A new week rolls open items into a new issue. `block-task` (not review) now lands here and the task stays with the agent.
- **Sign-off** (safe mode) stays for publishing posts, pSEO launches, pitches and public announcements: `block-task` + `review: true`. When the owner approves a hand-off that carried a PR, the agent gets a follow-up task to merge it; Social hears about the page only after that merge (see 0.8.0).
- **Setup checklist** (`setup-checklist`): status, deep link and what the agent does next for settings, service account key, GitHub access, agent, PageSpeed key, Bing key; per sprint the site repo, property, Bing site and autopilot (`safe` recommended). The SEO home shows the company steps in its setup card; a sprint's Integrations tab shows only that sprint's steps.

## Setup (once)

1. **Google service account** (project `partners-in-biz-85059`): IAM → Service accounts → Create ("paperclip-seo") → Keys → Add key → JSON. Enable the *Site Verification API* and *Google Search Console API* (and *PageSpeed Insights API*). Store the JSON as a Paperclip secret and pick it in SEO settings → Google service account key.
2. **GitHub:** a fine-grained token for the site repos (Contents RW, Pull requests RW, Commit statuses + Checks read, Metadata read) as company secret `GITHUB_TOKEN` (Settings → Secrets).
3. **SEO settings** (Settings → Plugins → SEO), save for the PiB company: timezone, daily hour, default autopilot (`safe`), service account key, Bing Webmaster API key (bing.com/webmasters → Settings → API access), PageSpeed key (optional). Public base URL, token encryption key and the OAuth client are only needed for the OAuth fallback (redirect URI `https://<paperclip host>/_plugins/<plugin installation id>/ui/oauth-callback.html`).
4. **Setup → Team → SEO Specialist** hires the agent (a hire task, see below) or picks one you already have. Once the agent is linked, **Resume** it when its adapter has a working model key. The routines ("Run today's SEO" 06:30, "Weekly SEO review" Mon 07:00, Africa/Johannesburg) are created switched on.
5. For each sprint: **Integrations → Site repo** → pick the project with the site repo workspace (create it under Projects first if needed). Everything else the agent does, and asks for anything missing through Needs you.

## Hiring the SEO agent

The plugin does not create its agent. Every agent is hired the same way, through a normal Paperclip task, so it lands in the org chart.

- **Hire** (in Setup → Team, action `seo.start-hire`; the popup's draft comes from `seo.hire-options`) opens a *New task* prefilled with a hire request: name and title (SEO Specialist), role `general`, adapter `hermes_local` then `claude_local`, the `pib-seo-sprint` skill, budget, a short AGENTS.md (the procedure lives in the skill) and what the plugin sets up afterwards. Edit it, pick who does the hire (defaults to the CEO agent; or yourself) and create it. The task has origin `plugin:partnersinbiz.seo` / `hire:seo-specialist`.
- **Auto-link.** When exactly one agent created after the task matches (has the skill, or is named/titled "SEO Specialist"), the plugin links it: on agent events, on SEO page load, and from the hourly `seo-daily` job. More than one match waits for a person.
- **Wiring** (on link and on **Re-sync**): syncs the skill, reconciles the SEO project, assigns both routines to the agent (an existing routine held by another agent is moved over with its active/paused status kept) and switches on routines an older version created paused (unless a person changed them), gives it plugin tool access with the kit's `mergePluginToolsGrant` (one `tools:use` grant per agent, widened, never duplicated; a grant limited to named tools is left to a person), points every sprint at it and hands it waiting agent tasks. The steps are commented on the hire task. The plugin cannot attach skills to an agent; if `pib-seo-sprint` or the operating manual `pib-company-os` is missing it says so (the SEO page attaches both for the person viewing it).
- **Pick / change / remove** in Setup → Team links any existing agent by hand (`seo.link-agent`) or forgets the link (`seo.unlink-agent`; the agent, its routines and tasks are untouched).
- **The SEO page** shows an agent box only when something is wrong: no agent and no open hire, a hire open without an agent, the agent paused, in error or waiting for approval, or `pib-seo-sprint` missing. It says what is wrong in one line and links to **Fix in Setup** (Setup → Team); for a missing skill it also offers **Attach skills** and **Re-sync** (`seo.activate-agent`). When the agent is fine the page shows nothing.
- Agents activated before 0.4.0 (host-managed, `agents` in the manifest) are still found and keep working; linking another agent takes precedence.

## Development

```
pnpm test                 # vitest
npx tsc --noEmit -p .     # typecheck (run `pnpm --filter @paperclipai/plugin-sdk ensure-build-deps` from the repo root once)
node ./esbuild.config.mjs # dist/ (worker, manifest, ui, ui/oauth-callback.html + .js)
```

Migrations 001–015 may be applied on installed instances; never edit them — add `016_seo.sql` and up. `012_seo.sql`: sprint site link columns (`site_project_id`, `site_access`, `repo_url`, `default_branch`, `framework`, `hosting`, `change_policy`, `verification`), `sprint_tasks.issue_project_id`, and the `needs_you` table.

## 0.13.3: pacing (many sprints, one agent)
The daily run no longer floods the agent. (1) Each sprint keeps at most 8 agent task issues in flight (`SPRINT_ISSUE_CAP`): the daily run tops it up to 8 and the rest of the due tasks wait for the next day, oldest week first. **Start now** on the plan is the way past the cap. (2) Sprints start 0 to 2 hours after the configured daily hour (a stable offset from the sprint id), so several companies or clients do not all fire in the same hourly tick. The agent's own `maxConcurrentRuns` (Paperclip agent settings) is the hard brake on parallel runs; keep it low (6) on a shared VPS.

## 0.13.1: hand-off lines close themselves
(0.13.2 narrowed it to the standard `task:<id>` lines.) A Needs you line that exists because a task was handed to a person (block-task, or a person's own task) now closes in the daily check once that task is done or skipped, whoever finished it. Before, only PR and sign-off lines did, so a task the agent finished itself (for example a sitemap submission) kept showing as outstanding.

## 0.13.0: Start now (pull the plan forward)
The plan follows the calendar: a task gets its issue only when the sprint reaches its day. To get ahead, the plan tab has a **Start** button on every week that still has upcoming tasks, and a **Start now** button on an upcoming task's detail sheet. Both call the tool `start-tasks-now` (`sprintId` plus `taskId` or `week`): the tasks become due today and their issues open at once, with the usual owner rules (agent work is assigned and woken, person tasks go on Needs you). Nothing else in the plan moves; audit snapshots stay on their days. Up to 25 tasks per call. People decide the pace: an agent may call it only when the sprint's autopilot is full, and the `today` next-steps only mention it then.

## 0.12.0: verification through the Connector (wp-verify)
With Connector 1.2 (CRM 0.9.0, tool `partnersinbiz.crm:wp-verify`) the agent verifies a WordPress site itself: Google Site Verification meta tag or HTML file, Bing `msvalidate.01` tag or `BingSiteAuth.xml`, the IndexNow key file. Nothing is written to disk. No client grant is needed: the service account becomes a verified owner of the URL-prefix property.
- **`check-change-scope`** treats `verification_file` as applicable on a `wordpress` sprint whose connected Connector is 1.2 or newer; an older Connector is out of scope with the instruction to run `wp-connector` update first (the response carries `verifyRoute`: available, update or none).
- **`gsc-check-access`.** WordPress + Connector 1.2: no client email; it returns `verificationRoute` (gsc-verification-token method META property url → wp-verify set → gsc-verify-site). WordPress + older Connector: the same, starting with wp-connector update. Only after `gsc-verify-site` failed on that route (recorded as `verification.wpVerifyFailures.google` on the sprint, cleared on success) does it queue the client email, and the result says the route failed and why. `askClient` is ignored until then. Repo, no-repo and unconnected sites behave as before.
- **`gsc-verification-token`, `indexnow-key`, `bing-add-site`** return the exact `wp-verify` call for such sprints; `bing-verify-site` records a failed Bing attempt.
- **Needs you.** `needs-you-add` refuses Search Console access, Bing verification and IndexNow key items on such sprints (an item is recognised by its key or title: `gsc_access`, `indexnow_key_*`, `bing_verification_*`, msvalidate, BingSiteAuth) unless `wpVerifyFailed` says what was tried; the failure is recorded. The daily check closes existing open items of that kind as superseded (history kept, note explains, waiting tasks go back to the agent) unless the route already failed for that kind. Merchant Center account creation, plugin installs and deactivation stay with a person.
- **Setup checklist.** The Search Console and Bing rows say the agent verifies through the Connector on such sprints instead of asking the client.
- Docs: the SEO Specialist skill, `references/wordpress.md` (new section 9), the WordPress task copy and the w0-gsc-verify, w0-gsc-request-index and w0-bing-verify playbooks.

## 0.11.0: WordPress changes without wp-admin (Connector 1.1)

- **Wider scope on WordPress.** Under `merge_seo_scope` and `full` the agent now applies, through the CRM's Connector tools: SEO fields for pages, categories (`termId`) and archives or the shop (`postTypeArchive`), share images (`ogImage`), image alt text (`wp-media` alt, `wp-content` img-alt), featured images (`wp-media` sideload and set-featured), page copy edits (`wp-content` update, always with a reason), new pages as drafts and publishing its own drafts when the task says so (`wp-content` create and publish), and the Connector's own update (`wp-connector`). `check-change-scope` accepts the categories `image_alt`, `internal_links`, `new_content`, `page_copy` and `media` on WordPress (repo sprints are unchanged).
- **Still Needs you:** plugin installs and rollbacks, deleting anything, publishing anything the Connector did not create, a site's theme or settings, and anything that needs an image the agent has no source for (it asks for the asset, not for a wp-admin edit). The agent never hotlinks an image it has no rights to; sources are the Media Library, the client's Drive or brand kit, the client's Social media library, or an image it generates when its run has such a tool (this repo has none).
- **Update before parking.** The SEO Specialist skill and the task copy say: when the Connector lacks an ability, run `wp-health` and `wp-connector` update before putting the task on Needs you. Connector 1.0.x cannot update itself; that case is one manual zip upload (with the link from `check-client-site`) and then the agent keeps it current.
- Skill reference `references/wordpress.md` is rewritten around the new tools. Requires CRM 0.8.0 and Connector 1.1.0.

## 0.10.0: WordPress sites through the PiB Connector

- **Fourth site access mode `wordpress`.** `link-site` with `wordpressSiteId` (a CRM website id) links the sprint to one of its client's WordPress sites. The site must be in the CRM, be WordPress and belong to the sprint's client; PiB's own sprints cannot use a client site. The sprint stores `site_id`; `projectId`, `noRepo` and `unlink` clear it. Code and content tasks stay in the SEO project (like `none`).
- **Site projection.** Migration `015_seo.sql` adds `crm_sites` (kit `crmSiteProjectionMigration`), fed by the CRM's `site.upserted` / `site.deleted` events (kit `registerCrmSiteProjection`), plus `sprints.site_id` and `'wordpress'` in `sprints_site_access_check`. It never holds the Connector key.
- **How the agent works.** Every SEO change goes through the CRM's Connector tools with the site id: `partnersinbiz.crm:wp-seo`, `wp-schema`, `wp-redirects`, `wp-robots`, `wp-sitemap`, `wp-health`, `wp-log`, `wp-undo` (writes take a `reason`), then it verifies on the live site with `check-meta`, `validate-schema`, `check-sitemap`, `crawler-sim`. `merge_seo_scope` / `full`: it applies SEO fields, schema, redirects, robots lines and sitemap settings itself (0.11.0 adds media, page copy and new drafts, see *0.11.0*); `pr_only`: the change set goes on Needs you. Plugin installs always go to a person. Skill reference `references/wordpress.md`.
- **`check-change-scope`** on a WordPress sprint takes `wp:<area>:<target>` paths and answers `apply` or `pr_only` (fields `decision`, `verdict`, `siteAccess: "wordpress"`); the repo behaviour is unchanged.
- **Needs you `wp_connector`.** Raised when the Connector is not connected (on link, by the daily run, or `needs-you-add` key `wp_connector`), with the pairing steps; it closes itself once the projected site reads `connected`. The setup checklist counts a WordPress link as linked and shows the same steps until the Connector is connected.
- **Auto-link.** A new client sprint links itself when the client has exactly one WordPress site at the sprint's URL and its Connector is connected (best effort).
- **UI.** Integrations → Site repo lists the client's WordPress sites (with "WordPress · Yoast SEO · Connector connected") next to the repo projects, and shows the linked site with a hint while the Connector is not connected.

## 0.8.0

- **`content.published` only once the change is live.** A content row marked live, or a finished publish task, is queued in `announcements` (migration `014_seo.sql`). It goes to Social only when any approved PR's merge task is done and the page answers 200 (SSRF-guarded fetch), with the page's own summary (meta description, else og:description, else its first paragraph). Checks back off from 10 minutes to 6 hours; after 3 days without a 200 it is stuck: the Cockpit health (`social-handoff`) and `today` say so, and it is still checked daily. Sent keys are re-sent hourly for 24 hours. `update-content` / `add-content` / `complete-task` answer with `socialHandOff`.
- **Legacy tool aliases removed:** `open-task`, `add-keyword`, `record-rank`, `rank-history`, `add-page`, `record-audit` (use `add-task`, `add-keywords`, `record-position`, `keyword-history`, keyword/content `targetUrl`, `record-finding`). Every tool param has a description, and an enum where the values are fixed.
- **Plan v4:** repurposing is the Social agent's. Tasks w5/w6 are now "Hand post N to Social: mark it live, then link its social posts" (no sign-off; complete-task checks the linked posts). Older sprints are rewritten by the daily run.
- **Routines ship on:** created active with their schedules on when an agent is linked, because they are the agent's own daily and weekly work, not a money, legal, grant or judgement decision. Routines an older version created paused go active (unless a person changed them). The worker cannot read triggers, so the SEO page (as the board user) reads and reports them (`seo.routine-report`); the setup item "Switch on the SEO routines" is done only when both are active with their schedules on, and its link (`/seo?routines=on`) switches an old, off schedule on in one click.
- **Team:** the hire role ends with the company operating manual (`pib-company-os`), and the page attaches it; hire matching leaves it out (`SEO_MATCH_ROLE`). The Cockpit snapshot reports the SEO Specialist in `team`. The skill finds clients with `partnersinbiz.crm:find-records` / `get-company` and asks people with `partnersinbiz.cockpit:ask-owner` (sprint items stay on Needs you).
- **Overview:** a "Finish setting up SEO" card (pib-plugin-ui `GetStarted`, one line once sprints exist); the full checklist is one click away.

## 0.8.0 UI polish

- **SEO home** lists every sprint grouped by client with its status and next thing due; tiles for active sprints, due now (with overdue), needs you and stuck (else lowest health). The agent box sits above the setup card and says how many tasks are stuck.
- **Sprint page:** the client workspace bar's back link plus one breadcrumb (`Northwind › SEO › site`); one ⋯ menu for run today's work, the weekly review, autopilot, plan type, the sprint issue, pause and archive; one-line stuck and Needs you banners; on a phone the tabs that need you come first. Lists are compact rows on a phone that open a sheet.
- **Plain words:** Google and Bing errors in one sentence with the raw text once under Details (`engine/plain.ts`; the PageSpeed daily limit is not a Cockpit warning); template titles without GSC, DR or LCP (older sprints show the new wording); no "task(s)"; readable dates (`formatDate` / `formatShortDate`); setup steps render **bold**, `code` and links.

