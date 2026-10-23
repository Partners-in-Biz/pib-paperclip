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
- `pib-evidence <png-file> --issue PAR-N --step <name>` - Upload a PNG screenshot to an issue as an artifact (step: required, string; returns attachmentId and sha256 of local file)

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
| `PIB_BROWSER_CHROMIUM` | (unset) | Explicit path to Chromium executable |
| `PIB_BROWSER_HEADLESS` | `0` | `0` for headed (default), `1` for headless |
| `DISPLAY` | `:99` | X server display for headed mode (typically set by systemd service to `:99` via Xvfb) |

## Build and Test

```sh
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```
