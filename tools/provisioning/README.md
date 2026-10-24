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
   Only agents of the PAR company whose role or title equals an `allowedRequesters` entry (Operator, Account Manager); the name does not count.
3. The `--issue` exists in PAR and the requester is its assignee. The runner writes on an issue only after steps 2 and 3 pass.
4. A client company needs `--model-key` (the client's own key, task 2.2); the key itself never goes in a request.
5. One open request per CRM company; a CRM company that is already `done` is refused.
6. Capacity gate (Decision 4 on PAR-5152): `maxHostedCompanies` 3 and `maxAgentsTotal` 60, counted over the whole box, PAR included
   (archived companies and terminated agents do not count). A refusal names the limit and the count:
   `refused: maxHostedCompanies 3 reached (current 3)` or `refused: maxAgentsTotal 60 would be exceeded (current 58, request adds 4)`.
   The request counts at least `agentsPerNewCompany` agents, whatever `--agents` says. The values live only in `provision-policy.json`; re-set them from the Task 0.3 measurements after the pilot.

## Steps (first failure fails the request and says which step)

1. create the company (board API; the host picks the prefix; read back)
2. `setup.set-entitlements` when `--plan` or `--modules` is given
3. `new-company.py --company <prefix> --create-ceo --apply`
4. Setup New company run, headless, with `profile` as a parameter (`setupRunnerCommand`; the board token goes in `PIB_BOARD_TOKEN`).
   **`profile: client` is refused at intake, before anything is created, until `setupProfileWired` is true: it waits on PAR-5157 (task 2.1).**
5. `copy-company-secrets.py --profile client --to <prefix> --apply` (non-zero: stop; the `--undo` file it names is in the result)
6. wait for the CEO's hires (read only; never comment on or reopen a hire task: it wakes the CEO)
7. `<plugin>.link-agent` for Account Manager, SEO and Social (`linkAgents`)
8. `new-company.py --company <prefix> --apply` (attaches role skills for the agents it recognises)
9. `new-company.py --company <prefix> --model-key-bind --apply` (only with `--model-key`)
10. `new-company.py --company <prefix> --verify` (any WARN or FAIL fails the request)
11. write `hosted_company_id` on the CRM company record (`crm:update-company`, read back), then the result comment on the issue with the owner list link

A failed request keeps its company. The next request for the same CRM company resumes after the last finished step. Roll back with the
`--undo` file or `new-company.py`, not by filing again with a new name.

Expected time per company: about 1 minute of script time plus about 2 minutes of CEO time for four agents.

## Runbook text for `docs/new-company.md` (pib-ops; paste under step 4)

> **Automatic route.** From an Operator or Account Manager run: `pib-provision-request company --name "<name>" --crm-company <crm id> --issue PAR-n --model-key`.
> The runner runs steps 1 to 10 above and comments the result on the issue. Use the manual steps only when the runner is switched off or
> refused. Capacity: at most 3 companies (PAR included) and 60 agents on the box; the limits are in `provision-policy.json`.
> Kill switch: `touch /var/spool/pib-provision/DISABLED`.

## Tests

`python3 -W ignore -m unittest discover -s tools/provisioning/tests` (stdlib only; the API and the server commands are faked).
