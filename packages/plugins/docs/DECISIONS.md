# Decision records (PiB plugins)

Newest first. One entry per decision. Names of secrets only, never values.

## 2026-10-23 D-002 Drive is native: the CRM talks to Google Drive with its own service account (PAR-4676)

**Why:** every Drive save went through the old partnersinbiz-web broker. Its `pib_usr_` token was rejected (401) and its service account was not in the new Shared Drive, so PAR-4676 and every producer save sat waiting on a system we are leaving. Paperclip now owns the connector.

**What changed (CRM 0.28.0, src-only, no migration):** `plugin-crm/src/drive/google-broker.ts` implements the same `Broker` interface against the Drive v3 API with the secret `driveServiceAccountJson` (a Drive-only service account that is a Content manager of the Shared Drive; not the SEO key). Every call sends `supportsAllDrives` and is scoped with `corpora=drive&driveId`. The registry is in Drive itself: folders carry `appProperties` `pibEntityType` / `pibEntityId` and their path in `description`; uploads carry `pibSha256`, so a repeat is a no-op. A same-named untagged folder (made by the old broker) is adopted, not duplicated; a name owned by another entity is a 409. The old web broker client (`driveBrokerUrl` / `driveBrokerToken`) is removed: with no `driveServiceAccountJson` Drive answers `not_configured`, and nothing in the plugins calls partnersinbiz.online any more.

**CRM 0.29.0 follow-up (old broker client deleted):** a folder carries `pibComplete` once its numbered sub-folders all exist, so an interrupted ensure is resumed by the next call instead of being reported as `exists` with an empty tree; a marketing project (whose leaf is registered as a `campaign` folder) now resolves as a project; the creating run is recorded as `pibRun`. Known limit: changing a project's Drive kind after its folder exists does not move the folder (resolve finds the old one); a person moves it.

**Also fixed:** the `drive.save-requested` handler used `projectId: "root"`, which does not exist, so producer saves (SEO, Social, Ads, Campaigns, Billing, Cockpit) could not resolve a folder. It now picks the client's linked project (same kind first, else oldest), and for the company's own work the project in `drive.ownProjectId`. With neither it answers `drive.file.failed` with reason `no_project`.

**One-time grants (Peet):** create a Drive-only service account and JSON key, enable the Drive API on its project, add it to the Shared Drive as Content manager, store the key as the company secret and set `driveServiceAccountJson` (and `drive.ownProjectId`). `drive_binding_status` then shows the service account email and whether it is a member.

## 2026-10-20 D-001 addendum: how agents use the Drive tools (PAR-4067, epic PAR-3887)

Agents call `drive_folder_resolve`, then `drive_folder_ensure` on `not_found`, then `drive_file_save`, and quote the URL (`plugin-crm/src/skills-references.ts`, `references/drive.md` of `pib-crm-records`). The code reads the CRM secret `driveServiceAccountJson` (since D-002; it was `driveBrokerToken`) and the company's `drive.sharedDriveId`; agents never pass a Shared Drive ID. On `drive_not_bound` they report it once and stop. This replaces the board-made `pib-drive-saving` skill (text kept in `docs/archive/pib-drive-saving.md`; rollback = re-attach it). Every company's agents get the new text on the next deploy.

## 2026-10-18 D-001 Drive identity and folder registry for project folders (PAR-3727, plan PAR-3718)

**Decided by Peet (PAR-3718, round 4):** the Drive identity is a service identity with write access to the PIB Shared Drive only, full `drive` scope. The single registry is the partnersinbiz-web `lib/workspace-folders` model plus its Google broker. The cockpit calls it through an authenticated endpoint. A cockpit `drive_links` table is the fallback only if the broker is unreachable from the cockpit worker.

**Spike result (read-only, partnersinbiz-web at its default branch, 18 Oct 2026):**

