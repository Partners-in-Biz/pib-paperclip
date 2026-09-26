# Social

Paperclip plugin `partnersinbiz.social`: connect social accounts, draft posts with media and per-platform overrides, approve them, and publish on schedule with retries.

## Scope: own work or one client

Every account, post, media asset, RSS feed and inbox item belongs to one scope: PiB's own work (no client) or one CRM client (a company, or a contact for sole traders; `client_kind` + `client_ref`).

- `/social` shows own work only. A client's social work opens from the CRM client workspace as `/social?client=company:<id>` (or `contact:<id>`), with the shared workspace bar on top. New accounts, posts, media and feeds belong to the page's scope; tab changes and the OAuth return keep `?client=`.
- Scopes never mix: a post only targets accounts and media of its own scope (checked on create/update/attach, before scheduling, and again by the publish job).
- An account moves scope from its Edit dialog ("Belongs to"). The move is refused while unpublished posts of the old scope still target it; its inbox moves with it and the old scope's feeds stop drafting to it.
- Agent tools take `client` ("company:<id>"/"contact:<id>") or `clientKind` + `clientRef`; omitting it means own work. Issues for client work are titled `[<client>] …`.
- `GET /api/plugins/partnersinbiz.social/api/client-summary?companyId=&kind=&id=` (board auth) returns `{ headline, stats }` for the CRM workspace.

## Setup

1. Settings → Plugins → Social, for the company: set **Public base URL** (e.g. `https://paperclip.partnersinbiz.online`), a **token encryption key** (secret, 16+ characters), the platform client ids/secrets and the R2 block. Click **Save** (jobs cannot act for a company without a saved config row).
2. Open the Social page once, then register the redirect URI it shows with every OAuth provider:
   `<publicBaseUrl>/_plugins/<plugin installation id>/ui/oauth-callback.html`.
   The host serves plugin files only by installation id (not by plugin key); the id changes only if the plugin is uninstalled and installed again.
3. R2 bucket CORS must allow the Paperclip origin to `PUT` with a `Content-Type` header.
4. Social page → Overview → **Hire Social agent** (or **Use an existing agent**), then Resume the agent once its adapter has a working model key. See "The Social agent" below.

## The Social agent

The plugin never creates its agent. Every agent is hired the same way, through a normal Paperclip task:

- **Hire Social agent** opens a New task popup prefilled with the hire request (`src/hire.ts`: name "Social Media Manager", role `general`, adapter `hermes_local` then `claude_local`, skills `pib-social-publish` + `pib-social-content`, budget $0, a short AGENTS.md). The person picks the assignee (usually the CEO / hiring agent, or themselves) and a task is created with `originId: hire:social-media-manager`.
- When an agent matching the spec appears (created after the task, with a social skill or the name/title "Social Media Manager"), the plugin links it automatically: on `agent.created` / `agent.updated` / `agent.status_changed` / `approval.decided`, on the Social page load, and from the hourly `refresh-tokens` job. It comments on the hire task with what it did.
- **Use an existing agent** / **Link agent** / **Change agent** links any agent by hand (for example an existing "Outbound & Social Specialist"). The plugin cannot attach skills to an agent it did not create, so the page and the link result say which of `pib-social-publish` / `pib-social-content` still have to be attached on the agent's Skills tab.
- Wiring a linked agent (`wireAgent`): merges a `tools:use` grant for plugin tools (Social + CRM), reconciles the Social project and assigns the weekly "Weekly social review & plan" routine (key `plan-next-week`) to it (an existing routine owned by another agent is reassigned and keeps its status; the Monday trigger stays off until enabled). Failed-post issues go to the linked agent from then on.
- **Re-sync** (`social.activate-agent`) wires the linked agent again. Agents activated before 0.4.0 (host-managed from the manifest `agents` declaration) are still found through `ctx.agents.managed.get` and keep working.
- Actions (people only): `social.hire-options`, `social.start-hire`, `social.link-agent` `{ agentId }`, `social.unlink-agent`, `social.activate-agent`. The link lives in plugin state (`pib-hire` / `role:social-media-manager`, company scope).

## How it works

- OAuth returns to a static bridge page (`dist/ui/oauth-callback.html`) that posts the code to `POST /api/plugins/partnersinbiz.social/api/oauth/complete` with the board session.
- Tokens are sealed with AES-256-GCM (kit `sealJson`) under the configured key; a missing key fails closed.
- Jobs: `publish-due` (5 min, retries 1/5/15/60 min, 5 attempts), `refresh-tokens` (hourly), `collect-metrics` (30 min), `poll-inbox` and `poll-rss` (15 min), `score-posts` (daily 03:25) and `measure-experiments` (daily 03:50). Every job takes company ids from its own rows and passes them explicitly.
- One post targets many accounts. Organisation posts cannot use a personal account. A person approves before a post can be scheduled.

