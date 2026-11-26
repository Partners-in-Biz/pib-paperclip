# pib-browser

Daemon and CLI for capturing logged-in browser evidence. Not installed by default — requires root installation.

**Important:** This is not a plugin (no manifest). It is a supporting utility for the Paperclip platform.

## Commands

### Browser Session Control
- `pib-browser open` - Open a browser context
- `pib-browser goto` - Navigate to a URL
- `pib-browser click` - Click an element
- `pib-browser drag --from SEL --to SEL` - Drag one element onto another. Gated like `click`: the destructive-word check sees both selectors and their labels, and `--approval PAR-N` works the same.
- `pib-browser fill` - Fill a form field
- `pib-browser text` - Get text from an element
- `pib-browser shot` - Take a screenshot
- `pib-browser net [--step NAME]` - Print the session's network log and write it to `<evidence root>/<PAR-n>/<PAR-n>-<step>-<time>.json`. Each entry has time, method, status (0 = request failed or blocked) and a redacted URL. Query values, fragments, credentials and token-like path segments are replaced with `[redacted]`; headers, cookies and bodies are never recorded. The log keeps the last 1000 requests of the session.
- `--viewport WxH` on `open` and `goto` - Set the viewport (e.g. `open --identity pib:paperclip --viewport 390x844`). Allowed 320x320 to 3840x2160; anything else is refused (exit 2). It overrides `PIB_BROWSER_MOBILE`'s size.
- `pib-browser close` - Close the browser context

### Status and Evidence
- `pib-browser probe --all --identities <list>` - Check browser session status for identities, writes `/home/paperclip/pib-tools/browser-status.json`
- `pib-evidence <png-file> --issue PAR-N --step <name>` - Upload a PNG screenshot to an issue as an artifact (step: required, string; returns attachmentId, sha256 of local file and url of the stored artifact; finds the upload script via PIB_UPLOAD_ARTIFACT_SCRIPT, the checkout, or the instance skills store, and names the paths it tried if none exists)

