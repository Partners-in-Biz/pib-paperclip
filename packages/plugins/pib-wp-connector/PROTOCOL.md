# PiB Connector protocol (v1)

The PiB Connector is a WordPress plugin installed once per client site. It lets
Paperclip (the CRM plugin, `partnersinbiz.crm`) make a short, fixed list of SEO
and maintenance changes on the site. Nothing else can use it.

## Pairing

1. On the CRM client page, under Websites, a person adds the site and presses
   **Connect WordPress**. The CRM generates a key: `pibc_` followed by 43
   base64url characters (32 random bytes). The page shows it once.
2. The person installs `pib-connector.zip` (served by the CRM plugin UI) through
   wp-admin → Plugins → Add New → Upload, activates it, and pastes the key under
   Settings → PiB Connector.
3. The CRM calls `ping`. A correct signature means the site is connected.

The key lives in the WordPress option `pib_connector_key` (autoload off) and in the
CRM's own table.

The key may instead come from a file, so an agent with SFTP access can install and
pair the Connector without anyone opening wp-admin. The Connector resolves the key
in this order:

1. the option `pib_connector_key`, if it holds a valid key (a key saved under
   Settings → PiB Connector always wins);
2. otherwise the file `wp-content/pib-connector-key.php`
   (`WP_CONTENT_DIR . '/pib-connector-key.php'`), if it exists and `include`s to a
   string matching `/^pibc_[A-Za-z0-9_-]{43}$/`. Its content is
   `<?php return 'pibc_...';`, so a web request to it prints nothing. The plugin
   ships without this file. It is read at most once per request and never echoed.

The settings page shows the key source ("settings" or "key file") and the key id.

For pairing without wp-admin, the plugin can also be loaded as a must-use plugin:
copy `pib-connector/mu-loader/pib-connector-loader.php` (shipped inside the plugin
folder, inert there) to `wp-content/mu-plugins/`. It `require_once`s
`wp-content/plugins/pib-connector/pib-connector.php`. Nothing essential depends on
activation hooks; option defaults are applied lazily. The **key id** is the first 12 hex characters of
`sha256(key)`. Both sides show it, so a person can see whether the keys match
without seeing the key.

## Requests

Every call is `POST` with a JSON body (`{}` when there are no parameters) to the REST route
`/pib-connector/v1/<endpoint>`:

- `https://<site>/wp-json/pib-connector/v1/<endpoint>`, or
- `https://<site>/?rest_route=/pib-connector/v1/<endpoint>` when pretty permalinks are
  off. The CRM tries `/wp-json/` first and falls back on a 404 that is not JSON.

Headers:

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `X-PIB-Key-Id` | key id (12 hex) |
| `X-PIB-Timestamp` | unix seconds |
| `X-PIB-Nonce` | 32 hex characters, random per request |
| `X-PIB-Signature` | hex HMAC-SHA256 of the string below, keyed with the full key |
| `X-PIB-Actor` | optional; who asked, e.g. `agent:<id>` or `user:<id>` (recorded in the log) |

The string that gets signed is five lines joined with `\n`:

```
<timestamp>
<nonce>
POST
/pib-connector/v1/<endpoint>
<sha256 hex of the raw request body>
```

The Connector rejects a request when:

- no key is set (`pib_not_paired`, 401)
- the key id or signature is wrong (`pib_bad_signature`, 401; compare with `hash_equals`)
- the timestamp is more than 300 s from the server's clock (`pib_stale`, 401)
- the nonce was already seen in the last 600 s (`pib_replay`, 401; stored as a transient)
- the endpoint's feature is switched off in the settings (`pib_disabled`, 403)

## Responses

- Success: HTTP 200 with `{ "ok": true, "data": { ... } }`.
- Error: the normal WordPress REST error `{ "code", "message", "data": { "status" } }`.

## Features (wp-admin → Settings → PiB Connector)

| Feature | Default | Endpoints |
|---|---|---|
| `seo` | on | `seo/get`, `seo/set` |
| `schema` | on | `schema/get`, `schema/set` |
| `redirects` | on | `redirects/list`, `redirects/set`, `redirects/delete` |
| `robots` | on | `robots/get`, `robots/set` |
| `sitemap` | on | `sitemap/get`, `sitemap/set` |
| `plugins` | **off** | `plugins/list`, `plugins/backups`, `plugins/install`, `plugins/rollback` |

