# PiB Connector (WordPress plugin)

A small WordPress plugin, installed once per client site, that lets Paperclip
(`partnersinbiz.crm`) make a fixed list of signed SEO and maintenance changes:
SEO fields (Yoast, Rank Math, or its own output) for posts, pages, the home page,
categories/tags/product categories and post type archives (incl. the social share
image), JSON-LD schema, redirects, robots.txt extra lines, sitemap settings, Media
Library images and alt text, page and post copy (edits, new drafts), site verification (meta
tags and the IndexNow / Google HTML / Bing root files, served without writing to disk), updating the
Connector itself and — only when switched on — plugin install and rollback. Every
write is logged with its before and after state and can be undone (uploads and
self updates excepted: those are additive / have `self/rollback`).

The wire contract is [`PROTOCOL.md`](./PROTOCOL.md). The TypeScript client in the
CRM plugin is written against it.

## Layout

```
pib-wp-connector/
  PROTOCOL.md             the contract (v1, extended in 1.1.0 and 1.2.0)
  build.mjs               builds dist/pib-connector.zip (pure Node, no deps)
  package.json
  pib-connector/          the WordPress plugin folder (zip top folder)
    pib-connector.php     bootstrap, PIB_CONNECTOR_VERSION
    uninstall.php         removes key + settings; keeps log, backups and SEO data
    readme.txt
    includes/             auth, router, settings, log, undo, target, seo, seo-list,
                          schema, redirects, robots, sitemap, verify, plugins,
                          media, content, selfupdate, health, admin
    mu-loader/            pib-connector-loader.php (inert here; copy to mu-plugins)
  tests/                  PHP test harness with WordPress stubs + node signer
```

## Install (wp-admin)

1. In Paperclip: CRM → the client → Websites → add the site → **Connect WordPress**.
   Copy the key (`pibc_…`, shown once) and download `pib-connector.zip`.
2. In wp-admin: Plugins → Add New → Upload Plugin → `pib-connector.zip` → Activate.
3. Settings → PiB Connector → paste the key → Save. The page shows the key id
   (first 12 hex of `sha256(key)`); Paperclip shows the same id when the keys match.
4. Paperclip calls `ping`. A correct signature means the site is connected.

## Pairing by SFTP (no wp-admin)

1. Upload the `pib-connector/` folder to `wp-content/plugins/pib-connector/`.
2. Write `wp-content/pib-connector-key.php` containing exactly:
   ```php
   <?php return 'pibc_...';
   ```
   (a web request to it prints nothing; the plugin never echoes it).
3. Activate the plugin. Activation still needs wp-admin — **or** copy
   `wp-content/plugins/pib-connector/mu-loader/pib-connector-loader.php` to
   `wp-content/mu-plugins/pib-connector-loader.php`; must-use plugins load without
   activation. Nothing in the Connector depends on activation hooks.

Key resolution: the option `pib_connector_key` (saved in Settings) wins; otherwise
the key file. The settings page shows the key source ("settings" / "key file").

## Security model

- **Signed requests only.** Every endpoint is `POST /wp-json/pib-connector/v1/<endpoint>`
  with `X-PIB-Key-Id`, `X-PIB-Timestamp`, `X-PIB-Nonce`, `X-PIB-Signature`
  (hex HMAC-SHA256 over `ts\nnonce\nPOST\n/pib-connector/v1/<endpoint>\nsha256(body)`).
  Compared with `hash_equals`; ±300 s clock window; nonces remembered for 600 s
  (transients) so a request cannot be replayed. The route in the signed string is
  the registered endpoint, not anything taken from the request URL.
- **Key storage.** Option `pib_connector_key` with autoload off (or the key file).
  The admin page never re-displays the key, only its key id.
- **Feature switches.** `seo`, `schema`, `redirects`, `robots`, `sitemap`, `media`,
  `content`, `selfupdate`, `verify` default on; `plugins` defaults **off** and can only be
  switched on by a person in wp-admin. Settings saved by an older version get the
  defaults for features they do not mention. Auth is checked before the feature
  switch, so unauthenticated callers learn nothing.
