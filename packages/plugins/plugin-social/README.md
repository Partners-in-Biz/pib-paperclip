# Social

Paperclip plugin `partnersinbiz.social`: connect client social accounts, draft posts with media and per-platform overrides, approve them, and publish on schedule with retries.

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
