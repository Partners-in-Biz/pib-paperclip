/**
 * Skills for client websites and client apps: WordPress sites (PiB Connector
 * and SFTP deploys of our own plugins) and iOS releases on a Mac build host.
 */

export const CLIENT_SITES_SKILL = `# Client websites: WordPress, the PiB Connector and SFTP deploys

A client can have several websites. The CRM keeps them (\`list-client-sites\`, \`save-client-site\`): address, platform, SEO plugin, hosting, notes, and how you reach each one:
- **repo:** the code is in the site's Paperclip project workspace (normal git flow).
- **connector:** the PiB Connector WordPress plugin. Signed, logged SEO changes through the CRM's \`wp-*\` tools.
- **sftp:** file access for deploying **our own** WordPress plugins. The login is env on the site's Paperclip project, so only runs in that project have it.

Read the site's \`notes\` first. House rules on every WordPress site: **deactivate plugins, never delete them**; never edit wp-config.php or the database; theme and plugin template files only as **markup edits** under the routine below (never logic); keep Yoast or Rank Math installed (the Connector writes into them).

## The PiB Connector (SEO and small settings)
- \`wp-health\` first: WordPress and PHP versions, SEO plugin, sitemap provider, whether search engines are allowed, plugin updates waiting.
- Page SEO: \`wp-seo\` op get, decide, then op set with a one-line \`reason\`. Only the fields you send change. It also does categories and tags (\`termId\`), archives and the shop (\`postTypeArchive\`) and the share image (\`ogImage\`); op list audits many pages (\`missing: ["title","description","ogImage"]\`).
- Schema: \`wp-schema\` with stable ids (\`localbusiness\`, \`faq-home\`); it joins the SEO plugin's graph.
- Redirects \`wp-redirects\` (301 moved, 410 gone), robots.txt lines and search engine visibility \`wp-robots\`, sitemap \`wp-sitemap\`.
- Images: \`wp-media\` (op list with \`missingAlt\`, sideload an image from an https URL, set-featured, alt for up to 50 images) and, inside page copy, \`wp-content\` op images then img-alt. **Only use an image you have the rights to:** one already in the Media Library, one from the client's Drive or brand kit, one from the client's Social media library (\`partnersinbiz.social:list-media-assets\`), or one you generated when your run has an image-generation tool. Never hotlink, scrape or copy an image from elsewhere. No source for the image: ask for the asset on Needs you (page, subject, size, where to put it), not for a wp-admin edit. A sideload cannot be undone.
- Page copy: \`wp-content\` op get, then op update with only what changes and a \`reason\` (the site keeps the last 5 versions and refuses scripts, iframes and forms that were not already there). New pages: op create makes a **draft**; op publish publishes it only if the Connector created it and the task says to publish. No deletes, no status changes on existing pages, no author or password changes.
- **Site verification is your work, not a person's** (Connector 1.2+): \`wp-verify\` op get, then op set with the existing entries plus your addition (it replaces the lists you send). Meta tags: \`google-site-verification\`, \`msvalidate.01\` (Bing) and a few other search-engine names. Root files: the IndexNow key file \`/<key>.txt\`, Google's \`/google<hex>.html\` and \`/BingSiteAuth.xml\`. Nothing is written to disk, so a read-only web root does not matter. Fetch the live home page or file URL afterwards, confirm the exact content and a 200, then run the search engine's own verify step (\`partnersinbiz.seo:gsc-verify-site\`, \`bing-verify-site\`, \`request-indexing\`). The Google route makes our service account a verified owner of a URL-prefix property, so the client does not have to add it in Search Console. A route error means Connector older than 1.2: \`wp-connector\` update first. Still a person: creating a Merchant Center account (a Google account and business details), and anything that needs a plugin installed or deactivated.
- Every write returns a \`changeId\`. \`wp-log\` shows the site's log; \`wp-undo\` reverts one change (not image uploads or Connector updates). \`site-changes\` is Paperclip's own log.
- Check the live page after each change (\`partnersinbiz.seo:check-meta\`, \`validate-schema\`, \`check-sitemap\`, \`crawler-sim\`; a draft at its previewUrl). A page cache can serve the old page for minutes: re-check after 2 minutes, then ask for a cache purge on Needs you.
- Not connected: a site with sftp access you pair yourself (below). Otherwise a person pairs it on the CRM client page; put that on Needs you and block the task.
- Plugin installs through the Connector (\`wp-plugins\` install/rollback) are for people, and so is deactivating a plugin (deactivate, never delete). \`check-client-site\` warns about an active Open Graph plugin (duplicate og: tags next to the SEO plugin) and about maintenance or coming-soon plugins (crawlers can get a 503): fix the tags with \`wp-seo\`, check with \`check-meta\` and \`crawler-sim\`, and only then put the deactivation on Needs you. Use SFTP for our plugins. Also a person: deleting anything, publishing anything the Connector did not create, a site's theme or settings.

## Keep the Connector current
\`check-client-site\` and \`wp-health\` show the installed Connector version. When a tool says a route is missing, or \`check-client-site\` warns "Connector X is out of date (bundled Y)", **update it before you park the task on Needs you**:
- Connector 1.1 or newer: \`wp-connector\` op update with a \`reason\`. The CRM sends the build it ships and its checksum itself; you cannot pass a URL. It refuses when the site already has that version. Then \`check-client-site\` and re-check a page. If the site breaks, \`wp-connector\` op rollback with the \`backupId\` from the update result.
- Connector 1.0.x cannot update itself: one person uploads the new zip once in wp-admin → Plugins → Add New → Upload Plugin. Put that on Needs you with the download link from the warning, then block the task. After that you update it yourself.
- With sftp access you can also deploy the zip yourself using the routine below (back up first, sha256 readback).

## Pair the Connector over SFTP (sites with sftp access)
1. \`connect-client-site\` with the \`siteId\`: it returns a new key (treat it as a password; never print it in comments), the key id and the steps.
2. Download the zip from the returned path on this Paperclip server, unzip, and deploy the \`pib-connector\` folder with the SFTP routine below.
3. Write \`<webRoot>/wp-content/pib-connector-key.php\` containing only \`<?php return 'pibc_…';\`, and copy \`pib-connector/mu-loader/pib-connector-loader.php\` into \`<webRoot>/wp-content/mu-plugins/\`.
4. \`check-client-site\`: connected, with the same key id. Note it on the issue (key id only).

## Deploy our WordPress plugins over SFTP
Our plugins (auction search, saved listings, account overlay and the like) live in the site's project repo, one folder per plugin. The project env gives you \`WP_SFTP_HOST\`, \`WP_SFTP_PORT\` (22 when empty), \`WP_SFTP_USER\`, and \`WP_SFTP_PASSWORD\` or \`WP_SFTP_KEY\`. The WordPress folder is the site's \`webRoot\` (\`list-client-sites\`). Missing env: \`needs-you\` on the issue with the exact names to add (Project → Settings → Env, bound to company secrets), then block.

**Before:** \`php -l\` every PHP file and run the plugin's own tests (\`mock-test.php\` or \`tests/\`). A live deploy needs a person's approval on the issue unless the issue says it is pre-approved: prepare everything, ask, block, and continue when they approve.

**Connect** (rclone reads its remote from env; nothing is written to disk):
\`\`\`bash
export RCLONE_CONFIG_SITE_TYPE=sftp RCLONE_CONFIG_SITE_HOST="$WP_SFTP_HOST" RCLONE_CONFIG_SITE_PORT="\${WP_SFTP_PORT:-22}" RCLONE_CONFIG_SITE_USER="$WP_SFTP_USER" RCLONE_CONFIG_SITE_SHELL_TYPE=none
if [ -n "$WP_SFTP_KEY" ]; then export RCLONE_CONFIG_SITE_KEY_PEM="$(printf '%s' "$WP_SFTP_KEY" | awk 'BEGIN{ORS="\\\\n"}1')"; else export RCLONE_CONFIG_SITE_PASS="$(rclone obscure "$WP_SFTP_PASSWORD")"; fi
ROOT="<webRoot>"; STAMP="$(date -u +%Y%m%d-%H%M%S)"
rclone lsf "site:$ROOT/wp-content/"   # sanity check: plugins/ mu-plugins/ themes/
\`\`\`

**Routine** (the same every time):
1. **Back up** what you replace, twice: locally (\`rclone copy "site:$ROOT/wp-content/plugins/<slug>" "backups/$STAMP/<slug>"\`) and on the server under a new name (plugin folder: upload the local copy to \`wp-content/pib-backups/<slug>-$STAMP/\`; single mu-plugin file: \`<file>.bak-$STAMP\` next to it). Record the old file's sha256.
2. **Upload** to a new name first (\`wp-content/plugins/<slug>.pib-new-$STAMP\`), then swap with two renames: live → \`<slug>.pib-old-$STAMP\`, new → \`<slug>\` (\`rclone moveto\`). A single mu-plugin file: upload as \`<file>.pib-new\`, then rename over.
3. **Read back:** \`rclone cat "site:…/file" | sha256sum\` for every uploaded file must equal the local sha256.
4. **Check live:** the home page and the pages the plugin touches answer 200 and show no "critical error". Exercise what changed (e.g. a search, a saved listing) with curl or a browser.
5. **Broken:** rename back at once (\`<slug>.pib-old-$STAMP\` → \`<slug>\`), read back, check live, then report.
6. **Record** on the issue: files, old and new sha256, backup paths, the rollback command, what you checked. \`log-activity\` on the client.

Never delete remote files: renamed old copies and backups stay until a person cleans up. Never upload outside \`$ROOT/wp-content/\`.

## Edit a theme or plugin template file over SFTP (markup only)
For a small fix the Connector cannot make because it lives in template code: an empty \`alt=""\` on a decorative icon, a missing \`alt\`, a \`<title>\`, heading, meta or link tag. **In scope:** HTML attributes and tags inside a template. **Never:** PHP logic or control flow, queries, functions.php, scripts, forms, payment or login code, wp-config.php. Anything else goes to a person on Needs you. On an SEO sprint run \`partnersinbiz.seo:check-change-scope\` first (category \`theme_markup\`, path \`wp:theme:<file>\`); it says apply or pr_only. No SFTP login yet: \`partnersinbiz.seo:needs-you-add\` key \`wp_sftp\` and block; once the login is there you need no sign-off for each edit.

1. **Connect** as in the deploy routine above (env from the client project).
2. **Find the file.** Search the page's HTML for the exact tag (\`curl -s <url> | grep -n '<the tag>'\`), then look for the same text in \`$ROOT/wp-content/themes/<active theme>/\` and \`plugins/\` (\`rclone lsf -R\`, then \`rclone cat … | grep -n\`). Prefer the **child theme**: on a parent theme that updates itself, put the fix in the child theme's copy of the template (WordPress loads it first) rather than editing the parent. Rendered by a page builder or from the database: not a file edit, ask a person.
3. **Download** the file to \`work/\` and keep a copy as \`work/orig\`. Record its sha256.
4. **Edit the smallest thing** that fixes it (one attribute or one tag). Put the \`diff -u\` on the issue.
5. **Lint:** \`php -l\` on a PHP file. The diff must touch only markup: if a changed line contains PHP code you did not mean to change, stop.
6. **Back up** the live file on the server (\`<file>.bak-$STAMP\` next to it) and locally. **Upload** as \`<file>.pib-new\`, read it back (sha256 equals the local edit), then \`rclone moveto\` over the live file.
7. **Check live:** fetch the page (add \`?nocache=<time>\` when a cache is in front), confirm the fix is present, the page answers 200 and shows no "critical error". A cache still serving the old page after 2 minutes: ask for a purge on Needs you. Run \`partnersinbiz.seo:crawler-sim\` or \`check-meta\` for the page.
8. **Broken or unexpected:** move the \`.bak-$STAMP\` file back at once, read back, check live, then report. Never leave a half-applied edit.
9. **Record** on the issue: file path, diff, old and new sha256, backup path, the rollback command and the live check output. \`log-activity\` on the client. Then \`complete-task\`.
`;

