# pib-browser

Daemon and CLI for capturing logged-in browser evidence. Not installed by default — requires root installation.

**Important:** This is not a plugin (no manifest). It is a supporting utility for the Paperclip platform.

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

## Build and Test

```sh
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```
