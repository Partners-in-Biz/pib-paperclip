# release-note

`post_release_note.py` posts one internal release note per company, as a comment on that company's System health issue (the issue whose `originId` is `cockpit:health:<companyId>`). Cockpit reads the marker on the first line to show the maintenance window. Python 3 standard library only.

It is not plugin code and not a stop-first release. It is installed and wired into the deploy runner by Peet's Cowork session, outside this repo.

## Usage

```sh
python3 tools/release-note/post_release_note.py planned \
  --deploy-id <deploy id> --plugin plugin-billing --version 0.11.0 \
  --sha <commit> --reason migration|capability|both \
  --window-start 2026-10-26T01:00:00Z --window-end 2026-10-26T04:00:00Z \
  --downtime-minutes 5 --companies all|<id,id> [--summary "one line"] [--apply]
```

- First argument is the phase: `planned`, `live` or `cancelled`.
- `--companies` is required. `all` lists every non-archived company and needs a board-level token (an agent token is limited to its own company). A list of ids works with any token that can reach those companies.
- Without `--apply` it is a dry run: it reads (company list, health issue, comments), prints the targets and the exact comment text, and writes nothing.
- Per company: find the health issue by `originId`; no issue = warning and skip (it never creates one and never changes issue status); skip if one of the newest 500 comments already carries the same `id` + `phase`; re-read the issue and refuse unless its `originId` is `cockpit:health:<companyId>`; then post. A failing company does not stop the others.
- Exit codes: `0` all done or skipped, `1` at least one company failed (ids listed on stderr), `2` bad arguments or missing environment.
- Re-running with the same arguments posts nothing.

## Marker contract (poster writes, Cockpit parses)

First line of the comment, then 3-5 plain lines (what changes, when, expected downtime, "no action needed", short sha). Internal only: no client data, no secrets.

```
<!-- pib-release-note v1 {"id":"<deploy id>","phase":"planned|live|cancelled","plugin":"<name>","version":"<x.y.z>","reason":"migration|capability|both","windowStartUtc":"<ISO>","windowEndUtc":"<ISO>","downtimeMinutes":<int>} -->
```

Times are UTC, `YYYY-MM-DDTHH:MM:SSZ`. A reader ignores a marker with an unknown `v` or malformed JSON. `id` + `phase` is the dedup key.

## When the runner calls it

Src-only releases get no note. For a stop-first release (new migration, changed `capabilities` or `coreReadTables`):

| Phase | When | Window |
|---|---|---|
| `planned` | the runner accepts the stop-first request | start = next 01:00 UTC, end = 04:00 UTC |
| `live` | the deploy is reported live | same window as `planned` |
| `cancelled` | refused, aborted or rolled back | same window as `planned` |

Use the same `--deploy-id` for all three so Cockpit can match them.

## Rollback

Remove the three runner calls (`planned`, `live`, `cancelled`). Nothing else depends on the script. Comments already posted stay on the health issues and are harmless.

## Credential

`PAPERCLIP_API_KEY` and `PAPERCLIP_API_URL` come from the environment of the runner host. The script never prints, logs or echoes the key, and strips it from any error text. Only the variable names belong in tickets and PRs.

## Tests

```sh
python3 -m unittest discover tools/release-note
```

HTTP is mocked; no network or credential is needed.