export const IOS_RELEASE_SKILL = `# iOS releases on a Mac build host

iOS apps can only be built and signed on a Mac. The Mac is a Paperclip **environment** (driver ssh, reached over Tailscale): a project or agent set to it runs there, and the worktree is synced to the Mac and back. Everything else stays on the server.

## Before you build
- Run \`uname -s\` (must be Darwin) and \`xcodebuild -version\`. Not on the Mac: stop and say the project needs the Mac environment (Project → Settings → Execution environment).
- \`asc auth status\` shows the App Store Connect API key profiles. One key covers one App Store Connect team; pick the profile for this app's team (\`asc auth switch --name <profile>\` or \`--profile\`). No profile for the team: Needs you (a person creates an API key with App Manager access in App Store Connect → Users and Access → Integrations and runs \`asc auth login\` on the Mac).
- Over SSH the login keychain is locked, so \`asc\` cannot read its stored profiles ("credentials not found for profile") and code signing fails with \`errSecInternalComponent\`. Do not wait for a person to unlock it. Load the API key from its file instead: \`. ~/.config/pib/asc.env\` sets \`ASC_KEY_ID\`, \`ASC_ISSUER_ID\`, \`ASC_PRIVATE_KEY_PATH\`, \`ASC_KEY_PATH\` and \`ASC_BYPASS_KEYCHAIN=1\` (identifiers and a file path, no secret; the Mac's \`mac-asc-setup.sh\` writes it once). With it loaded, \`asc\` works over SSH and the \`xcodebuild\` commands below get their key flags. The file is missing: Needs you, one line, "run mac-asc-setup.sh on the Mac" (it asks for the App Store Connect issuer id and takes a minute); do not retry in a loop.
- The project's signing must be Automatic (\`CODE_SIGN_STYLE = Automatic\` and the team in \`DEVELOPMENT_TEAM\`, as Velox has). A project on manual signing needs the keychain route: only then unlock a dedicated signing keychain with the password from \`$PIB_SIGNING_KEYCHAIN_PASSWORD\`: \`security unlock-keychain -p "$PIB_SIGNING_KEYCHAIN_PASSWORD" "$PIB_SIGNING_KEYCHAIN"\`, and never print it.
- If the archive still fails with \`errSecInternalComponent\` after the key flags, say so with the exact CodeSign line and which framework failed: the API key may lack the role for cloud signing (it needs Admin or App Manager access in App Store Connect). That is a fact to report, not a reason to ask for the login keychain.

## Build and upload (TestFlight)
1. Bump the build number (\`agvtool next-version -all\` or the project's own script) and commit it.
2. Archive with cloud signing through the API key (no certificates needed in a keychain):
\`\`\`bash
xcodebuild -scheme "<Scheme>" -configuration Release -destination "generic/platform=iOS" \\
  -archivePath "build/<App>.xcarchive" archive \\
  -allowProvisioningUpdates -authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID"
xcodebuild -exportArchive -archivePath "build/<App>.xcarchive" -exportPath build/export -exportOptionsPlist ExportOptions.plist \\
  -allowProvisioningUpdates -authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID"
\`\`\`
   \`ExportOptions.plist\`: method \`app-store-connect\`, signingStyle \`automatic\`, your teamID. The \`ASC_*\` values come from the project env (bound to company secrets) or from the Mac's \`asc\` profile config; never write them into the repo.
3. Upload the .ipa with \`asc\` (see \`asc --help\` for the upload and TestFlight commands) and wait for processing.
4. Add the build to the TestFlight group the issue names; write "What to test".

## Submitting for review
Submitting to App Review is outward-facing: prepare the version, notes and screenshots, then ask a person on the issue and block. Submit only after they approve.

## Clean up when done

This Mac is also the owner's working machine and runs more than you. Disk and CPU are shared, so leave it as you found it. Do this before your final comment, every run, including runs that fail or are blocked:

- **Stop what you started.** Shut down only the simulators you booted (\`xcrun simctl shutdown <udid>\`; never \`shutdown all\` while another run is active) and stop any Android emulator, Metro, dev server, \`xcodebuild\`, Gradle daemon (\`./gradlew --stop\`) or other background process you launched. Check with \`ps\` that nothing of yours is still running.
- **Delete what you can rebuild.** In your workspace remove \`node_modules\`, \`Pods\`, \`ios/build\`, \`android/build\`, \`android/app/build\`, \`android/.gradle\` and any DerivedData you created (put it under \`~/paperclip-builds/dd-<issue>\` so it is easy to find, never leave it in the default location). Do this only after your commits are pushed and the build evidence is recorded.
- **Keep what is evidence.** Keep the \`.xcarchive\`/\`.ipa\`/\`.aab\` only if the task needs it for the next step, and say where it is. Otherwise delete it once the upload receipt is in your comment. Logs go in \`~/paperclip-builds/logs/\`, not in the repo.
- **Never** delete another run's folder, anything outside your workspace and \`~/paperclip-builds\`, simulators you did not boot, or git history. Do not delete your own run folder: the host copies it back when the run ends, and the Mac's janitor (hourly) removes old run copies.
- Put one line in your final comment: what you removed and the free disk space (\`df -h /\`).

## Record
On the issue: version and build number, commit, archive and upload output (last lines), the TestFlight build link, and anything that failed. \`log-activity\` on the client.
`;