### Person hand-off (log in again by hand)
- `pib-browser handoff-open --identity <id>` - Open a headed Chromium window on display `:99` with the identity's profile, on the site's `loggedIn.url` (a logged-out profile lands on the site's login page). Needs no token or issue: root's flag is the authority. Refused (exit 7 `handoff_not_active`) unless the root-owned flag `/run/pib-browser/handoff/<id>` exists, and refused (exit 2 `handoff_already_open`) while a window for that identity is open.

The window stays open (no `session_expired` close, unlike `open`) and closes by itself when the `loggedIn.expect` text shows (logged in), the flag is removed, the person closes it, or after 30 min (`PIB_BROWSER_HANDOFF_TIMEOUT_MS`). The origin wall still applies, so a site that logs in on another origin needs that origin in `sites.json`. While it is open, an agent `open` on that identity gets exit 3 `handoff_open` (Chromium allows one window per profile); any agent session on the identity is closed when the window opens. No agent verb can reach the window, and the flag no longer lifts the `fill` rules: agents still cannot fill a password field, only the person types it.

Procedure (root part from PAR-9356):

1. On the server: `sudo pib-root browser-handoff-start <id>` makes the flag, starts `pib-vnc` (x11vnc on `:99`, bound to 127.0.0.1:5900, stops after 30 min) and runs `pib-browser handoff-open --identity <id>`.
2. On your computer: `ssh -N -L 5900:localhost:5900 <user>@<server>` and keep it open.
3. Point a VNC client at `localhost:5900` and log in in the window. It closes by itself when you are logged in.
4. On the server: `sudo pib-root browser-handoff-stop <id>` removes the flag (root-owned; only root can) and stops `pib-vnc`.
5. An agent runs `pib-browser probe --all --identities <id> --issue PAR-N`; the login shows ok.

### Live view (PAR-14514)
A second socket, `/run/pib-browser/live.sock` (mode 0660, `PIB_BROWSER_LIVE_SOCKET`), streams display `:99` to Cockpit over a WebSocket, view only. `GET /stream?mode=view` is accepted only with the core server's signed header `x-paperclip-local-ws-signature` (`doc/plugins/PLUGIN_SPEC.md`): it must verify against the key from `PIB_BROWSER_API`/`api/plugins/local-ws-key`, name this socket, the plugin `PIB_BROWSER_LIVE_PLUGIN_KEY` (default `partnersinbiz.cockpit`) and the exact path, be under 30 s old and use a fresh nonce. Any other process on the box, an agent included, gets 401. Each stream runs its own `x11vnc -inetd -viewonly` (no TCP port), handed a socket through a one-use 0700 folder in the private temp folder; at most two streams, 20 minutes each, a ping every 20 s, and `x11vnc` is killed when either side closes or the daemon stops. `GET /status` (unsigned) returns `{viewers, agentSessions, lease, waiting}`. Neither the path, the header nor any stream byte is logged. If the live service cannot start (for example `ws` missing), the agent socket runs as before.

### Take-over (PAR-14514 S4)
A person takes the keyboard and mouse for one identity through the same socket. There is no "start" call: the signed stream is the start.

- `GET /stream?mode=control&identity=<id>` (signed, same check as `mode=view`). With no lease, it starts one for that identity, owned by the signed user id, and opens the hand-off window (as `handoff-open` does; any agent session on the identity is closed first). The same person on the same identity re-attaches (the 5-minute proxy reconnect); the newest stream replaces the old one, so there is one control stream at a time. Anyone else, or another identity, gets `409`. `x11vnc` runs without `-viewonly`, still with `-noclipboard -noprimary`: paste goes in, nothing comes out.
- **Lease**: in memory only, so a daemon restart ends it. At most 20 minutes; ends after 60 s with no control stream, on release, or when the window closes for its own reasons (logged-in text seen, person closed it). Its end closes the window (`ctx.close()` writes the profile) and every control stream. The lease counts inside `handoff.isActive`, next to root's flag, which still works as the break-glass route.
- While a lease is live, and while a release check runs, **every** agent command on every identity gets exit 3 `handoff_open` (`:99` has no window manager, so the person could click into any window).
- `POST /release {"identity":"<id>"}` (unsigned): ends the lease if live, closes the window, then runs the session check (the `open` test: logged-in URL, expected text) and returns `{ok, reason, waiting}` (`reason`: `logged_in`, `session_expired`, ...). It answers the same for a lease that already ended, so it is safe twice. A live lease on another identity is left alone (`take_over_other_identity`). `{"all":true}` also ends any lease and closes every view stream (used when Cockpit's setting goes to `off`).
- `GET /status` `lease`: `null`, `{state:"live", identity, userId, secondsLeft, controlConnected}`, or `{state:"ended", confirmed:false, identity, userId, reason, endedAt}` until a release answers for it.
- **Waiting list**: every `session_expired` or `handoff_open` answer to an agent (after its token and issue are checked) records identity, issue and time in `$PIB_BROWSER_STATE_DIR/waiting.json` (mode 0600, one entry per identity and issue, kept 7 days). `POST /waiting/clear {"identity":"<id>","issues":["PAR-1"]}` removes entries. Cockpit's "Done" wakes these tasks.
- Logged: take-over started/ended with the reason, control opened/closed, release result. Never the identity's user, the path, the header or any typed byte.

## Exit Codes

| Code | Meaning |
|------|---------|
| 0    | Success — evidence captured |
| 2    | Usage error |
| 3    | Browser not found or not available |
| 4    | Expected data missing |
| 5    | Screenshot capture failed |
| 6    | Browser session expired |
| 7    | Refused by policy |
| 8    | Approval required |

## Sessions, write clicks and errors

- A session opened with `open` stays open until `close`, an origin-wall or policy refusal (exit 7), or a dead browser (`browser_closed`). A missing or ambiguous click target, a slow page or a write click without approval leaves it open.
- `click` needs `--approval` when the selector, the `--text` filter or the target element's own label (aria-label, title, value or visible text) contains a word from the site's `destructive.text` list (for Paperclip: save, create, assign, close and so on). `button:has-text(Save)` without `--approval` returns exit 8 `needs_approval` and nothing is clicked.
- Error reasons name the cause: `browser_launch_failed`, `browser_closed` (exit 3); `timeout`, `target_ambiguous` (exit 4); anything else is `internal: <ErrorName>`.
- The daemon writes one JSON line per failure to `/run/pib-browser/errors.log` (readable by the `paperclip` group; `PIB_BROWSER_ERROR_LOG` overrides). Each line has the time, command, issue, identity, phase, error name, the first message line and up to ten stack frames. Tokens, query strings, fill values and page content are never logged. `/run` is cleared when the service restarts; the previous file rotates to `errors.log.1` at 1 MB.

  `tail -n 5 /run/pib-browser/errors.log | jq .`

## Policy and Credentials

- Policy file lives at `/root/pib-ops/browser-policy.json` and is never committed to this repository
- No secrets or credentials are stored in this package
- All sensitive data is managed externally

## Service environment

The daemon reads the following environment variables at startup:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PIB_BROWSER_POLICY` | (required) | Path to policy JSON file |
| `PIB_BROWSER_SITES` | (optional) | Path to sites JSON file |
| `PIB_BROWSER_PROFILES` | `/var/lib/pib-browser/profiles` | Directory for browser profiles |
| `PIB_BROWSER_STATE_DIR` | `/var/lib/pib-browser` | Directory for approval store state and the take-over waiting list (`waiting.json`) |
| `PIB_BROWSER_HANDOFF_DIR` | `/run/pib-browser/handoff` | Directory for handoff state |
| `PIB_BROWSER_SOCKET` | (required) | Unix socket path for daemon |
| `PIB_BROWSER_SOCKET_MODE` | `0o660` | Socket file permissions (octal) |
| `PIB_BROWSER_ERROR_LOG` | `/run/pib-browser/errors.log` | Agent-readable error log (JSON lines, no secrets or page content) |
| `PIB_BROWSER_CHROMIUM` | (unset) | Explicit path to Chromium executable |
| `PIB_BROWSER_HEADLESS` | `0` | `0` for headed (default), `1` for headless |
| `PIB_BROWSER_FAKE_MIC` | unset | `1` launches Chromium with a fake microphone (beep tone, not speech) and grants mic permission. For voice/Talk checks. |
| `PIB_BROWSER_MOBILE` | unset | `1` uses a 390x844 touch viewport with an iPhone user agent. |
| `DISPLAY` | `:99` | X server display for headed mode (typically set by systemd service to `:99` via Xvfb) |

## Build and Test

```sh
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```
