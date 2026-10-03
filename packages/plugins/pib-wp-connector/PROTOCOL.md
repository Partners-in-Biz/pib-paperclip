# PiB Connector protocol (v1, extended in 1.1.0 and 1.2.0)

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

---

# Version 1.1.0 additions

Everything above still holds. 1.1.0 adds the endpoints below so an agent can finish the
SEO work that used to fall back to wp-admin: social-share images, image alt text, archive
and category SEO, page copy, new draft pages, and updating the Connector itself.
`health` reports `connector.version` (`1.1.0`), `connector.protocol` (`"1.1"`) and
`connector.endpoints` (every endpoint the installed version serves), so a caller can tell
an old install from a new one. An old install answers the new routes with `rest_no_route`.

## New feature switches

| Feature | Default | Endpoints |
|---|---|---|
| `media` | on | `media/list`, `media/sideload`, `media/set-featured`, `media/alt` |
| `content` | on | `posts/get`, `posts/images`, `posts/img-alt`, `posts/update`, `posts/create`, `posts/publish` |
| `selfupdate` | on | `self/update`, `self/rollback` |

`seo/list` belongs to the `seo` feature. Existing installs that saved their feature settings
before 1.1.0 get the new features at their defaults.

## Targets: terms and post type archives

`seo/get` and `seo/set` also take these targets (resolved by `PIB_Connector_Target`):

- `termId` (+ optional `taxonomy`, default: search public taxonomies): a category, tag,
  product category and so on. Result target: `{ postId: null, type: "term", termId, taxonomy, url, title }`.
- `postTypeArchive: "product"`: the archive page of a post type that has one. Result target:
  `{ postId: null, type: "archive", postType, url, title }`.
- `url` that is not a single post now falls back to: a post type archive link, then a
  public term link, matched exactly (path compare, trailing slash ignored). Only when
  nothing matches does it return `pib_unsupported_target`.

Storage:

| Target | Yoast | RankMath | No SEO plugin |
|---|---|---|---|
| term | option `wpseo_taxonomy_meta[taxonomy][termId]`: `wpseo_title`, `wpseo_desc`, `wpseo_canonical`, `wpseo_noindex` (`noindex`/`index`/`default`), `wpseo_focuskw`, `wpseo_opengraph-title`, `wpseo_opengraph-description`, `wpseo_opengraph-image`, `wpseo_opengraph-image-id` | term meta `rank_math_title`, `rank_math_description`, `rank_math_canonical_url`, `rank_math_robots`, `rank_math_focus_keyword`, `rank_math_facebook_title`, `rank_math_facebook_description`, `rank_math_facebook_image`, `rank_math_facebook_image_id` | term meta `_pib_seo_*` |
| archive | option `wpseo_titles`: `title-ptarchive-<type>`, `metadesc-ptarchive-<type>`, `noindex-ptarchive-<type>`, `social-title-ptarchive-<type>`, `social-description-ptarchive-<type>`, `social-image-url-ptarchive-<type>`, `social-image-id-ptarchive-<type>` | `pib_unsupported` (422) | option `pib_connector_archive_seo[<type>]`, printed like the home page |

`nofollow` and `canonical` are not supported for `archive` (`pib_unsupported` if sent non-null).
Yoast rebuilds the term or archive indexable after a write when its classes exist.

**WooCommerce shop page.** If `wc_get_page_id('shop')` equals the target post and Yoast is
the SEO plugin, `seo/set` also writes title, description, ogTitle and ogDescription and
`ogImage` to the `product` archive keys above (Yoast serves the shop page from the archive
settings) and adds `"shop page: also written to the product archive settings"` to `warnings`.
`seo/get` on that page returns the page's own values plus `archive` (the archive values).

## New SEO field: `ogImage`

`seo/get` returns `ogImage` (string URL or `null`) next to the other fields and `seo/set`
accepts it (`null`/`""` clears). The value must be an https URL (or a site-relative path
starting with `/`, stored as an absolute URL). When it matches a Media Library file
(`attachment_url_to_postid`) the attachment id is stored too.

