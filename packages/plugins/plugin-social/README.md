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
4. Social page → Overview → **Activate agent**, then Resume the "Social Media Manager" agent.

## How it works

- OAuth returns to a static bridge page (`dist/ui/oauth-callback.html`) that posts the code to `POST /api/plugins/partnersinbiz.social/api/oauth/complete` with the board session.
- Tokens are sealed with AES-256-GCM (kit `sealJson`) under the configured key; a missing key fails closed.
- Jobs: `publish-due` (5 min, retries 1/5/15/60 min, 5 attempts), `refresh-tokens` (hourly), `collect-metrics` (30 min), `poll-inbox` and `poll-rss` (15 min). Every job takes company ids from its own rows and passes them explicitly.
- One post targets many accounts. Organisation posts cannot use a personal account. A person approves before a post can be scheduled.
