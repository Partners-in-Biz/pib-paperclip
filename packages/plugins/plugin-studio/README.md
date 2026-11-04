# Studio

Creative assets and image and video generation for people and agents. Replaces the old site's studios, in phases. Design: wiki `studio-program-2026-11`.

## Phase 1 (this version)

- **Assets:** private storage in R2 (`studio/<companyId>/<own|client>/<assetId>/v<n>.<ext>`), linked to a client, project, issue and more.
- **Generation:** priced, checked against the cap, reserved, then a one-minute job submits, polls and saves the file. Every batch unit is charged separately.
- **Caps:** per company per calendar month (UTC), with an optional client cap. A company owner sets them on the Studio page, and they apply to the next generation. No cap anywhere means generation is off.
- **Agents:** `studio-usage`, `studio-estimate`, `studio-generate`, `studio-generation-status`, `studio-list-assets`, `studio-get-asset`, `studio-import-from-attachment`, `studio-link-asset`. Agents get file paths, never signed links.

Not here yet: review, export to Social, the generate form and Photo Studio (Phase 2), the canvas (Phase 3), hosted-client entitlement and the hosted cap ceiling (Phase 4).

## Settings

Per company, in the plugin's settings:

- `r2.accountId`, `r2.bucket`, `r2.accessKeyId`, `r2.secretAccessKey`: the private bucket, and the same token as Mailbox and Billing. The `studio/` folder is fixed in code, not a setting.
- `higgsfield.apiKey`: a secret reference.

## Installing

First install is stop-first, from `deploy-plugins.sh --first-install studio`. Add `studio` to `ALL_NAMES` and `studio-usage` to the `SMOKE` table first. Then bind the settings above and resync the CRM so Studio learns the clients.