| Adapter | URL | Id |
|---|---|---|
| Yoast post | `_yoast_wpseo_opengraph-image` | `_yoast_wpseo_opengraph-image-id` |
| Yoast home | `wpseo_titles` option `open_graph_frontpage_image` | `open_graph_frontpage_image_id` |
| RankMath post | `rank_math_facebook_image` | `rank_math_facebook_image_id` |
| RankMath home | `rank-math-options-titles` `homepage_facebook_image` | `homepage_facebook_image_id` |
| none | `_pib_seo_og_image` (printed as `og:image` and `twitter:image` in `wp_head`) | |

With no SEO plugin the Connector also prints `og:image` from the post's featured image when
`_pib_seo_og_image` is empty. `undo` restores `ogImage` like every other field.

## `seo/list`
`{ postType?: "page", status?: "publish", search?, page?: 1, perPage?: 50 (max 100), missing?: ["title"|"description"|"ogImage"] }`
→ `{ total, page, perPage, items: [ { postId, url, postType, title, slug, status, modified, featuredImageId, fields: {…seo/get fields}, missing: ["title","description","ogImage"] } ] }`

`missing` uses the effective state: `ogImage` counts as present when the field is set or the
post has a featured image; `title`/`description` are missing when the override is null and
the post has no usable fallback (the page title alone does not count as a description).
`missing` in the request keeps only items missing at least one of those.

## Media (`media` feature)

### `media/list` `{ search?, postId?, missingAlt?: bool, mime?: "image", page?: 1, perPage?: 50 (max 100) }`
→ `{ total, page, perPage, items: [ { attachmentId, url, title, alt, mime, width, height, parentId, filesize } ] }`
`postId` lists the images attached to that post plus its featured image. `missingAlt`
keeps images whose alt text is empty.

### `media/sideload` `{ imageUrl, title?, alt?, filename?, postId?, reason? }`
Downloads an image and adds it to the Media Library.
- `imageUrl` must be https; the file must be jpeg, png, webp, gif or avif, at most 10 MB
  (checked by real MIME type, not extension). Downloaded with `download_url()`, added with
  `media_handle_sideload()`.
- The source URL is kept in attachment meta `_pib_source_url`; sideloading the same URL again
  returns the existing attachment (`reused: true`) instead of a duplicate.
- `alt` is written to `_wp_attachment_image_alt`. `postId` attaches it as a child of that post
  (does not change the featured image).

→ `{ changeId, attachmentId, url, reused: bool }`. Uploads are additive and never deleted, so
this change is not undoable (`pib_not_undoable`); undo the change that used the image.

### `media/set-featured` `{ postId, attachmentId | imageUrl, alt?, title?, reason }`
Sets the post's featured image. `imageUrl` is sideloaded first (same rules and reuse as
`media/sideload`). `attachmentId` must be an image attachment.
→ `{ changeId, postId, before: { attachmentId|null }, after: { attachmentId, url }, reused? }`. Undoable.

### `media/alt` `{ items: [ { attachmentId, alt } ], reason }`
1 to 50 items. `alt` is plain text up to 300 characters; an empty string clears it.
→ `{ changeId, updated: [ { attachmentId, before, after } ] }`. Undoable.

## Content (`content` feature)

Content edits are limited to existing posts and pages the Connector can see, plus new
**drafts**. The Connector never deletes content and never changes a post's author.

### `posts/get` `{ postId | url }`
→ `{ postId, postType, status, url, title, slug, excerpt, content, modified, featuredImageId, parentId, createdByConnector: bool, truncated: bool }`
`content` is the raw `post_content` (block markup), at most 500 KB (`truncated` says so).

### `posts/images` `{ postId | url }`
→ `{ postId, images: [ { index, src, alt, attachmentId } ] }` for every `<img>` in
`post_content`, in order (`index` starts at 0). `attachmentId` comes from the `wp-image-<id>`
class or `attachment_url_to_postid`, else `null`.

