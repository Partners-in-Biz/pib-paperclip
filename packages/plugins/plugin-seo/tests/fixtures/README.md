# plugin-seo test fixtures

## huntandgun-hunting.html (PAR-10107)

Trimmed from the live source of https://huntandgun.co.za/hunting-in-south-africa/ (`curl -A Mozilla`, 12 Nov 2026).
Kept, in the live order: the theme wrappers, `div.entry-content`, the pasted `<style>` (only its `body`, `p`,
`.containerSet` and `h1, h2` rules), the stray `<body data-rsssl=1>`, `div.containerSet` with its first and last
`<section>`, the auction categories `<h1>` and list (two links), the trailing `<style>`, the entry-content close and the
theme `<footer>`. Removed: every script, the header menu, the search box, the auction lot cards, the social links and the
account dialog. No personal data.

## huntandgun-hunting-rendered.html (PAR-10107)

Made by Chromium from the source fixture, not by hand. Same flags as `domArgs` in `ops/preview-server/sweep.mjs`
(Playwright's Chromium build 1248, Chrome for Testing 156.0.8078.4). From this folder:

```sh
P=$(mktemp -d)
~/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome --headless=new --no-sandbox --disable-gpu --no-first-run \
  --incognito --user-data-dir="$P" --window-size=1280,3200 --virtual-time-budget=9000 --timeout=9000 \
  --dump-dom "file://$PWD/huntandgun-hunting.html" > huntandgun-hunting-rendered.html
rm -rf "$P"
```

## builders/ (PAR-10107)

`cases.ts` holds small page-builder and plain WordPress pages; `expected.json` is what `buildPreviewHtml` built for them
on development before the card-aware insertion point (the answer bar left out). `tests/preview-builders.spec.ts` checks
the output is still byte-identical. Regenerate only on purpose:
`UPDATE_BUILDER_EXPECTED=1 npx vitest run tests/preview-builders.spec.ts`.

## faq.html

FAQ page used by the confirm-facts tests.
