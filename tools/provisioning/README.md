# Provisioning runner (PAR-5161, Hosted clients task 2.5)

`pib-provision-request company ...` provisions one hosted client company with no human step except the owner list. Same pattern as
`deploy-runner.py`. This folder is the source; Peet's Cowork session installs it into pib-ops with `install-provisioning.sh` and proves it
with `install-provisioning.sh --check`. Nothing here edits pib-ops itself.

| File | Goes to |
|---|---|
| `provision-runner.py`, `provision_steps.py`, `provision-policy.json` | `/root/pib-ops/` (an existing policy file is kept; compare by hand) |
| `pib-provision-request` | `/usr/local/bin/` |
| `pib-provision-runner.path` / `.service` | `/etc/systemd/system/` |
| spool | `/var/spool/pib-provision/{incoming 1733, results 755, work 700}` |
| board token | `/etc/pib-provision/board-token` (mode 600, instance admin; the Setup page steps need one) |

## Intake (before any change)

1. Kill switch: `enabled` in the policy, or a file `DISABLED` in the spool.
2. Identity: the run's `PAPERCLIP_API_KEY` against `GET /api/agents/me`; the token is dropped at once and is never written to a result.
   Only agents of the PAR company whose role or title equals an `allowedRequesters` entry (Operator, Account Manager, Operations Manager); the name does not count.
3. The `--issue` exists in PAR and the requester is its assignee. The runner writes on an issue only after steps 2 and 3 pass.
4. A client company needs `--model-key` (the client's own key, task 2.2); the key itself never goes in a request.
5. One open request per CRM company; a CRM company that is already `done` is refused.
6. Capacity gate (Decision 4 on PAR-5152): `maxHostedCompanies` 3 and `maxAgentsTotal` 60, counted over the whole box, PAR included
   (archived companies and terminated agents do not count). A refusal names the limit and the count:
   `refused: maxHostedCompanies 3 reached (current 3)` or `refused: maxAgentsTotal 60 would be exceeded (current 58, request adds 4)`.
   The request counts at least `agentsPerNewCompany` agents, whatever `--agents` says. The values live only in `provision-policy.json`; re-set them from the Task 0.3 measurements after the pilot.

## Steps (first failure fails the request and says which step)

1. create the company (board API; the host picks the prefix; read back)
2. `setup.set-entitlements` when `--plan` or `--modules` is given. It runs on PAR's page (only the operator company may set entitlements; the host overwrites `params.companyId` with the page's company) and names the new company in `targetCompanyId`; `--modules` become a module → `entitled` map
   **Key gate** (between 2 and 3, only with `--model-key`): `GET /api/companies/<id>/secrets/catalog` (names and status only, never a value). It passes only when the new company has a secret named exactly `ANTHROPIC_API_KEY` with status `active`. Missing or inactive: the request ends as `needs_owner` before any agent exists. Any HTTP error (403, 5xx) fails the step with the status code; it is never a pass.
3. `new-company.py --company <prefix> --create-ceo --apply`
4. Setup New company run, headless, with `profile` as a parameter (`setupRunnerCommand`; the board token goes in `PIB_BOARD_TOKEN`).
   **`profile: client` is refused at intake, before anything is created, until `setupProfileWired` is true: it waits on PAR-5157 (task 2.1).**
