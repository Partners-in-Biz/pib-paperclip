# Preview service

Public page for client sign-off links (`https://preview.partnersinbiz.online/p/<token>`; Caddy also still answers `preview.65.108.146.144.sslip.io`). Built by the SEO plugin's `create-preview` tool.

- Code: `server.mjs`, `sweep.mjs` (the cleanup, Chromium and address-check helpers, `tests/preview-sweep.spec.ts`), `egress.mjs` (the egress proxy, `tests/preview-egress.spec.ts`) `render.mjs` (`/render`, the review page's figure and `wordsOf`, the word counter shared with the plugin's `visibleWords`, `tests/preview-render.spec.ts` and `tests/preview-volatile.spec.ts`) and `decision.mjs` (the client's answer SQL, `tests/preview-declined.spec.ts`), unit `pib-preview.service`, installed at `/home/paperclip/pib-preview/` on the VPS, port 3031 behind Caddy.
- Database role `pib_preview` (SELECT on `previews`, UPDATE of the answer columns only). Its URL is in `/root/pib-ops/preview.env`.
- Caddy block for `preview.partnersinbiz.online` reverse-proxies to 127.0.0.1:3031.
- A client's answer is posted on the task issue by the plugin job `seo-previews` (every 5 minutes).
- One answer per link (plugin-seo 0.37.0, PAR-9131): only a `pending` preview takes an answer, and it is stored with `decision_source = 'email'` and `decided_by = 'client:email-link'`. A second answer gets 409 "This preview has already been answered. To change it, reply to the email." A declined preview's link shows "This proposal is not going ahead."

### Before the 0.37.0 server goes live

In this order: plugin-seo 0.37.0 (migration 026) is installed and `previews.decision_source` exists; then, as the database owner, `GRANT USAGE ON SCHEMA plugin_seo_8099f8879a TO pib_preview; GRANT SELECT ON plugin_seo_8099f8879a.previews TO pib_preview; GRANT UPDATE (status, decision_note, decided_at, notified_at, decision_source, decided_by, stats) ON plugin_seo_8099f8879a.previews TO pib_preview;` (without UPDATE on all of those columns every client Approve or Request changes answer fails with a 500; a plugin migration cannot do this, the host rejects GRANT and DO blocks); then copy the files and restart as below. Rollback: copy the previous `server.mjs` back and restart (it does not use `decision.mjs`; the grant can stay).
- Links expire after 30 days.

## Screenshots and Chromium: what is kept, what is deleted

The review page (`/p/<token>/review?key=...`) shows side-by-side screenshots of the live page and the proposal, and measures the rendered text with headless Chromium. The unit runs with `PrivateTmp=true`, so all of this lives in a private `/tmp` that the VPS janitor cannot see and only a restart used to clear (634 MB and 157 screenshots after 14 hours, plus Chromium profile folders).

- **Screenshots** are saved in `/tmp/pib-preview-shots/<token>-<live|proposed>[-m].png` (`SHOTS_DIR`). A screenshot is reused for 55 minutes (the review page links each image more than once). Every call that starts Chromium, and the service at startup, deletes screenshots older than an hour. Only files with that exact name are ever deleted.
- **Chromium profiles**: every run gets a folder of its own, `/tmp/pib-preview-profiles/p-xxxxxx` (`PROFILES_DIR`), used as `--user-data-dir` with `HOME`, `TMPDIR` and the XDG folders pointing into it, so the HTTP cache and crash data go with it. The folder is removed when the run ends, whatever the outcome; one a killed run left behind is swept after an hour. Only `p-xxxxxx` folders directly under that root are ever removed.
- **`--incognito` is required** with `--user-data-dir` on this Chromium (153, `--headless=new`): without it `--screenshot` and `--dump-dom` never finish. Checked on the VPS on 2026-10-03; recheck after a Chromium update. The binary is the newest `chromium-<build>` under `~/.cache/ms-playwright` (looked up on each run; `CHROME_PATH` pins one). Before PAR-4798 the build folder was fixed in the code, Playwright removed it, and every `/shot` answered 502 while `/health` stayed ok.
- Steady state: at most about an hour of screenshots (a few MB each) and no profile folders.

## Render endpoint (PAR-8799)

`create-preview` (SEO plugin 0.32.1+) asks `POST http://127.0.0.1:3033/render` with `{"url": "..."}` for the live page's DOM after its scripts ran (1280 px), and stores one kept-text figure from it. The port is fixed in `render.mjs` (no env var) and is on a second listener in the same process: **127.0.0.1 only, never 3031, never in Caddy**. 3032 is taken by the Social approval service (`pib-approval.service`).

- Answers: 200 `{html}`; 400 refused URL (`checkRenderUrl`: http/https, port 80/443, no user name, every address public) or bad body; 413 body over 8 KiB or rendered page over 10 MiB; 503 a render is already running (one slot of its own, not the screenshot queue); 504 over 14 s; 500 Chromium failed. Errors are `{error}`.
- Chromium runs with `renderArgs`: every connection goes through the egress proxy (`egress.mjs`, 127.0.0.1, ephemeral port, started with the service), which refuses non-public addresses, so an iframe, image or `fetch()` to 3031, 3032, 169.254.169.254 or a private range gets nothing. Logged as `egress ... refused`.
- Kill path: Chromium starts in its own process group; on timeout, the 10 MiB cap, the caller hanging up or shutdown the whole group gets SIGKILL, and the profile folder is removed only after it exited.
- Review page: one figure (`stats.rendered`); rows made from the source (`stats.basis` not `rendered`) add "Made from the page source: header and scripted parts may differ." A row without `stats.rendered.liveWords > 0` is measured on the first open, as before.

## Deploy

This service is deployed separately from the plugin (`dist` and the plugin upgrade do not touch it). Copy `server.mjs`, `sweep.mjs`, `egress.mjs`, `render.mjs` and `decision.mjs` (all five) to `/home/paperclip/pib-preview/` (owner `paperclip`), then `systemctl restart pib-preview`. The restart only drops open requests (a link opens again straight away) and also clears the old private `/tmp`. Check: `systemctl is-active pib-preview`, `curl -s http://127.0.0.1:3031/health` answers `ok`, `ss -ltnp | grep -E ':3033|node'` shows 3033 and the proxy port on 127.0.0.1 only, `curl -s 127.0.0.1:3033/render -H 'content-type: application/json' -d '{"url":"https://huntandgun.co.za/about-us/"}' | jq -r .html | grep -c et_pb_menu` is above 0 and the same with `http://127.0.0.1:3031/health` answers 400, open one review page and its four images, then `journalctl -u pib-preview -n 20` should show no errors and `ls /tmp/systemd-private-*-pib-preview.service-*/tmp/` only `pib-preview-shots` (no `org.chromium.*`, and `pib-preview-profiles` empty).