`ping`, `health`, `log` and `undo` are always available. `undo` only reverts
changes from a feature that is still on.

## Endpoints

### Target pages

`seo/*` and page-level `schema/*` take `url` (a full or site-relative URL) or
`postId`.

- `url` resolves with `url_to_postid()`.
- The home page resolves to the static front page. If the site shows latest posts
  instead, the target is `home`.
- Anything that doesn't resolve (archives, terms) returns `pib_unsupported_target`
  (422).

### `ping`
→ `{ connector: { version }, site: { url, name }, keyId }`

### `health`
→ `{ connector: { version, features: {seo:true,…} }, wordpress: { version, multisite }, php: { version },
      site: { url, home, name, blogPublic, permalinks, language, timezone },
      theme: { name, version, parent },
      seoPlugin: { key: "yoast"|"rankmath"|"none", version, premium },
      sitemap: { provider: "yoast"|"rankmath"|"core"|"none", url },
      redirectsProvider: "connector"|"yoast-premium"|"redirection"|"rankmath",
      plugins: [ { file, name, version, active, mustUse } ],
      updates: { core, plugins: n, themes: n } }`

### `seo/get` `{ url | postId }`
→ `{ target: { postId|null, type: "post"|"home", url, postType, title },
      seoPlugin, fields: { title, description, canonical, noindex, nofollow, focusKeyword, ogTitle, ogDescription } }`

Each field is the stored override, or `null` when the site falls back to its template.
`noindex` and `nofollow` are `true`, `false` or `null` (null means the default).

### `seo/set` `{ url | postId, title?, description?, canonical?, noindex?, nofollow?, focusKeyword?, ogTitle?, ogDescription?, reason? }`

Only the keys you send change. An empty string or `null` clears the override.
Values are written into the active SEO plugin's own storage:

