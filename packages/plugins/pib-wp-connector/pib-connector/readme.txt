=== PiB Connector ===
Contributors: partnersinbiz
Tags: seo, redirects, schema, maintenance
Requires at least: 6.0
Tested up to: 6.8
Requires PHP: 7.4
Stable tag: 1.2.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Lets Partners in Biz make a short, fixed list of signed SEO and maintenance changes on this site.

== Description ==

PiB Connector connects this site to Partners in Biz (Paperclip CRM). It accepts
only signed requests (HMAC-SHA256 with a per-site key) for a fixed list of
actions:

* SEO titles, descriptions, canonicals, robots meta and social titles, written
  into Yoast SEO, Rank Math, or the Connector's own output when neither is active
* JSON-LD schema pieces per page or for the whole site
* Redirects (301, 302, 307, 308, 410)
* Extra robots.txt lines (it never discourages search engines)
* XML sitemap settings
* Plugin install and rollback from checksummed zips (off until you switch it on)
* Social-share images (og:image), and SEO for categories, tags, product categories and shop/archive pages
* Media Library: add images from a URL, set featured images, image alt text
* Page and post copy: edit existing content (with a safety check and a saved copy of the old text), create draft pages, publish drafts the Connector created
* Site verification: meta tags (Google, Bing, Yandex, Pinterest, ...) and the IndexNow key file, Google HTML file and BingSiteAuth.xml, served by the Connector (nothing is written to disk)
* Updating the Connector itself from a checksummed zip on partnersinbiz.online, with automatic restore if it fails

Every change is logged with its before and after state and can be undone. The
Connector never runs arbitrary code or SQL and never deletes posts, plugins or
users.

== Installation ==

1. Upload `pib-connector.zip` under Plugins → Add New → Upload Plugin and activate it.
2. In Paperclip, open CRM → the client → Websites → Connect WordPress and copy the key.
3. Paste the key under Settings → PiB Connector and save.

== Changelog ==

= 1.2.0 =
* New: verify/get and verify/set (feature `verify`, on by default): site verification meta tags in the page head and the IndexNow / Google HTML / BingSiteAuth.xml files, served by the Connector without writing any file. Strict allow-lists; undoable.
* health now reports protocol 1.2. Settings saved by older versions get the `verify` default.

= 1.1.0 =
* New: ogImage (social share image) for posts, the home page, categories/tags and post type archives, on Yoast, Rank Math and the Connector's own output.
* New: SEO for term (category, tag, product category) and post type archive pages; WooCommerce shop page settings are mirrored to the product archive with Yoast.
* New: seo/list, media/list, media/sideload, media/set-featured, media/alt.
* New: posts/get, posts/images, posts/img-alt, posts/update, posts/create (drafts only), posts/publish (Connector drafts only).
* New: self/update and self/rollback (allow-listed host, sha256, no downgrades, automatic restore).
* New feature switches: media, content, selfupdate (on by default). health now reports the protocol, all endpoints and WooCommerce.
* Existing behaviour for posts, pages and the home page is unchanged.

= 1.0.0 =
* First release.