- **No arbitrary code or SQL.** No `eval`, no `$wpdb`; everything goes through the
  options and post meta APIs. No caller-supplied file paths: backups are addressed
  by a strictly validated id; the key file path is fixed.
- **Strict validation.** Typed JSON body (object only, ≤ 256 KB); URLs must be this
  site or http(s); redirects refuse loops and protocol-relative targets; schema
  pieces are ≤ 20 KB, may not contain `<script` or `<!--`, and are printed with
  `JSON_HEX_TAG`; robots extra lines may not block everything for `User-agent: *`;
  `blog_public` is only ever set to `1`.
- **Plugins feature.** https-only download via `download_url()` (WordPress's safe
  HTTP), sha256 checked with `hash_equals`, every zip entry must sit under
  `<slug>/` (no `..`), never touches the Connector itself, backs up the current
  folder to `wp-content/pib-connector-backups/` (`.htaccess` deny + `index.php`)
  before overwriting, and keeps the active state. It never deletes plugins.
- **Media feature (1.1.0).** `imageUrl` must be https (WordPress's safe HTTP
  API blocks private addresses); the download is capped at 10 MB and accepted only
  when its **real** MIME type (not the extension) is jpeg, png, webp, gif or avif
  (SVG and everything else refused); the stored file name is rebuilt from a
  sanitised stem plus the extension for the real type. The source URL is kept in
  attachment meta so the same URL is never imported twice. Uploads are additive:
  the Connector never deletes an attachment. Alt text is plain text, ≤ 300 chars.
- **Content feature (1.1.0).** Edits only existing posts/pages and creates
  **drafts** (`_pib_created_by_connector`); only those drafts can be published by
  the Connector, and undoing a create moves the draft to the trash (never deletes).
  Author, status (except that publish), and password are never touched. New content
  is refused (`pib_unsafe`) if it contains `<script`, `<iframe`, `<object`, `<embed`,
  `<form`, `javascript:` URLs or `on…=` attributes, unless the very same text is
  already in the post (so existing embeds survive an edit); the check also runs on
  the entity-decoded text and fails closed if a regex errors. Before each write the
  old title/content/excerpt/slug are saved in post meta (last 5 per post, ≤ 500 KB
  each); `undo` restores from that copy and the log keeps only a digest of the
  text. Because a Connector request has no logged-in user, WordPress's kses
  filters would silently strip embeds on save; the write therefore runs with kses
  switched off (the safety check above is the gate) and switches it back on.
- **Verify feature (1.2.0).** Only fixed shapes: nine verification meta names with a 1 to 200
  character `[A-Za-z0-9._:=+/-]` value (printed with `esc_attr` on `wp_head`), and three file kinds
  (IndexNow `<key>.txt`, Google `google<hex>.html`, `BingSiteAuth.xml`) whose content must match what
  that file legitimately holds. Nothing is ever written to disk: the Connector answers the request
  itself on `parse_request` (GET/HEAD, exact path, no percent-decoding), so a read-only web root is
  fine, undo needs no cleanup, and a real file on disk still wins (`diskConflicts`). The stored
  lists are re-validated on every request. Off means nothing is printed or served.
- **Self update (1.1.0).** `self/update` only accepts an https zip from an
  allow-listed host (`paperclip.partnersinbiz.online`; extend in code with the
  `pib_connector_update_hosts` filter — exact host, port 443, no credentials),
  checks sha256 with `hash_equals`, requires every entry under `pib-connector/`
  (no `..`, ≤ 300 entries, ≤ 8 MB unpacked) with a `pib-connector.php` whose
  `Plugin Name` is PiB Connector and whose `Version` is **higher** than the running
  one. It backs the current folder up to
  `wp-content/pib-connector-backups/pib-connector-<version>-<UTC>.zip`, installs with
  `Plugin_Upgrader`, and if that fails (or installs a different version than the zip
  announced, or the site stops answering after the swap) restores the backup at once
  (Plugin_Upgrader, then `unzip_file`). Zips whose PHP files do not parse are refused
  before install (`token_get_all` with `TOKEN_PARSE`); after install one unsigned loopback
  request to the Connector's own route detects a fatal error in the new code.
  Only runs when the Connector lives at `wp-content/plugins/pib-connector`.
