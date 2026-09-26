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
- Wiring a linked agent (`wireAgent`): merges a `tools:use` grant for plugin tools (Social + CRM), reconciles the Social project and assigns the weekly "Plan next week's social" routine to it (an existing routine owned by another agent is reassigned and keeps its status; the Monday trigger stays off until enabled). Failed-post issues go to the linked agent from then on.
- **Re-sync** (`social.activate-agent`) wires the linked agent again. Agents activated before 0.4.0 (host-managed from the manifest `agents` declaration) are still found through `ctx.agents.managed.get` and keep working.
- Actions (people only): `social.hire-options`, `social.start-hire`, `social.link-agent` `{ agentId }`, `social.unlink-agent`, `social.activate-agent`. The link lives in plugin state (`pib-hire` / `role:social-media-manager`, company scope).

## How it works

- OAuth returns to a static bridge page (`dist/ui/oauth-callback.html`) that posts the code to `POST /api/plugins/partnersinbiz.social/api/oauth/complete` with the board session.
- Tokens are sealed with AES-256-GCM (kit `sealJson`) under the configured key; a missing key fails closed.
- Jobs: `publish-due` (5 min, retries 1/5/15/60 min, 5 attempts), `refresh-tokens` (hourly), `collect-metrics` (30 min), `poll-inbox` and `poll-rss` (15 min). Every job takes company ids from its own rows and passes them explicitly.
- One post targets many accounts. Organisation posts cannot use a personal account. A person approves before a post can be scheduled.