5. `copy-company-secrets.py --profile client --from <PAR company id> --to <prefix> --apply` (always `--profile client`, `--from` always named; the `internal` profile was removed: a request with `profile: internal` is refused at intake, the PiB dev team is set up by hand) (non-zero: stop; the `--undo` file it names is in the result)
5b. **client-ids** (PAR-5368): `copy-company-secrets.py` relinks secrets but never carries the plain OAuth client IDs, so every OAuth connect in the new company failed with "Add clientId and clientSecret". This step reads each `partnersinbiz.*` plugin's settings for PAR and for the new company (board token, `GET /api/plugins/<id>/config?companyId=`) and copies only Social `platforms.<name>.clientId` and `google.clientId` (Social, Mailbox, SEO) where the new company has none, then reads the settings back. It never overwrites an existing ID, never touches a key with "secret" in its name, and the result note names paths, never values. Idempotent: a resumed request runs it again and finds nothing to copy.
6. wait for the CEO's hires (read only; never comment on or reopen a hire task: it wakes the CEO). The wait is on the company's `Hire:` tasks (plugin origin), polled every 15 s, until all are `done` or `cancelled` in two polls in a row, and then the company must have at least as many live agents as done hire tasks. No hire task after 120 s fails the step (a resumed company that already has 2 or more live agents passes as "already staffed"). At the 900 s deadline the request ends as `needs_owner` (naming the tasks) only if every open task is `blocked`; if any open task is in another state the step fails and lists them all. `--agents` only sets the capacity count; it is not a wait count.
7. `<plugin>.link-agent` for Account Manager, SEO and Social (`linkAgents`)
8. `new-company.py --company <prefix> --apply` (attaches role skills for the agents it recognises)
9. `new-company.py --company <prefix> --model-key-bind --apply` (only with `--model-key`). It re-checks the key secret first (gone: `needs_owner`), and after the bind reads the first `claude_local` agent back and requires `env.ANTHROPIC_API_KEY` to be a `secret_ref`; otherwise the step fails. Only the shape is read, never a value.
10. `new-company.py --company <prefix> --verify` (any WARN or FAIL fails the request), then the runner's own **OAuth client ID check**: in every `partnersinbiz.*` plugin of the new company, a settings object with a `clientSecret` must also have a `clientId`, and every client ID PAR has must be present. The failure lists paths only (e.g. `partnersinbiz.social: platforms.x.clientId is empty but its clientSecret is set`)
11. write `hosted_company_id` on the CRM company record (`crm:update-company`, read back)
8b. **hire-skills** (PAR-5237, after apply): the CEO cannot attach skills (403), so its `Hire:` tasks wait `in_review`; `hires` counts them as hired once their agent exists. This step attaches the skills each task lists (`skills/sync`, add mode), accepts the open skills cards and closes the task.
12. **Owner invite** (PAR-5232, last step): `POST /api/companies/<id>/invites` with exactly `{"allowedJoinTypes": "human", "humanRole": "owner"}` (the body is a constant: role owner of this company only, never instance admin). While `auth.disableSignUp` is true (host patch 12) the client's first person can create an account only through this invite. Then the result comment on the issue with the owner list link and the invite link.
   - **The invite link is a credential** and the host returns its token once. It goes in the result comment only (next to the owner list link). It is never written to the result file, the result message, a log line or an error text (the `pcp_` token pattern is redacted from API error text like any key).
   - **Resume, no duplicate:** the invite id is saved in the result the moment the host answers, and a resumed request carries it. A resumed request with a recorded id makes no new invite: if the invite was accepted the step passes with a note; if it is still active the request ends as `needs_owner` (the link cannot be shown again: revoke it on the Members page, file the same request again, and one fresh invite is made); if it was revoked or expired a fresh one is made. An API error on the POST fails the step with the status code, records no invite, and the next request for the same CRM company resumes at this step only.
   - A finished (`done`) request is final for its CRM company, so filing again never makes a second invite.

Result statuses: `queued`, `running`, `done`, `failed`, `refused` and `needs_owner` (the request stopped until a person acts; the result comment names who and what). A `needs_owner` request is not open: the next request for the same CRM company resumes it like a failed one. A failed request keeps its company. The next request for the same CRM company resumes after the last finished step, and the capacity gate then counts that company once (no extra company, only the agents it does not have yet). Roll back with the
`--undo` file or `new-company.py`, not by filing again with a new name.

Expected time per company: about 1 minute of script time plus about 2 minutes of CEO time for four agents.

## Runbook: the owner enters the key

The runner never carries a model key (not in the command line, the request file, the result or the logs). A client company runs on its own key, so:

1. File the request with `--model-key` (it only says a key is required; it holds no value). The runner creates the company, sets entitlements, then stops at the key gate with status `needs_owner` and the line `owner: add secret ANTHROPIC_API_KEY on the Secrets page of <PREFIX> (Setup, Model key step)`.
2. The owner opens the new company's Secrets page and adds a secret named exactly `ANTHROPIC_API_KEY` with the client's key, and leaves it active.
3. File the same request again (same CRM company). It resumes the same company, reruns the key gate, and goes on from create-ceo. No second company is made.
4. For the live proof, record the HTTP status of the catalog call (a 403 or 5xx fails the step and names the code; the gate's success note says the catalog answered 2xx), and read the first hired `claude_local` agent's `adapterConfig.env.ANTHROPIC_API_KEY` to show a `secret_ref` (never the value).

## Runbook text for `docs/new-company.md` (pib-ops; paste under step 4)

> **Automatic route.** From an Operator or Account Manager run: `pib-provision-request company --name "<name>" --crm-company <crm id> --issue PAR-n --model-key`.
> The runner runs steps 1 to 12 above and comments the result on the issue. Use the manual steps only when the runner is switched off or
> refused. Capacity: at most 3 companies (PAR included) and 60 agents on the box; the limits are in `provision-policy.json`.
> Kill switch: `touch /var/spool/pib-provision/DISABLED`.

## Tests

`python3 -W ignore -m unittest discover -s tools/provisioning/tests` (stdlib only; the API and the server commands are faked).
