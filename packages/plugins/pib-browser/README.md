# pib-browser

Daemon and CLI for capturing logged-in browser evidence. Not installed by default — requires root installation.

**Important:** This is not a plugin (no manifest). It is a supporting utility for the Paperclip platform.

## Commands

### Browser Session Control
- `pib-browser open` - Open a browser context
- `pib-browser goto` - Navigate to a URL
- `pib-browser click` - Click an element
- `pib-browser fill` - Fill a form field
- `pib-browser text` - Get text from an element
- `pib-browser shot` - Take a screenshot
- `pib-browser close` - Close the browser context

### Status and Evidence
- `pib-browser probe --all --identities <list>` - Check browser session status for identities, writes `/home/paperclip/pib-tools/browser-status.json`
- `pib-evidence <png-file> --issue PAR-N --step <name>` - Upload a PNG screenshot to an issue as an artifact (step: required, string; returns attachmentId, sha256 of local file and url of the stored artifact; finds the upload script via PIB_UPLOAD_ARTIFACT_SCRIPT, the checkout, or the instance skills store, and names the paths it tried if none exists)

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
| `PIB_BROWSER_STATE_DIR` | `/var/lib/pib-browser` | Directory for approval store state |
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