## Jev inbox triage (0.5.0)

Settings → Social → **Jev decisions**: pick the TypeSafe API key secret (the same one in every PiB plugin), keep the pinned model, leave **Use Jev** on. Without a key nothing changes: inbox items stay `new` and nothing is sent anywhere.

- After each `poll-inbox` run (and for items recorded by hand) every new item gets **one** Jev call with only `platform`, `kind`, `text` (600 characters at most) and `post` (the caption it is on, 200 at most). Questions: `needs_reply` (noul), `intent` (question / complaint / praise / lead / spam / other), `sentiment` (negative / neutral / positive), `escalate` (legal, safety or PR risk).
- Actions: spam with confidence ≥ 0.7 (kit `update`) → marked read. `escalate` yes (≥ `read`) → an issue for a person (the post owner, else the account's creator, else the company's default person); the item is not queued for the agent. `needs_reply` yes and not spam → one issue **per account per day** for the Social agent ("Reply to social comments: …"); later items that day are added as comments and wake the agent.
- The answers are stored on the item (`inbox_items.triage`) and logged in `decisions` (kit `decisionsMigration`), with `acted` set on the answers the plugin acted on. The inbox shows chips; **Fix** corrects an answer (kit `correctDecision`, labelled data for later). Correcting a spam item to anything else brings it back to `new`.
- Failed calls are retried on the next poll, at most 3 times per item.

## Growth Lab (0.5.0)

An autoresearch-style loop per scope (own work, and each CRM client), channel `social`, on the kit `experiments.ts` tables (`growth_programs`, `growth_playbook_versions`, `growth_experiments`, `growth_experiment_items`) plus `post_scores`, `post_features` and `growth_playbook_changes`.

- **Program**: created on first use with the kit starter playbook. Goal and metric default to "engagement rate lift at 7d". Autopilot: `off` (agents only read), `safe` (default: agents propose, a person approves experiments and keeps or discards playbook changes), `full` (proposals start at once, the agent may decide changes, wins are kept automatically). Topics, brand voice, platforms and cadence are set on the **Growth** tab.
- **`score-posts`** (daily): for every destination with a 7-day snapshot, kit `engagementRate` (reach, else impressions, else views; none → not scored), baseline = median of the same account and platform over the 30 days before it (its own post excluded, at least 3 earlier posts), lift = rate ÷ baseline − 1. Then feature tags once per published post: format, length and posting daypart in code; hook, CTA, topic (only when the program lists topics) and tone from **one Jev call with the caption only** (1000 characters at most); plus the program's own questions. A new question backfills posts from the last 90 days with one call per post asking only the missing keys. Without Jev only the code features are stored.
- **Experiments**: `propose-experiment` (one variable, `hypothesisType` like `hook:question`, arms `control`/`variant`, `minPerArm` default 3, 7-day window). At most 3 running and 3 proposed per program. On `safe`, proposals and playbook changes go into **one approval issue per program per ISO week** (assigned to the program owner, the last person who saved its settings, else the company's default person); it closes itself when everything on it is decided. Posts carry `experiment_id` + `experiment_arm` (`experimentId` + `arm` on `create-post`/`update-post`, and an Experiment select in the composer).
- **`measure-experiments`** (daily): once every tagged post is published and scored and each arm has `minPerArm` scores, or 21 days after it started, kit `experimentVerdict` on the arms' lifts (compared as ratios to the account's usual level, so a control median of 0 lift still gives a meaningful change). The verdict goes into the program scoreboard (kit `recordVerdict`); a win adds a rule to "Rules we follow", a loss to "Things that did not work", as a pending playbook change. Keep → a new playbook version; discard → logged.
- **Agent tools**: `performance-review` (top/bottom 5 posts with features and lift, kit `featureLifts`, running/proposed experiments, pending changes, hypothesis types ranked by kit `rankHypothesisTypes` UCB), `get-playbook`, `propose-playbook-change`, `decide-playbook-change`, `list-experiments`, `propose-experiment`, `approve-experiment`, `reject-experiment`, `propose-feature-question` (add or retire; at most 12 of its own).
- **Growth tab** (own page and client workspace): stats, what waits for a decision, the playbook (markdown, version history, edit), experiments, UCB ranking, feature lifts, top and bottom posts, feature questions and program settings.

### Upgrading from 0.4.0

- New capability `issues.update` (closing approval issues): approve the upgrade.
- The weekly routine keeps its key `plan-next-week` but is now titled "Weekly social review & plan". The host's routine reconcile never rewrites an existing routine, so companies that already have it keep the old title and description until it is reset (Routines page), or until Re-sync reassigns it from another agent. The procedure the agent follows lives in the `pib-social-content` and `pib-social-publish` skills, which the skill syncer updates automatically.