| Field | Yoast post meta | RankMath post meta | No SEO plugin (Connector's own, printed in `wp_head` / `pre_get_document_title`) |
|---|---|---|---|
| title | `_yoast_wpseo_title` | `rank_math_title` | `_pib_seo_title` |
| description | `_yoast_wpseo_metadesc` | `rank_math_description` | `_pib_seo_description` |
| canonical | `_yoast_wpseo_canonical` | `rank_math_canonical_url` | `_pib_seo_canonical` |
| noindex | `_yoast_wpseo_meta-robots-noindex` (`1` noindex, `2` index, deleted = default) | `rank_math_robots` array contains `noindex` / `index` | `_pib_seo_noindex` |
| nofollow | `_yoast_wpseo_meta-robots-nofollow` (`1`) | `rank_math_robots` contains `nofollow` | `_pib_seo_nofollow` |
| focusKeyword | `_yoast_wpseo_focuskw` | `rank_math_focus_keyword` | `_pib_seo_focus_keyword` |
| ogTitle | `_yoast_wpseo_opengraph-title` | `rank_math_facebook_title` | `_pib_seo_og_title` |
| ogDescription | `_yoast_wpseo_opengraph-description` | `rank_math_facebook_description` | `_pib_seo_og_description` |

For the `home` target with Yoast, the values go in `wpseo_titles`:
`title-home-wpseo`, `metadesc-home-wpseo` and `open_graph_frontpage_*`. With
RankMath they go in `rank-math-options-titles`: `homepage_title` and
`homepage_description`.

After a Yoast write the Connector rebuilds that post's Yoast indexable when the
Yoast classes exist (guarded; a failure is reported in `warnings`, never fatal).

→ `{ changeId, target, before: {…fields}, after: {…fields}, warnings: [] }`

### `schema/get` `{ url | postId | site: true }`
→ `{ target, pieces: [ { id, piece } ] }`

### `schema/set` `{ url | postId | site: true, id, piece | remove: true, reason? }`

- `id` is a slug, `[a-z0-9-]{1,64}`.
- `piece` is one JSON-LD object with `@type`, at most 20 KB. `@context` is stripped.
- Up to 20 pieces per target.
- Storage: post meta `_pib_schema` for a page, the option `pib_connector_schema_site`
  for the whole site.
- Output:
  - Yoast: appended to the Yoast graph with the `wpseo_schema_graph` filter. Each
    piece gets `@id = <url>#pib-<id>` if it has none.
  - RankMath: through the `rank_math/json_ld` filter.
  - No SEO plugin: one `<script type="application/ld+json">` with an `@graph` in
    `wp_head`.

→ `{ changeId, target, pieces }`

### `redirects/list` `{}`
→ `{ provider, redirects: [ { from, to, code, hits, lastHit } ] }`

### `redirects/set` `{ from, to?, code: 301|302|307|308|410, reason? }`

- `from` is a site-relative path. It is normalised: leading slash, no trailing slash
  except `/`, lower-cased, query stripped.
- `to` is required except for 410. It is a relative path or an absolute http(s) URL.
- The request is refused when `to` equals `from` or would create a loop with an
  existing redirect.
- Maximum 2000 redirects.
- Matching happens on `template_redirect` at priority 1, and only for requests that
  are not wp-admin, REST, cron or login.

→ `{ changeId, redirect }`

### `redirects/delete` `{ from, reason? }` → `{ changeId, removed: bool }`

### `robots/get` `{}` → `{ blogPublic, extraLines, robotsTxt }`
`robotsTxt` is the rendered content of `do_robots`.

### `robots/set` `{ extraLines?, allowSearchEngines?: true, reason? }`

- `extraLines` is text appended to robots.txt through the `robots_txt` filter,
  inside `# PiB Connector` markers. At most 4 KB. It may not contain `Disallow: /`
  on its own line under `User-agent: *` (refused, `pib_unsafe`).
- `allowSearchEngines: true` sets `blog_public = 1`. The Connector never sets it to 0.

→ `{ changeId, blogPublic, extraLines }`

### `sitemap/get` `{}` → `{ provider, url, seoPluginSitemap: bool|null, excludePostIds }`

### `sitemap/set` `{ seoPluginSitemap?: bool, excludePostIds?: number[], reason? }`

- `seoPluginSitemap` switches Yoast's `enable_xml_sitemap` through
  `WPSEO_Options::set` (Yoast only; otherwise `pib_unsupported`).
- `excludePostIds` is applied through `wpseo_exclude_from_sitemap_by_post_ids`
  (Yoast), `rank_math/sitemap/posts_to_exclude` (RankMath) and
  `wp_sitemaps_posts_query_args` (core).

→ `{ changeId, provider, url, seoPluginSitemap, excludePostIds }`

### `plugins/list` `{}` → `{ plugins: [ { file, slug, name, version, active } ] }`

### `plugins/install` `{ zipUrl, sha256, slug, reason? }`

- `zipUrl` must be https.
- The Connector downloads it with `download_url()`, checks the sha256, and checks
  that the zip's top folder equals `slug`.
- If the plugin exists it backs it up first: the folder is zipped to
  `wp-content/pib-connector-backups/<slug>-<UTC yyyymmddHHMMss>.zip`, a folder
  protected by `.htaccess` deny and an `index.php`.
- It installs with `Plugin_Upgrader` and `overwrite_package`, and keeps the plugin
  active if it was active.
- Never used on the Connector itself.

→ `{ changeId, slug, before: {version}|null, after: {version}, backupId|null }`

### `plugins/backups` `{}` → `{ backups: [ { backupId, slug, version, createdAt, bytes } ] }`

### `plugins/rollback` `{ backupId, reason? }`
Restores a backup over the current folder (after backing up the current one) and
keeps the active state.
→ `{ changeId, slug, restoredVersion }`

### `log` `{ limit? }`
→ `{ changes: [ { changeId, at, actor, endpoint, target, reason, before, after, undone } ] }`
The last 200 changes, stored in the option `pib_connector_log`, newest first.

### `undo` `{ changeId }`
Reverts a `seo/set`, `schema/set`, `redirects/*`, `robots/set` or `sitemap/set`
change to its `before` state. Plugin installs are reverted with
`plugins/rollback`.
→ `{ changeId (the new change), undid }`

## Safety rules the Connector enforces

- Only the endpoints above. It never runs arbitrary PHP, never runs SQL, never deletes posts,
  plugins or users.
- Every write is logged with its before and after state, so it can be undone.
- `plugins` is off until a person switches it on in wp-admin.
- Uninstalling removes the key and settings but keeps backups and the log.
