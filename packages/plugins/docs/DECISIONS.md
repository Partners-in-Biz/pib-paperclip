# Decision records (PiB plugins)

Newest first. One entry per decision. Names of secrets only, never values.

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
