# Preview service

Public page for client sign-off links (`https://preview.partnersinbiz.online/p/<token>`; Caddy also still answers `preview.65.108.146.144.sslip.io`). Built by the SEO plugin's `create-preview` tool.

- Code: `server.mjs` and `sweep.mjs` (the cleanup and Chromium helpers, unit-tested in `tests/preview-sweep.spec.ts`), unit `pib-preview.service`, installed at `/home/paperclip/pib-preview/` on the VPS, port 3031 behind Caddy.
- Database role `pib_preview` (SELECT on `previews`, UPDATE of the answer columns only). Its URL is in `/root/pib-ops/preview.env`.
- Caddy block for `preview.partnersinbiz.online` reverse-proxies to 127.0.0.1:3031.
- A client's answer is posted on the task issue by the plugin job `seo-previews` (every 5 minutes).
- Links expire after 30 days.

## Screenshots and Chromium: what is kept, what is deleted

The review page (`/p/<token>/review?key=...`) shows side-by-side screenshots of the live page and the proposal, and measures the rendered text with headless Chromium. The unit runs with `PrivateTmp=true`, so all of this lives in a private `/tmp` that the VPS janitor cannot see and only a restart used to clear (634 MB and 157 screenshots after 14 hours, plus Chromium profile folders).

- **Screenshots** are saved in `/tmp/pib-preview-shots/<token>-<live|proposed>[-m].png` (`SHOTS_DIR`). A screenshot is reused for 55 minutes (the review page links each image more than once). Every call that starts Chromium, and the service at startup, deletes screenshots older than an hour. Only files with that exact name are ever deleted.
- **Chromium profiles**: every run gets a folder of its own, `/tmp/pib-preview-profiles/p-xxxxxx` (`PROFILES_DIR`), used as `--user-data-dir` with `HOME`, `TMPDIR` and the XDG folders pointing into it, so the HTTP cache and crash data go with it. The folder is removed when the run ends, whatever the outcome; one a killed run left behind is swept after an hour. Only `p-xxxxxx` folders directly under that root are ever removed.
- **`--incognito` is required** with `--user-data-dir` on this Chromium (153, `--headless=new`): without it `--screenshot` and `--dump-dom` never finish. Checked on the VPS on 2026-10-03; recheck after a Chromium update (`chromium-1243` in `CHROME_PATH`).
- Steady state: at most about an hour of screenshots (a few MB each) and no profile folders.

## Deploy

This service is deployed separately from the plugin (`dist` and the plugin upgrade do not touch it). Copy `server.mjs` and `sweep.mjs` (both) to `/home/paperclip/pib-preview/` (owner `paperclip`), then `systemctl restart pib-preview`. The restart only drops open requests (a link opens again straight away) and also clears the old private `/tmp`. Check: `systemctl is-active pib-preview`, `curl -s http://127.0.0.1:3031/health` answers `ok`, open one review page and its four images, then `journalctl -u pib-preview -n 20` should show no errors and `ls /tmp/systemd-private-*-pib-preview.service-*/tmp/` only `pib-preview-shots` (no `org.chromium.*`, and `pib-preview-profiles` empty).
