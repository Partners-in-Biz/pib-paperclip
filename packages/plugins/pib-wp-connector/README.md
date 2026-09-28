# PiB Connector (WordPress plugin)

A small WordPress plugin, installed once per client site, that lets Paperclip
(`partnersinbiz.crm`) make a fixed list of signed SEO and maintenance changes:
SEO fields (Yoast, Rank Math, or its own output), JSON-LD schema, redirects,
robots.txt extra lines, sitemap settings and — only when switched on — plugin
install and rollback. Every write is logged with its before and after state and
can be undone.

The wire contract is [`PROTOCOL.md`](./PROTOCOL.md). The TypeScript client in the
CRM plugin is written against it.

## Layout

```
pib-wp-connector/
  PROTOCOL.md             the contract (v1)
  build.mjs               builds dist/pib-connector.zip (pure Node, no deps)
  package.json
  pib-connector/          the WordPress plugin folder (zip top folder)
    pib-connector.php     bootstrap, PIB_CONNECTOR_VERSION
    uninstall.php         removes key + settings; keeps log, backups and SEO data
    readme.txt
    includes/             auth, router, settings, log, undo, target, seo, schema,
                          redirects, robots, sitemap, plugins, health, admin
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
- **Feature switches.** `seo`, `schema`, `redirects`, `robots`, `sitemap` default on;
  `plugins` defaults **off** and can only be switched on by a person in wp-admin.
  Auth is checked before the feature switch, so unauthenticated callers learn nothing.
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
sitemap filters, plugin input validation and the 200-entry log cap.

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