- **Admin screen.** `manage_options`, nonce on the form (`check_admin_referer`),
  all output escaped.
- **Live-site rule.** Deactivate, never delete. Uninstall removes only the key and
  settings; the log, backups and the site's SEO data stay.

## Build

```sh
node build.mjs            # or: pnpm --filter @partnersinbiz/pib-wp-connector build
```

Writes `dist/pib-connector.zip` (top folder `pib-connector/`) and prints its sha256.
The zip is deterministic (sorted entries, fixed timestamp). From other scripts:

```js
import { buildConnectorZip } from './build.mjs';
const { path, sha256, bytes } = await buildConnectorZip('/some/out/pib-connector.zip');
```

## Tests

PHP is not needed on the Mac. On any machine with PHP CLI (7.4+):

```sh
php tests/run.php          # exits non-zero on failure
```

`tests/bootstrap.php` stubs the WordPress functions the Connector uses; tests cover
signatures (fixed vector, bad sig, stale, replay, wrong key id, not paired, key file),
feature switches, SEO round trips for yoast/rankmath/none (noindex mapping, home
target, undo), schema set/remove and the `wpseo_schema_graph` output, redirects
(normalisation, loops, 410), robots (unsafe `Disallow: /`, never `blog_public=0`),
sitemap filters, plugin input validation and the 200-entry log cap. 1.1.0 adds
term/archive targets and `ogImage` on all three adapters, the WooCommerce shop
mirror, `seo/list`, media (list, sideload with reuse, image type/size refusals,
set-featured, alt), content (get, images, img-alt, update, create, publish, unsafe
content, existing embeds, backup rotation, undo), self update/rollback (host,
sha, downgrade, foreign entries, automatic restore), feature defaults and the admin
checkboxes. 1.2.0 adds `tests/test-verify.php`: verify round trips, replace semantics, every
rule refusal, the feature switch, undo, serving (match, no match, HEAD, trailing slash, query
string, wrong method, sub-directory sites), escaped meta output and disk conflicts.

The stub tests are not enough on their own (they missed real bugs in 1.1.0), so 1.2.0 was also run on
a throwaway WordPress 7.1.2 + Yoast SEO 28.6 + Disable Gutenberg (scratch MariaDB on a unix socket,
PHP built-in server behind an nginx-style `try_files` router, `%postname%` permalinks): meta tags in
the home and inner page `<head>` ahead of Yoast, the three files with correct bodies, content
types and headers for GET and HEAD, 404 for everything else, refusals, undo, feature switch, a
disk conflict, plain permalinks, and a `self/update` from a real 1.1.0 install to 1.2.0 followed by
`verify/*` without re-pairing.

`tests/sign.mjs` signs requests with `node:crypto`; `node tests/sign.mjs --vector`
prints the fixed vector that `tests/test-auth.php` checks, so PHP and TypeScript
agree byte for byte:

| field | value |
|---|---|
| key | `pibc_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8` |
| keyId | `ff6dfdf7cd7d` |
| ts | `1767225600` |
| nonce | `0123456789abcdef0123456789abcdef` |
| route | `/pib-connector/v1/seo/get` |
| body | `{"url":"/about/"}` |
| sha256(body) | `e08de92cef1c88fbb5768b4075a9c9c62cc10ee543ab1f23b81f2ed974a4131f` |
| signature | `55fae793f35512198dec6aaf9cefe0f85f84df3295739891c2ac8c7b374fc723` |