### `posts/img-alt` `{ postId | url, alts: [ { index, alt } ], reason }`
Changes only the `alt` attribute of the listed `<img>` tags (1 to 100). Nothing else in the
content changes. Values are plain text up to 300 characters. Also writes the alt to the
library attachment when the image has one and its alt was empty.
→ `{ changeId, postId, updated: n }`. Undoable.

### `posts/update` `{ postId | url, title?, content?, excerpt?, slug?, reason }`
- Sends only what should change. `content` must not contain `<script`, `<iframe`,
  `<object`, `<embed`, `<form`, `javascript:` URLs or `on<event>=` attributes unless the
  same text already appears in the existing content (so existing embeds survive an edit);
  otherwise `pib_unsafe` (422).
- `status`, `author` and `password` are ignored if sent. `slug` changes keep WordPress's
  own old-slug redirect; also add a redirect with `redirects/set` for pages with traffic.
- Before the write the old title, content, excerpt and slug are saved (last 5 per post) in
  post meta `_pib_content_backups`, capped at 500 KB per version.
→ `{ changeId, postId, changed: [ "title"|"content"|"excerpt"|"slug" ], warnings }`. Undoable.

### `posts/create` `{ postType?: "page"|"post" (default "page"), title, content?, excerpt?, slug?, parentId?, reason }`
Creates a **draft** (never published), marked with post meta `_pib_created_by_connector = 1`.
Same content safety rules as `posts/update`.
→ `{ changeId, postId, status: "draft", editUrl, previewUrl }`. Undo moves it to the trash
(recoverable), and only while it is still a draft created by the Connector.

### `posts/publish` `{ postId, reason }`
Publishes a draft that the Connector created (`_pib_created_by_connector`). Anything else is
`pib_forbidden` (403). Undo returns it to draft.
→ `{ changeId, postId, status: "publish", url }`

## Self update (`selfupdate` feature)

### `self/update` `{ zipUrl, sha256, reason }`
Replaces the Connector with a newer build.
- `zipUrl` must be https and its host must be in the allow-list: `paperclip.partnersinbiz.online`
  by default, extendable in code with the filter `pib_connector_update_hosts`. The sha256 is
  checked with `hash_equals`.
- The zip must contain only entries under `pib-connector/`, with `pib-connector/pib-connector.php`
  whose `Version:` header is higher than the installed one (no downgrades, no same version).
- The current folder is zipped to `wp-content/pib-connector-backups/pib-connector-<version>-<UTC>.zip`
  first, then replaced with `Plugin_Upgrader` (`overwrite_package`), keeping the plugin's active
  state. If the install fails, the backup is restored at once.
→ `{ changeId, before: { version }, after: { version }, backupId }`

### `self/rollback` `{ backupId, reason }`
Restores a Connector backup made by `self/update`. → `{ changeId, restoredVersion }`

`undo` does not apply to self updates; use `self/rollback`.

## Undo coverage in 1.1.0

`undo` also reverts `seo/set` for terms, archives and `ogImage`, `media/set-featured`,
`media/alt`, `posts/img-alt`, `posts/update`, `posts/create` and `posts/publish`.
Not undoable: `media/sideload` (additive), `plugins/*`, `self/*`.

## Errors added

`pib_unsafe` (422, content or value refused by a safety rule), `pib_forbidden` (403),
`pib_unsupported` (422, the SEO plugin cannot do that), `pib_media_failed` (502, download or
import failed; the message says why), `pib_update_failed` (502).

## Implementation notes (1.1.0)

Where the contract above left room, the 1.1.0 Connector does this. Callers may rely on it.

**Reason.** `reason` is required (non-empty after cleaning, 400 `pib_bad_request`
otherwise) for `media/set-featured`, `media/alt`, `posts/img-alt`, `posts/update`,
`posts/create`, `posts/publish`, `self/update` and `self/rollback`. It stays optional
for `seo/set` and `media/sideload`.

**SEO targets.**
- Exactly one of `postId`, `termId`, `postTypeArchive` may be sent (400 otherwise).
  `schema/*` keeps its old targets: a term or archive URL is still `pib_unsupported_target`.
