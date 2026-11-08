# Studio

Creative assets and image and video generation for people and agents. Replaces the old site's studios, in phases. Design: wiki `studio-program-2026-11`.

## Phase 1 (this version)

- **Assets:** private storage in R2 (`studio/<companyId>/<own|client>/<assetId>/v<n>.<ext>`), linked to a client, project, issue and more.
- **Generation:** priced, checked against the cap, reserved, then a one-minute job submits, polls and saves the file. Every batch unit is charged separately.
- **Caps:** per company per calendar month (UTC), with an optional client cap. A company owner sets them on the Studio page, and they apply to the next generation. No cap anywhere means generation is off.
- **Agents:** `studio-usage`, `studio-estimate`, `studio-generate`, `studio-generation-status`, `studio-list-assets`, `studio-get-asset`, `studio-import-from-attachment`, `studio-link-asset`. Agents get file paths, never signed links.

Not here yet: review, export to Social, the generate form and Photo Studio (Phase 2), the canvas (Phase 3), hosted-client entitlement and the hosted cap ceiling (Phase 4).

## Canvas share links and briefs (0.1.18)

- **Share link:** an editor makes a view-only link from the canvas toolbar (Share). It is a static page `dist/ui/s/<24 random characters>.html` served by the host to anyone with the link: the board drawn as HTML, no script, no controls. Preview links on it last 10 minutes; the one-minute job rewrites the page every 4 minutes and the page reloads. Links expire after 7 days (1 to 30) and Revoke deletes the page at once. Agents never get a share or a signed link.
- **Agent tool `canvas-create-from-brief`:** a title, prompts (image or video) and optional library asset ids become a new board: prompt cards wired to image/video cards, references as source cards feeding them. It never generates or spends; a person opens the board and presses Generate. Installing grants nobody: grant it to the agents that plan creative work.

## The higgsfield skill

`skills/higgsfield/SKILL.md` is the source of the company library skill `higgsfield` (a `local_path` company skill, not shipped in `dist`). It sends agents to the Studio tools only. Cut-over after merge (a deploy step, not done by the PR): copy it over the company skill's `SKILL.md` and remove the old `hf.py` next to it. `tests/higgsfield-skill.spec.ts` keeps it in step with `src/tools.ts`.

## Settings

Per company, in the plugin's settings:

- `r2.accountId`, `r2.bucket`, `r2.accessKeyId`, `r2.secretAccessKey`: the private bucket, and the same token as Mailbox and Billing. The `studio/` folder is fixed in code, not a setting.
- `higgsfield.apiKey`: a secret reference.

## Host ffmpeg (video editor)

The video engine (`src/video-edit/`) runs the host's ffmpeg; nothing is bundled. The host needs:

- `apt install ffmpeg` at 6.1 or later, built with libass and libfreetype (subtitles and text). Check: `ffmpeg -version` and `ffmpeg -filters | grep -E 'subtitles|drawtext'`.
- `/usr/bin/timeout`, `/usr/bin/prlimit` (util-linux) and `/usr/bin/nice` (coreutils).

Every run is `timeout -k 30 1200 prlimit --as=<6 GiB> --fsize=200 MB -- nice -n 10 ffmpeg -threads 4 ...`, spawned as an args array in its own process group. Cancel kills only that group. Render folders live in `<studio-files>/renders`; a render needs 8 GB free and 4x its input bytes. The `sweep-local-files` job removes folders left behind.

## Installing

First install is stop-first, from `deploy-plugins.sh --first-install studio`. Add `studio` to `ALL_NAMES` and `studio-usage` to the `SMOKE` table first. Then bind the settings above and resync the CRM so Studio learns the clients.
