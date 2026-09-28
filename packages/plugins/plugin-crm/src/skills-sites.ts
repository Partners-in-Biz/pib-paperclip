/**
 * Skills for client websites and client apps: WordPress sites (PiB Connector
 * and SFTP deploys of our own plugins) and iOS releases on a Mac build host.
 */

export const CLIENT_SITES_SKILL = `# Client websites: WordPress, the PiB Connector and SFTP deploys

A client can have several websites. The CRM keeps them (\`list-client-sites\`, \`save-client-site\`): address, platform, SEO plugin, hosting, notes, and how you reach each one:
- **repo:** the code is in the site's Paperclip project workspace (normal git flow).
- **connector:** the PiB Connector WordPress plugin. Signed, logged SEO changes through the CRM's \`wp-*\` tools.
- **sftp:** file access for deploying **our own** WordPress plugins. The login is env on the site's Paperclip project, so only runs in that project have it.

Read the site's \`notes\` first. House rules on every WordPress site: **deactivate plugins, never delete them**; never edit wp-config.php, the database or theme files unless the issue says so and a person approved it; keep Yoast or Rank Math installed (the Connector writes into them).

## The PiB Connector (SEO and small settings)
- \`wp-health\` first: WordPress and PHP versions, SEO plugin, sitemap provider, whether search engines are allowed, plugin updates waiting.
- Page SEO: \`wp-seo\` op get, decide, then op set with a one-line \`reason\`. Only the fields you send change.
- Schema: \`wp-schema\` with stable ids (\`localbusiness\`, \`faq-home\`); it joins the SEO plugin's graph.
- Redirects \`wp-redirects\` (301 moved, 410 gone), robots.txt lines and search engine visibility \`wp-robots\`, sitemap \`wp-sitemap\`.
- Every write returns a \`changeId\`. \`wp-log\` shows the site's log; \`wp-undo\` reverts one change. \`site-changes\` is Paperclip's own log.
- Check the live page after each change (\`partnersinbiz.seo:check-meta\`, \`validate-schema\`, \`check-sitemap\`). A page cache can serve the old page for minutes: re-check after 2 minutes, then ask for a cache purge on Needs you.
- Not connected: a site with sftp access you pair yourself (below). Otherwise a person pairs it on the CRM client page; put that on Needs you and block the task.
- Plugin installs through the Connector (\`wp-plugins\` install/rollback) are for people. Use SFTP for our plugins.

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
`;

export const IOS_RELEASE_SKILL = `# iOS releases on a Mac build host

iOS apps can only be built and signed on a Mac. The Mac is a Paperclip **environment** (driver ssh, reached over Tailscale): a project or agent set to it runs there, and the worktree is synced to the Mac and back. Everything else stays on the server.

## Before you build
- Run \`uname -s\` (must be Darwin) and \`xcodebuild -version\`. Not on the Mac: stop and say the project needs the Mac environment (Project → Settings → Execution environment).
- \`asc auth status\` shows the App Store Connect API key profiles. One key covers one App Store Connect team; pick the profile for this app's team (\`asc auth switch --name <profile>\` or \`--profile\`). No profile for the team: Needs you (a person creates an API key with App Manager access in App Store Connect → Users and Access → Integrations and runs \`asc auth login\` on the Mac).
- Over SSH the login keychain is locked. Prefer signing with the API key (below). If the project uses a signing keychain instead, unlock it with the password from \`$PIB_SIGNING_KEYCHAIN_PASSWORD\`: \`security unlock-keychain -p "$PIB_SIGNING_KEYCHAIN_PASSWORD" "$PIB_SIGNING_KEYCHAIN"\` and never print it.

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

## Record
On the issue: version and build number, commit, archive and upload output (last lines), the TestFlight build link, and anything that failed. \`log-activity\` on the client.
`;