- Fields a target cannot store are refused with `pib_unsupported` (422) when sent non-null and
  ignored when sent as `null`: archives cannot take `canonical`, `nofollow` or `focusKeyword`;
  a Yoast term cannot take `nofollow`. The `home` target keeps its 1.0 behaviour (a warning).
- RankMath has no post type archive settings: `seo/get` and `seo/set` both answer
  `pib_unsupported` (422) for an archive target.
- Yoast stores an archive's noindex as a boolean, so `noindex: false` reads back as `null`.
- Yoast home `ogImage` lives in the `wpseo_titles` option (`open_graph_frontpage_image`,
  `open_graph_frontpage_image_id`), next to the other home fields. (Verified against Yoast
  28.6: the older `wpseo_social` `og_frontpage_image` keys are migrated away by Yoast and
  ignored when rendering.)
- A site-relative `ogImage` is made absolute with `home_url()`, so on a site whose home URL is
  `http://` it is refused like any non-https URL.
- The shop-page mirror is undone together with the page change.
- Verified against Yoast 28.6 + WooCommerce 11: Yoast renders the shop page from the shop
  page's own post meta, not from the `product` archive settings. So the mirror runs both
  ways: a `seo/set` on the shop page also writes the archive settings (warning as above), and
  a `seo/set` on `postTypeArchive: "product"` also writes the shop page's post meta
  (title, description, ogTitle, ogDescription, ogImage; warning `"product archive: also
  written to the shop page"`). A `url` that is the shop page's URL resolves to the shop page
  (`type: "post"`), not to the archive, because `url_to_postid()` cannot see the page.
- Yoast term writes go through `WPSEO_Taxonomy_Meta::set_values( $termId, $taxonomy, $row )`
  with the whole stored row plus the change (Yoast resets every key that is missing from the
  row), then the indexable is rebuilt.

**`seo/list` `missing`.** `title` is missing when the title override is `null` (the plugin's
template title is not a written title); `description` is missing when the override is `null` and
the post excerpt is empty; `ogImage` is missing when the field is `null` and there is no featured image.

**Content.**
- A request body is at most 256 KB (`pib_too_large`, 413), so `content` sent to
  `posts/update` / `posts/create` is effectively limited to that; `posts/get` still returns up
  to 500 KB. A post whose stored content is over 500 KB cannot be edited (`pib_unsupported`).
- `posts/update` and `posts/img-alt` with nothing to change answer 200 with `changeId: null`
  (and `changed: []` / `updated: 0`) and write nothing.
- `undo` of `posts/update` / `posts/img-alt` needs the saved copy in `_pib_content_backups`
  (last 5 per post); if it has rotated out the answer is `pib_not_undoable` (422). `posts/img-alt`
  also restores library alt text it had set.
- `posts/publish` on a page that is not a draft: 409 `pib_conflict`. Undo of `posts/create` is
  refused (`pib_not_undoable`) once the page is no longer a draft.
- `posts/*` do not accept the blog home page URL (`pib_unsupported_target`).
- Content is written with WordPress's kses filters switched off for the duration of the write
  (see README, Security model).

**Media.** Type, size and download refusals are all `pib_media_failed` (502) with the reason in
the message. `media/sideload` with `alt` on a reused attachment sets the alt only if it was empty.
`media/set-featured` `title` applies to a newly uploaded file only; `alt` applies to the
attachment and is restored by `undo`.

**Self update.** `zipUrl` not https / `sha256` malformed: 400 `pib_bad_request`; host not
allowed (also a port other than 443, or credentials in the URL): 403 `pib_forbidden`; sha256
mismatch: 422 `pib_checksum`; foreign, unsafe or unreadable zip, or not the PiB Connector: 422
`pib_bad_zip`; same or lower version: 422 `pib_downgrade`; download failure or an install that
had to be reverted: 502 `pib_update_failed`; the Connector not at
`wp-content/plugins/pib-connector`: 422 `pib_unsupported`. A failed update is not logged as a
change. The backup id is `pib-connector-<version>-<UTC yyyymmddHHMMss>`; it is also in the log
entry's `after.backupId`. Connector backups are not listed by `plugins/backups` and are refused
by `plugins/rollback`. `self/rollback` backs up the version it replaces first (same id format).

