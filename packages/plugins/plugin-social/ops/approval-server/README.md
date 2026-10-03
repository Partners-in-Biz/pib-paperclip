# Client approval service

The public page where a client approves (or asks for changes to) a social post before it is scheduled. It follows the SEO preview service (`plugin-seo/ops/preview-server`): a tokenised link, its own small service, its own database role. Built for Social's client approval policy (Q1a-2).

- A plugin-social tool, `request-client-approval`, freezes the post as the client will see it, makes a random link and returns it. The link is emailed to the client as a **Mailbox draft** that a person sends. Nothing here sends mail.
- The client opens `https://preview.partnersinbiz.online/a/<token>`: the post exactly as it will appear on each account, then **Approve** (their name is required) or **Request changes** (a note is required). The answer is stored once.
- The plugin's `client-answers` job (every 5 minutes) applies the answer: records the client's verdict as a sign-off, comments on the post's review issue, wakes the Social agent, and approves the post when the scope's policy has every sign-off it needs. An answer for a version of the post that has since changed is not applied.
- A GET never changes anything (mail scanners that open links cannot approve a post); only the form's POST does, and a POST that comes from this server itself is refused (see Limits).

## What is where

| | |
|---|---|
| Code | `server.mjs` (HTTP), `render.mjs` (page and form checks, unit-tested in `tests/approval-server.spec.ts`) |
| Unit | `pib-approval.service` (user `paperclip`, port 3032, hardened like `pib-preview`) |
| Installed at | `/home/paperclip/pib-approval/` (mode 700, owner `paperclip`) |
| Settings | `/root/pib-ops/approval.env` (mode 600): `PORT` and `APPROVAL_DATABASE_URL`. The password is generated once by `install.sh` and never printed |
| Database role | `pib_approval`: SELECT on `token_hash, status, snapshot, answered_by_name, answered_at, expires_at` and UPDATE of `status, answered_by_name, answer_note, answered_at, notified_at` on `plugin_social_e70c4e79f2.client_approvals`, nothing else (`setup.sql`) |
| Links | `https://preview.partnersinbiz.online/a/<43-character token>`. Only the token's SHA-256 is stored, so reading the table never yields a link. Open for 14 days by default (1-60, set per scope) |

## Install (the orchestrator, once, after plugin-social 0.8.0 is deployed)

Order matters: the table comes from the plugin's migration `015_social.sql`.

1. Deploy plugin-social 0.8.0 (it adds the capabilities `issue.attachments.read` and `projects.read`: stop-first, approve the upgrade).
2. On the VPS, as root, from this folder: `bash install.sh`. It checks the table exists, creates the role and grants, copies the files, installs and starts the unit, and prints `active` and `ok`.
3. Route `/a/*` to the service. In `/etc/caddy/Caddyfile`, in the existing `preview.partnersinbiz.online, preview.65.108.146.144.sslip.io` block, put the preview proxy inside a `handle` and add one before it:

   ```
   preview.partnersinbiz.online, preview.65.108.146.144.sslip.io {
   	encode zstd gzip
   	header X-Robots-Tag "noindex, nofollow"
   	handle /a/* {
   		reverse_proxy 127.0.0.1:3032 {
   			header_up X-Forwarded-For {remote_host}
   		}
   	}
   	handle {
   		reverse_proxy 127.0.0.1:3031 {
   			header_up X-Forwarded-For {remote_host}
   		}
   	}
   }
   ```

   Then `caddy validate --config /etc/caddy/Caddyfile` and `systemctl reload caddy`. No DNS or certificate change: the domain and its certificate already exist. (To use a different domain instead, give it its own Caddy block and set **Client approval page address** in the Social plugin settings, ending in `/a`.)
4. Check: `curl -s https://preview.partnersinbiz.online/a/health` answers `ok`. Social's Setup item "Client approval page" turns green by itself, and the Cockpit shows a red health item if links are out while the page is down.

A second run of `install.sh` updates the files and restarts the service (a restart only drops open requests; a link opens again straight away).

## Check it works

- `systemctl is-active pib-approval`, `journalctl -u pib-approval -n 20` (no errors).
- Open `https://preview.partnersinbiz.online/a/` plus 43 random characters: "This link is not valid" (404), not an error page.
- After a real link exists: open it, approve with a test name on a test post, wait up to 5 minutes, and see the comment on the post's review issue.
- `sudo -u postgres psql -d paperclip -c "select has_table_privilege('pib_approval','plugin_social_e70c4e79f2.posts','SELECT'), has_column_privilege('pib_approval','plugin_social_e70c4e79f2.client_approvals','answer_note','UPDATE')"` must say `f` then `t`.

## Disaster recovery

The role and its grants are not in the plugin's migration (a plugin cannot grant). `install.sh` recreates them from `setup.sql`; the restore test (`operations/vps/restore-test.sh`) checks the preview role the same way and should check this one too. The password file `/root/pib-ops/approval.env` is part of `/root/pib-ops`.

## Limits

- No scripts run on the page (Content-Security-Policy), media shows only from https addresses, the referrer is never sent (the token is in the URL), pages are never cached or indexed.
- 60 requests a minute per address; bodies over 8 KB are refused.
- The client's name is typed, not verified: the record says "answered on a link meant for <email>, as <name>". A person can also record a client's approval given elsewhere, with a note, on the post.
- **The link is a bearer token, and an agent holds it.** `request-client-approval` returns the link to the Social agent (so it can put it in a Mailbox draft), and the agent runs on the same server as this service. Where a team member also approves (the default, and "team member and client"), a forged answer would still need that person's click. Where ONLY the client approves, the link is the approval, so whoever holds it could answer in the client's name. Two things reduce the risk: the service refuses an answer that comes from this server itself (the server's own addresses and loopback, including a call to the public address from the same machine), and the Social page says so when that policy is chosen. That is a speed bump, not a wall: a process on this server that calls port 3032 directly with a made-up `X-Forwarded-For` is not stopped. Tell the owner before turning "client only" on; the structural fix is a Mailbox "draft from an event" path so no agent ever sees the link (needs the Mailbox plugin).