| Question | Finding | Matches decision? |
|---|---|---|
| OAuth scope | `https://www.googleapis.com/auth/drive` (plus `documents`, `spreadsheets`), `lib/google-workspace/client.ts:3-7`. Full `drive`, not `drive.file`. | Yes |
| Identity | Service account (JWT), no user refresh token. Credentials come from env `GOOGLE_WORKSPACE_CREDS_JSON` (inline JSON) or `GOOGLE_WORKSPACE_CREDS_JSON_PATH` (file path), `client.ts:47-63`. No `subject` is set, so it acts as the service account itself, not as a user (no domain-wide impersonation). | Yes, if that account is a member of the PIB Shared Drive (unverified, see below) |
| Can it see existing Shared Drive folders? | UNVERIFIED. Nothing in the code or docs names the Shared Drive the service account belongs to, and no Shared Drive ID is configured anywhere. With the full `drive` scope it sees exactly what the account is a member of. | Needs Peet to confirm |
| Broker reachable from the cockpit worker? | Yes. From this server, `GET https://partnersinbiz.online/api/v1/workspace-folders` and `/api/v1/agent/workspace-folders` both return HTTP 401 without a credential (reachable, auth required). | Yes: `drive_links` fallback NOT triggered |
| Credential the worker holds | None. No `PIB_WEB_*` or other variable for calling partnersinbiz-web exists in the worker environment or in `packages/plugins`, so an authenticated call (and the scratch folder) could not be made. | Gap |

**Gaps between the current setup and the decision (exact changes needed):**

1. **Worker credential (blocks T0b-1).** Add one bearer credential for the web API to the Paperclip server environment, as `PIB_WEB_BROKER_TOKEN`, readable by the cockpit plugin only. Web accepts `Authorization: Bearer` with a `pib_dlg_` delegation token, a `pib_usr_` personal token, or the static `AI_API_KEY` (lib/api/auth.ts). The folder-create route requires role `admin` (`withAuth('admin')`). Prefer a scoped delegation or personal token over the static `AI_API_KEY`. Holder: Peet issues it (web admin); the Delivery Lead places it in the server environment. Base URL `https://partnersinbiz.online`.
2. **Folder create does not pass `supportsAllDrives` (blocks T0b-2).** `createGoogleResource('create_folder')` in `lib/workspace-os/googleBrokerExecutor.ts:29-60` accepts a parent (`parentFolderId`, `folderId`, `googleFolderId` or `parents`) but does not set `supportsAllDrives: true` on `drive.files.create`; Drive then cannot create inside a Shared Drive. Search (`GET /api/v1/google/drive/search`) already sets `supportsAllDrives` and `includeItemsFromAllDrives`. This is a change in partnersinbiz-web, outside this repo: Peet's call.
3. **Shared Drive pinning (blocks T0b-2).** The web code has no Shared Drive ID setting, and the plan requires parent lookup pinned to the PIB Shared Drive so `01 Personal` can never be a parent. Add a config value for the Shared Drive ID in web (name to be chosen in that change) and make the lookup use `corpora=drive` with it.
4. **Service account membership (needs Peet).** Confirm the service account behind `GOOGLE_WORKSPACE_CREDS_JSON` is a member of the PIB Shared Drive with write access, and of nothing else that includes `01 Personal`.
5. **Two-step create.** `POST /api/v1/workspace-broker/folders/create` only queues a broker job (HTTP 201, or 202 when approval is required, `googleMutationPerformed: false`); `PATCH /api/v1/workspace-broker/jobs/{id}` with `{"action":"execute"}` (admin) performs it. T0b-2 must run both steps and treat the job id as the idempotency key. The registry write (`POST /api/v1/workspace-folders`) follows the execute step.
6. **Lookup by name** over HTTP exists for search only (`/api/v1/google/drive/search?q=&folderId=`); there is no lookup-by-path endpoint, so T0b-2 resolves a path one segment at a time.

**Consequences:** the broker is reachable, so the single-registry decision stands and no `drive_links` table is needed. T0b-1 and T0b-2 stay on the web `workspace-folders` model but depend on gaps 1 to 4. The scratch-folder test (`2026-10-18 Drive spike scratch` under `02 Partners in Biz/Products/`) is NOT done: it needs gap 1 and gap 2. Re-run it once those are closed.

**Rollback:** documentation only. Nothing to undo.