**Self update safety checks.**
- Every `.php` file in the zip must parse (`token_get_all( …, TOKEN_PARSE )`); otherwise 422
  `pib_bad_zip` ("<file> has a PHP syntax error (line n)") before anything is touched. A parse
  error installed "successfully" and took the whole site down in live testing.
- After the files are replaced (`self/update` and `self/rollback`) the Connector asks its own
  route once, unsigned, over a loopback request (`/?rest_route=/pib-connector/v1/ping`). A
  401 with a `pib_*` code means it loaded; a 5xx (fatal error) or `rest_no_route` means it did
  not, and the previous files are restored at once (`pib_update_failed`, "The site stopped
  answering …"). If the loopback itself is impossible (host blocks it, timeout) the update
  stands. The filter `pib_connector_site_check` can force `ok`/`broken`/`unknown` (tests).
- The host allow-list is checked before the URL's DNS/private-address validation, so a
  disallowed host is always 403 `pib_forbidden`.
- `zipUrl` must use the default port, so a test rig needs a real https host on 443 (or a
  `pre_http_request` filter in the test site).

**Errors added.** `pib_conflict` (409), `pib_write_failed` (500), `pib_downgrade` (422),
`pib_checksum` (422) and `pib_bad_zip` (422) are used as described above.


---

# Version 1.2.0 additions: site verification

Search engines and indexing services ask a site owner to prove ownership with a meta tag or a
small file at the site root. Until 1.2.0 an agent could not do either on WordPress and parked the
task with a person. 1.2.0 adds the `verify` feature. Nothing is written to disk: the tags are
printed by the Connector and the files are served by the Connector, so undo needs no cleanup and a
security plugin that makes the web root read-only does not matter.

`health.connector.version` is `1.2.0`, `connector.protocol` `"1.2"`, and `connector.endpoints`
includes `verify/get` and `verify/set`.

| Feature | Default | Endpoints |
|---|---|---|
| `verify` | on | `verify/get`, `verify/set` |

## `verify/get` `{}`
→ `{ metaTags: [ { name, content } ], files: [ { path, contentType, content } ] }`

## `verify/set` `{ metaTags?, files?, reason }`
Each of `metaTags` and `files`, when sent, **replaces** the whole list of that kind (send the
current list plus your addition). Omit a key to leave that list alone. `reason` is required.

**`metaTags`**: up to 20 items `{ name, content }`.
- `name` must be one of: `google-site-verification`, `msvalidate.01`, `yandex-verification`,
  `p:domain_verify` (Pinterest), `facebook-domain-verification`, `norton-safeweb-site-verification`,
  `baidu-site-verification`, `naver-site-verification`, `alexaVerifyID`.
- `content` is 1 to 200 characters of `[A-Za-z0-9._:=+/-]`.
- Printed as `<meta name="…" content="…" />` in `wp_head` at priority 1 on every front-end page
  (so the home page carries it).

**`files`**: up to 10 items `{ path, content }`. `path` is a site-root path and must match one of:
- IndexNow key file: `/<key>.txt` where `<key>` is 8 to 128 characters of `[A-Za-z0-9-]`;
  `content` must equal the key exactly (an optional trailing newline is allowed).
  Served as `text/plain; charset=utf-8`.
- Google HTML file: `/google<16 to 32 hex>.html`; `content` must equal
  `google-site-verification: <the file name>`. Served as `text/html; charset=utf-8`.
- `/BingSiteAuth.xml`; `content` must be exactly
  `<?xml version="1.0"?><users><user>HEX</user></users>` where HEX is 16 to 64 uppercase hex
  characters (whitespace between elements is allowed). Served as `application/xml`.
- Nothing else. Any other path, or content that does not match its path rule, is `pib_unsafe` (422).

Serving: on `parse_request`, before WordPress resolves the request, when the request path
(query string ignored, no trailing slash, method GET or HEAD) equals a stored path exactly, the
Connector answers 200 with that content, `Cache-Control: no-cache` and `X-Robots-Tag: noindex`,
and stops. If a real file with that name exists on disk the web server serves it and WordPress
never runs; `verify/get` reports `diskConflicts: [path…]` for stored paths that exist on disk.

→ `{ changeId, metaTags, files, warnings }`. Undoable: `undo` restores the previous lists.
Storage: option `pib_connector_verify` (autoload on, small).

Errors: `pib_unsafe` (422) for a name, path or content outside the rules above,
`pib_bad_request` (400) for wrong types, over the counts, or a missing reason.

## Notes on 1.2.0 behaviour

Where the contract above left room, the 1.2.0 Connector does this. Callers may rely on it.
Verified on a real WordPress 7.1.2 with Yoast SEO 28.6 (see README, Tests).

- **Validation order.** Neither `metaTags` nor `files` sent: 400. Then `reason` (400). Then the
  lists. `null` for a list is a wrong type (400), not "clear"; send `[]` to clear. A list that is
  not a JSON array, an item that is not an object, an item with keys other than `name`/`content`
  (`path`/`content`), a non-string value, or more than 20 tags / 10 files: `pib_bad_request` (400).
  A name, path or content outside the rules: `pib_unsafe` (422); that includes an empty or
  over-long tag `content`. Nothing is stored when any item is refused.
- **Duplicates.** An exact duplicate item (same name and content, or same path and content) is
  dropped. The same `path` twice with different content is `pib_bad_request`.
- **Rule details.** Tag `name` is case-sensitive. IndexNow `content` may be the key or the key
  plus one `\n` (or `\r\n`) and is stored and served as sent. Google `content` must be exactly
  `google-site-verification: <file name>` (no trailing newline); the hex in the name may be either
  case. Bing hex must be uppercase; whitespace is allowed between and after the elements, not before
  `<?xml`. The path is compared case-sensitively.
- **Output.** `verify/get` and `verify/set` return `files` items as
  `{ path, contentType, content }` (the content type is derived from the path, never chosen by the
  caller). `warnings` in the `verify/set` answer names each stored path that also exists on disk.
  `diskConflicts` looks in the WordPress root and, when the web server gives a `DOCUMENT_ROOT`, in
  the document root (plus the home URL's sub-directory).
- **Serving.** Registered on `parse_request` at priority 0. The request path is taken from
  `REQUEST_URI` (query string and fragment dropped, trailing slashes removed, no percent-decoding).
  A site installed in a sub-directory (home URL with a path) serves the files under that path only.
  The response is `200`, `Content-Type` as stored, `Cache-Control: no-cache`, `X-Robots-Tag: noindex`;
  for HEAD the same headers and no body. No `Content-Length` is sent (a compression layer may change
  the length). Then `exit`. Other methods, other paths and a switched-off feature fall through to
  WordPress unchanged (404 as before). Meta tags are printed on `wp_head` at priority 1, before Yoast
  and Rank Math, on every front-end page; nothing is printed or served while `verify` is off.
- **Defence in depth.** Stored lists are re-checked against the rules on every request, so a hand-edited
  option can never print an unknown meta name or serve a path/content pair the rules forbid.
- **Undo.** Restores both previous lists (whatever the change touched). Refused with `pib_disabled` while
  the feature is off, and with `pib_not_undoable` if the saved previous state no longer passes the rules.
- **Filter for tests.** `pib_connector_verify_exit` (default `true`): return `false` to make the serving
  function return instead of exiting.
- **Updating from 1.1.0.** `self/update` from 1.1.0 to 1.2.0 was run on a real site: the key file kept
  pairing working, `health` reported `1.2.0`/`"1.2"` with the `verify` endpoints straight after, and
  `verify/*` worked without re-pairing. Settings saved by 1.1.0 get `verify` at its default (on).

