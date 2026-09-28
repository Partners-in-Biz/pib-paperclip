=== PiB Connector ===
Contributors: partnersinbiz
Tags: seo, redirects, schema, maintenance
Requires at least: 6.0
Tested up to: 6.8
Requires PHP: 7.4
Stable tag: 1.0.0
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

Every change is logged with its before and after state and can be undone. The
Connector never runs arbitrary code or SQL and never deletes posts, plugins or
users.

== Installation ==

1. Upload `pib-connector.zip` under Plugins → Add New → Upload Plugin and activate it.
2. In Paperclip, open CRM → the client → Websites → Connect WordPress and copy the key.
3. Paste the key under Settings → PiB Connector and save.

== Changelog ==

= 1.0.0 =
* First release.
