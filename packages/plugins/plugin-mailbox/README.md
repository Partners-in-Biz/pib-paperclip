# Mailbox

Paperclip plugin `partnersinbiz.mailbox`. Accounts keep credential secret refs. A delegation lets an agent read or draft. Sending stays off unless that delegation says send. Since 0.6.0 a second, send-only kind of account sends through an email provider (Resend) as a client's own verified domain; Gmail stays the default.

## Gmail hub (0.2.0)

The Mailbox is the company's Gmail. Every PiB plugin sends and receives mail through it: invoices, reminders and payslips go out from the connected Gmail account.

### Settings (Settings → Plugins → Mailbox, save once per company)

| Setting | Notes |
|---|---|
| `publicBaseUrl` | e.g. `https://paperclip.partnersinbiz.online`; builds the OAuth redirect URI |
| `encryptionKey` | secret ref, 16+ characters; seals the Gmail tokens (AES-256-GCM, kit crypto) |
| `google.clientId` / `google.clientSecret` | the Google Web client shared with SEO and YouTube (Gmail API enabled); secret is a secret ref |
| `jev` | TypeSafe (Jev) key for triage; empty = built-in rules |
| `labelPrefix` | default `PiB` → labels `PiB/Lead`, `PiB/POP`, `PiB/Needs reply`, … |
| `fromName` | optional display name on sent mail |
| `replyIssues` | default on: one "Reply needed" issue per thread for a known lead, client or support mail that needs a reply |
| `triageIssueAssignee` | optional agent id (or `user:<id>`) for reply issues; empty = the Account Manager, else the Operator, else the owner |
| `r2` | optional private R2 bucket for `get-attachment` links (15 minutes) |
| `sendRatePerMinute` | default 20 per Gmail account |
| `autoDelegate` | who gets read and draft (never send) on the company's own Gmail mailboxes without being asked: `operator` (default), `operator+roles` (also the Account Manager read and draft, the Bookkeeper read) or `off` |
| `domainChecks` | default on: the daily SPF, DKIM, DMARC and MX check of every sending domain |
| `dkimSelectors` | extra DKIM selectors to look for, comma separated (the usual ones are always tried) |
| `unsubscribe.secret` | secret ref, 16+ characters: with it, and once the Mailbox has proved the proxy rule works (see One-click unsubscribe), marketing mail to one recipient carries an https one-click unsubscribe link of the Mailbox's own |
| `esp.*` | the email provider (Resend), off by default (see 0.6.0): `enabled`, `apiKey` and `webhookSecret` (secret refs), `ratePerSecond` (default 4), `steadyDailyCap` (default 10,000), `prefer` (`gmail` or `transactional`), `defaultFrom`, `batch` |

### Connect Gmail

Mailbox page → **Connect Gmail**. Scopes: `gmail.modify`, `gmail.send`, `openid`, `email` (`access_type=offline`, `prompt=consent`). The callback is the kit OAuth bridge page; register this redirect URI on the Google Web client (shown on the page):

`<publicBaseUrl>/_plugins/<installation uuid>/ui/oauth-callback.html`

Tokens are refreshed and re-sealed. When Google refuses the refresh the account moves to **needs reconnect** and one "Reconnect Gmail" issue opens for the person who connected it; reconnecting closes it and keeps the sync cursor.

### Sync (`sync-mailbox`, every 2 minutes)

- `users.history.list` from the stored `historyId`; without a cursor, or when Gmail says it expired (404), a resync of the last 7 days (up to 300 messages).
- Headers only (`format=metadata`); attachment names come from a parts-only partial response. Bodies and attachments are never downloaded by the job. Drafts, spam, trash and chats are skipped.
- Triage: CRM contact by sender address (the contact's CRM company when linked), CRM company by sender domain, reply to mail a plugin sent (In-Reply-To/References, then thread). Then one Jev call per new message with sender domain, subject, snippet (≤500), attachment names/types and three flags: `category` (kit `MAIL_CATEGORIES`), `urgency` (0–3), `needs_reply`, `phishing`, plus a CRM client choice when a plausible client name appears. Decisions are logged (`decisions` table) and can be corrected.
- Delivery failure notices (bounces) are linked to the send they bounced: the bounced Message-ID from the notice's part headers, the thread, then `X-Failed-Recipients`. The event's `replyTo` is that send's context and an extra `bounce: {recipients, rfcIds}` field is added.
- Emits `mail.received` (kit `MailReceived`, key `mail:<gmail id>`) for newly triaged mail and re-emits the last 30 minutes every run; consumers dedupe by key.

### Sending for other plugins

Listens to `plugin.<sender>.mail.send.requested` for every kit `MAIL_SENDERS` plugin and answers with `mail.send.result` (kit `MailSendResult`).

- `receiveOnce` by request key, plus a claim on `send_requests`, so one request is sent once; a repeat delivery re-emits the stored result.
- MIME: multipart/mixed → multipart/alternative (text + html); attachments downloaded from the given (presigned) URLs; UTF-8 headers encoded. `inReplyToMessageId` (Gmail id, Mailbox id or `<Message-ID>`) sets `threadId`, In-Reply-To and References; `threadId` alone answers the thread's newest message. Requested labels (e.g. `PiB/Invoices`, `PiB/Sequences`, `PiB/Campaigns`) are created and added.
- A retry first looks the message up by its Message-ID, so an attempt Gmail accepted is not sent twice.
- Over the rate, Gmail down or the account needs reconnecting: nothing is stored and the sender's outbox retries. No connected account, a bad address, an expired attachment link or a message Gmail refuses: `failed` with `permanent: true`. The Sent tab retries by hand.

### Tools

Existing: `create-draft` (now takes `to`, `cc`, `bcc`, `html`, `replyToMessageId`), `send-draft` (sends through Gmail when the delegation allows it; queued for a person without a connected account), `list-inbox` (with triage), `mark-read` (also in Gmail), `list-threads`, `create-email-template`, `list-email-templates`.
New: `search-mail`, `get-message`, `correct-triage`, `mail-status`.

### Do-not-email list, leads and attachments (0.3.0)

- **Suppression.** `suppressions` (per company, address and, from 0.5.0, sender; scope `marketing` or `all`). Marketing sends (`marketing: true`) leave out every listed address and carry `List-Unsubscribe: <mailto:{from}?subject=unsubscribe>` (0.5.0: with an https one-click link first when there is one, plus `List-Unsubscribe-Post`); every send leaves out hard bounces. With nobody left the result is `failed`, `permanent: true`, with the reason and `suppressed: [{email, scope, reason}]`; recipients left out of a sent mail are kept in `send_requests.skipped`. An inbound message whose subject or first line is "unsubscribe" or "stop" suppresses the sender for marketing; a hard bounce for an address we emailed in the last 30 days suppresses it for all mail (delay and full-inbox notices do not). Both emit `contact.suppressed`; `contact.suppressed` from the CRM and Campaigns joins the list. The hourly job announces the Mailbox's own finds from the last 3 days again.
- **Leads.** A lead from a sender who is not a CRM contact goes out as `lead.captured` through the kit outbox (re-sent with backoff until the CRM answers `lead.captured.result`), with `messageId`, `accountId`, `threadId`, a Gmail `url`, and the client triage matched as `mentionsClient*` (the lead's own `clientKind`/`clientRef` stay empty: our mailboxes are our own, unless a client mail mapping files the mail under a client, 0.5.0). No reply issue opens for it; with the CRM switched off the reply issue covers it.
- **Reply issues** default to the Account Manager (kit `routeWork`). Without Jev, known leads, clients and support mail score 0.75 needs-reply, so reply issues open on the rules too.
- **Tools:** `list-mailboxes` (accounts, default sender, your delegation) and `get-attachment` (`messageId`, `attachmentId`, optional `account`): `filename`, `mime`, `bytes`, an https `url` (private R2, 15 minutes) and `text` for CSV, OFX, QIF, TXT and MT940 up to 200 KB, ready for `partnersinbiz.accounting:import-statement`. Attachment ids now show in `get-message` and `list-inbox`.
- **Setup:** one-click grants for the Account Manager (read and draft) and the Bookkeeper (read) on the default mailbox, and optional private R2.

### Tables (migrations 003–007)

`accounts` + Gmail columns (status, sealed token, `history_id`, label cache), `messages` + Gmail ids, headers, triage and send context, `send_requests`, `oauth_sessions`, `thread_issues`, the kit CRM projection, `decisions` and `inbox`; 006 adds `messages.bounce`; 007 adds `suppressions`, `send_requests.skipped` and the kit `outbox`.

### Done-check (0.4.0)

- "Reply needed" issues now use origin `mailbox:reply:<accountId>:<threadId>` (the reconnect issue `mailbox:reconnect:<accountId>`). When an agent closes a reply issue, the Mailbox checks the thread (kit `registerDoneChecks`): the newest mail that still needs a reply must have a reply draft (`create-draft` with `replyToMessageId`, also queued or sent) or a sent reply after it, or be triaged as needing none (`correct-triage` needsReply false or another category). Otherwise the issue is reopened with what is missing. A person's close is never checked; the reconnect issue has no check.
- New capability `issue.comments.create` (the reopen comment). The Mailbox owns no stage in the kit `FLOWS`, so its snapshot reports no `flows`.

## 0.5.0: closing the loops (audit 2026-10-03: RC5, Q10-7, Q1a-3, Q1a-9b, Q10-13)

Deploy: **stop-first** (migration `008` and two new capabilities: `agents.read`, `webhooks.receive`). After the deploy run the plugin's skill sync for every company (the hourly job also does it). Nothing else is required; the Mailbox's own one-click link switches on by itself once the proxy rule below exists and the check passes.

### Access that does not need asking (RC5)

The Operator's "read and draft on the mailbox" was asked five times in five days and answered each time; nothing turned the answer into a delegation.

- **A default.** When the company has an Operator (the Cockpit's roles copy) and a Gmail mailbox of its own, the Operator gets read and draft, never send, without anyone being asked. It runs when Gmail is connected, when the Cockpit announces the roles, and from the sync job (a few queries, at most every ten minutes per company). Idempotent. It never widens a delegation that exists (the live one was applied by hand) and never creates one a person removed (`delegation_removals`): only an explicit grant by a person (a click on the page, a Setup action, an answered ask) does. A mailbox that belongs to a client is never given away this way. `autoDelegate` switches it off or adds the Account Manager and Bookkeeper.
- **Removing access.** Mailboxes tab, Agents with access, Remove. The action `mailbox.remove-delegation` deletes the delegation and remembers the removal and who did it. Granting (`mailbox.create-delegation`) and removing are for a signed-in person only: the host lets any agent with company access call an action, so an agent could otherwise give itself send access or undo a person's removal.
- **An ask that does something.** The kit ask effect `mailbox.delegate` (registered in `setup`, `installAskEffects`). `list-mailboxes` gives a mailbox the agent cannot read an `askToOwner` card (question, deep link to Mailboxes, steps, `effect: { key: "mailbox.delegate", params: { accountId, agentId, scope } }`). The agent passes it to `partnersinbiz.cockpit:ask-owner` unchanged. When a person says yes the Mailbox creates the delegation, **reads it back** (a failed read-back is `failed`, never `applied`) and answers `ask.effect.result`; the Cockpit posts the comment and wakes the agent. `scope` is `read` or `read+draft` (default); **sending is never granted by an ask**. The params come from the agent that asked, so `validate` whitelists them (`accountId` an id or the address, `agentId`, `scope`; any other key is refused), the mailbox must be this company's and not disconnected, and the agent an active agent of this company (`agents.read`). A grant by an ask clears an earlier removal: the owner said yes.

### Sender domain health (Q10-7, the SPF/DKIM/DMARC finding)

`partnersinbiz.online` had no SPF record, DMARC `p=none` with no report address, a DKIM key at `default` and `resend` but none at `google`, and the first 12 sends already produced a hard bounce. Nothing checked it.

- **What is read.** Through the host's guarded `ctx.http.fetch` (capability `http.outbound`, public DNS over HTTPS: Google, then Cloudflare). Nothing writes DNS. MX; SPF with the include tree walked to count the 10 lookups SPF allows; DKIM at `google, default, selector1, selector2, resend, k1, s1, s2, mail, dkim, smtp` plus the company's `dkimSelectors`; DMARC (a subdomain falls back to the organisational domain). A lookup that fails is `unreadable`, never "missing", and the report carries the `dig` commands for the manual route. That includes a DKIM selector that could not be read when no key was found at the others, and a subdomain whose organisational domain's DMARC could not be read: either could be the very record, so neither raises a `bad`.
- **What is judged.** `bad`: no SPF, two SPF records, `+all`, SPF over 10 lookups, no DKIM key, no MX for a domain with a mailbox. `warn`: no DMARC yet, DMARC `p=none` for 30 days (counted from the older of when we first saw it and when sending began; `p=none` is the right first step), SPF without Google's include for a Gmail domain, unreadable DNS. `healthy` otherwise. `sendReady` is SPF ok, a DKIM key and a DMARC record.
- **When.** Daily job `check-domain-health` (05:17 UTC) for every sending domain: the domains of the company's mailboxes (never a free-mail domain) plus domains an agent asked to watch. Results are in `domain_checks`; the Cockpit gets one health check per domain (`mailbox:domain:<domain>`) and the Setup page an optional item.
- **Tools.** `check-sender-domain` (read DNS now, keep it, return the problems with their fixes and the **onboarding** steps: the exact records to add for a new client's domain, in order, and what is already right; DNS is edited by whoever controls the domain, so the agent hands the steps over in one ask and re-checks) and `sender-domain-health` (the last stored check, no lookup). At most 25 domains are watched on purpose.
- **The predicate other modules use.** `senderDomainHealth(store, companyId, addressOrDomain)` returns `{ domain, known, status, healthy, sendReady, reasons[], checkedAt, stale }` and **blocks nothing**: the Mailbox still sends. A marketing send from a `bad` or `warn` domain still goes out and its `mail.send.result` carries `warnings[]`. Plugins cannot call each other, so the same fact travels as the event `mail.domain.health` (`plugin.partnersinbiz.mailbox.mail.domain.health`), emitted after each check and again hourly:
  `{ key: "domain:<domain>:<checkedAt>", domain, status: "healthy"|"warn"|"bad"|"unknown", healthy, sendReady, problems: [{ code, severity, message }], checkedAt, mailboxes: [address], clientKind?, clientRef? }`. Campaigns projects it (upsert by `domain`, newest `checkedAt` wins) and refuses to launch a campaign from a domain that is not `healthy` (or not `sendReady` while the first DMARC month runs).

### Who a send is from (Q1a-3)

The Mailbox honours these `MailSendRequested` fields (kit 0.2.1) and keeps the default behaviour for a request that has none:

| Field | What the Mailbox does |
|---|---|
| `from` | the mailbox to send from (its address); the company's default account when omitted. An unknown or disconnected address is a permanent failure, never a fall back to the default |
| `fromName` | display name; wins over the mailbox's own name, which wins over the company `fromName` setting |
| `replyTo` | `Reply-To` header; dropped when it is the sending address; an unusable address is a permanent failure before anything is sent |
| `unsubscribeUrl` | https only (anything else is a permanent failure: the sender believes one-click works); see One-click unsubscribe |
| `context.clientKind/clientRef` | the client the mail is for; checked against the mailbox (below) |

A mailbox can **belong to a client** (Mailboxes tab, the account's menu: Give it to a client, or `accounts.client_kind/client_ref`). Then it sends only that client's mail, as the client (its own name), with that client's do-not-email list; a request whose context names another client, a contact where a company is expected, or none is refused for good and nothing leaves. It is never the default sender and no agent gets access to it automatically (binding a mailbox drops the access the defaults gave while it was the company's; a person's own grant stays). The leads it receives go to the CRM in the client's scope with the sender as the person. Its other mail, such as a support question, still opens a Reply-needed issue in the company's own flow: routing that into the client's own Paperclip project needs the kit's client-project routing, which the Mailbox has not adopted yet. A client's marketing sent from one of the company's own (unbound) mailboxes still goes (the Mailbox blocks nothing), but the result carries a warning: the opt-out would be recorded on the company's list, not the client's. Campaigns must send a client's marketing from the client's mailbox (kit `resolveSender` refuses otherwise). The company's own mailboxes behave as before: any sender may use them, including mail about a client (the invoiced customer in an invoice's context is not a sender scope). A draft on a client's mailbox is sent in the client's context. Binding the company's only Gmail mailbox is refused.

**The do-not-email list is per sender** (`suppressions.sender_key`: `own`, `company:<id>`, `contact:<id>`; empty for rows from before 0.5.0, which still silence everyone's marketing). An unsubscribe reply is on the list of the mailbox it arrived on (the client's, or `own`); a hard bounce (`scope all`) is per address and stops every send from every sender. `contact.suppressed` from the CRM and Campaigns keeps its `senderKey` (none: every sender, as before). The Mailbox announces its own with `senderKey` (key `suppress:<email>:<reason>`, with `:<senderKey>` appended for a client) and as `consent.recorded` (`granted: false`, source `reply` or `unsubscribe_link`).

`create-draft` takes `replyTo` and `fromName`, kept on the draft and used when it is sent.

### One-click unsubscribe (RFC 8058, Q10-7)

- **Headers.** Marketing mail with an https address carries `List-Unsubscribe: <https://...>, <mailto:...?subject=unsubscribe>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. Without an https address it is the mailto form only and no Post header (one-click needs both). Transactional mail carries neither. The address is the caller's `unsubscribeUrl`, or, with `unsubscribe.secret` set and exactly one recipient, a signed link the Mailbox makes, **only while the proxy rule is proved (below)** (kit `signUnsubscribeToken`: company, address, whose list): `<publicBaseUrl>/api/plugins/partnersinbiz.mailbox/webhooks/unsubscribe?token=<token>`.
- **The address.** The Mailbox declares the public webhook `unsubscribe`. A mail client's one-click POST (`List-Unsubscribe=One-Click`) puts the address on that sender's marketing list and announces it. A bad, missing or foreign token changes nothing and says nothing; a repeat is a no-op.
- **What the host allows.** A plugin webhook gets the request headers and body, **not the address it was posted to**, so a `?token=` query never reaches the plugin by itself (host `routes/plugins.ts`; only the `endpointKey` path segment is matched, so a token cannot live in the path either). The reverse proxy must pass the request address on as a header. The live Caddy block for `paperclip.partnersinbiz.online` becomes (the unsubscribe path gets the extra header; everything else stays as it is today):

  ```
  paperclip.partnersinbiz.online {
  	encode zstd gzip
  	@mailbox_unsub path /api/plugins/partnersinbiz.mailbox/webhooks/unsubscribe
  	handle @mailbox_unsub {
  		reverse_proxy 127.0.0.1:3100 {
  			header_up X-Forwarded-Proto {scheme}
  			header_up X-Real-IP {remote_host}
  			header_up X-Original-Uri {uri}
  		}
  	}
  	handle {
  		reverse_proxy 127.0.0.1:3100 {
  			header_up X-Forwarded-Proto {scheme}
  			header_up X-Real-IP {remote_host}
  		}
  	}
  }
  ```

  `header_up` sets the header, so a caller cannot forge it. Validate and reload Caddy (`caddy validate`, then `systemctl reload caddy`); no Paperclip restart.

  The token is read from `X-Pib-Unsubscribe-Token`, then the query of `X-Original-Uri` / `X-Forwarded-Uri`, then a `token` field in the body. Until the rule exists the endpoint finds no token and does nothing.
- **The gate (why the Mailbox does not trust the rule is there).** Without the proxy rule a one-click link is worse than none: the mail client posts, the host answers 200, the recipient is told they are unsubscribed, and nothing is recorded. So the Mailbox makes its own https link only while it has proved the rule works, and keeps proving it. The hourly job (and the Setup button **Check now**, action `mailbox.check-unsubscribe-proxy`) posts a probe to the Mailbox's own public address the way a mail client does (form body, no special headers). The probe token is signed with the company's unsubscribe secret for a reserved sender (`probe:<one-off id>`, address `proxy-check@unsubscribe-probe.invalid`), so it unsubscribes nobody and only the Mailbox, or a person handed its link, can make one. When it reaches the webhook through a header the proxy set (not the body), the webhook records the proof in company state (`mailbox-unsubscribe/proxy-proof`). The link is made only while the last proof passed and is under six hours old; a failed probe closes the gate at once. Until then marketing mail carries the mailto form only, which always works, and the Setup item reads "Not active yet" with what the check found. If the Mailbox cannot reach its own address, the action returns `probeUrl` for a person to post by hand (`curl -s -X POST -d 'List-Unsubscribe=One-Click' '<probeUrl>'`), which records the same proof. A caller's own `unsubscribeUrl` is the caller's responsibility and is not gated. The header is one unfolded line: an address over 690 characters is refused, and a link that would push the line past 998 characters is dropped for the mailto form.
- **Order of work.** (1) Add the proxy rule. (2) Set the secret and save. (3) The Mailbox tests the rule within the hour and switches the link on. The public webhook has no throttle of its own (the host records every delivery); a bad token is a constant-time HMAC check that changes nothing.

### Client mail sent to a company mailbox (Q1a-9 part b)

A client's website form BCC'd or relayed to a company mailbox was filed as the company's own lead (`clientKind` is hard-coded empty for our mailboxes), three times for AHS Law. A **mapping** (`client_mail_maps`) says whose mail it is: `sender_domain` / `sender_address` (mail FROM the client's site or system) or `recipient_domain` / `recipient_address` (mail TO the client's address or an alias we forward). A specific address beats a domain, the sender beats the recipient, a domain rule covers its subdomains; the company's own domain and free-mail domains are refused, and the client must exist in the CRM copy.

- **A match** files the message under the client (`client_kind/client_ref`, triage source `mapping`, `map_state = mapped`). A sender mapping with a visitor in `Reply-To` (the Reply-To header is now stored) makes it a **lead for that client**: `lead.captured` with `clientKind/clientRef`, `source: "form"`, the visitor as the person (no person without a Reply-To: the website's address is not one). A client's lead always goes to the CRM in the client's scope (even when the visitor is already one of our contacts) and opens no reply issue: the company does not answer a visitor of its client's website as itself. A recipient mapping keeps the sender as the person and the words decide the category. A mapping says whose mail it is, not that the sender is our client.
- **No match** changes nothing: it stays the company's own. Mail that looks like a client's (a relayed form from an automated sender, or a lead from a client's CRM domain) is flagged `needs_mapping`; `list-client-mail-maps` and the Mailboxes tab list the sender domains, the Cockpit shows a warning.
- **Adding a mapping** (`map-client-mail`, or the page) files the flagged mail of the last 30 days and re-sends those leads in the client's scope under a new outbox key `mail:<gmailId>:client:<kind>:<ref>` with `supersedes: "mail:<gmailId>"` (the CRM already stored the first as the company's own lead and decides how to merge).

### Erasure and consent (Q10-13, POPIA)

The Mailbox is a participant of the kit's erasure contract (`registerEraseReceiver`, default sender: the CRM, after one person approved). It erases every stored message to or from the address, or whose Reply-To is the address (a relayed website form holds the visitor there, with the website as sender), including headers, snippet, triage and drafts, the logged decisions, the send records' recipients, subject and body (the record itself stays, status included, so a repeated send request is still refused as a duplicate), a lead waiting in the outbox, and its copy of the CRM contact (also the contact's other addresses). The Reply-needed issue's title and description are replaced (the issue stays). It answers with counts and `retained`: a **do-not-email marker holding only a SHA-256 of the address** (the hash the CRM ledger keeps; no address, name or text) so the person is never emailed again and the sync never imports their old mail again (mail from, to, cc or Reply-To the person received before the erasure is skipped; mail they send afterwards is new), the Gmail copies (the Mailbox cannot delete Gmail mail permanently), and agents' comments on the issue. An address that is one of the company's own mailboxes is refused (it would erase the mailbox) and reported `failed`, so it stays visible on the stale-erasure check. `scope: marketing_only` erases nothing: it puts the address on the marketing list. A withdrawn marketing consent from another plugin (`consent.recorded`, `granted: false`) puts the address on that sender's marketing list; a given consent never removes anyone.

### Tools (0.5.0)

New: `check-sender-domain`, `sender-domain-health`, `map-client-mail`, `list-client-mail-maps`, `remove-client-mail-map`. Changed: `list-mailboxes` (client binding, domain health, `askToOwner`), `create-draft` (`replyTo`, `fromName`). Board actions for the page (all for a signed-in person only, because the host lets any agent with company access call an action and an action has no delegation check; agents use the tools of the same names): `mailbox.create-delegation`, `mailbox.create-account`, `mailbox.list-inbox`, `mailbox.list-threads`, `mailbox.mark-read`, `mailbox.check-unsubscribe-proxy`, `mailbox.remove-delegation`, `mailbox.set-account-client`, `mailbox.check-domain`, `mailbox.client-maps`, `mailbox.add-client-map`, `mailbox.remove-client-map`, `mailbox.crm-clients`.

### Tables (migration 008)

`delegations` + `source`, `granted_by`; `delegation_removals`; `accounts` + `client_kind`, `client_ref`, `from_name`; `suppressions` + `sender_key`, `email_hash`, `erased_at` and the primary key `(company_id, email, sender_key)` (replaces `(company_id, email)`); `messages` + `reply_to_addr`, `map_state`, `map_id`; `client_mail_maps`; `domain_checks`. 007 is untouched.

### Housekeeping

`company.created` goes through the kit's `registerCompanyBootstrap` (one handler; it also catches up a company that missed the event). The hourly job first checks the one-click unsubscribe proxy rule for every company that has the settings (see the gate), then runs `syncAllCompanies` (managed skills for every known company) and announces the domain results again. Skill text is in `skills.ts`; the sender-domain, client-mail and privacy references are the skill's files (`references/`), so the skill itself stays small.

Tests: `pnpm test` (316), `pnpm typecheck`, `pnpm build`. Mutations of the new rules (default access, removals, ask validation, per-sender suppression, scope refusal, headers, erasure including the Reply-To of a relayed form, mapping precedence, DMARC age, unreadable DNS and DKIM, token verification, the person-only actions, the unsubscribe proxy gate, header length, client-mailbox leads) were applied one by one and caught.

## 0.6.0: an email provider beside Gmail (audit Q10-7, Q1a-3, the SPF/DKIM/DMARC finding, Q10-13, Q1a-6 context)

Everything the plugins send used to leave from one Gmail account at about 20 messages a minute, with no per-client sending domain, no bounce or complaint feedback and no warm-up. 0.6.0 adds a **send-only account kind** that sends through an email provider, written against Resend's published REST API and **off until the owner switches it on and the secrets exist**. Gmail is unchanged and is still the default sender and the only inbox.

Deploy: **stop-first** (migration `009`, a second public webhook `resend`). No new capability (`http.outbound`, `webhooks.receive` and `secrets.read-ref` were already declared). After the deploy run the plugin's skill sync for every company (the hourly job also does it). Nothing changes for a company that never switches the provider on.

### What was built

| Piece | Where | What it does |
|---|---|---|
| Provider interface | `esp/types.ts` | `EmailProvider` (send, send batch, add, get, verify and list domains), the outcomes a send can have, the DNS record shape |
| Resend adapter | `esp/resend.ts` | `POST /emails` with an `Idempotency-Key`, `POST /emails/batch` (up to 100, no attachments), `POST /domains`, `GET /domains[/id]`, `POST /domains/{id}/verify`; every documented error mapped to what the sender does about it; the webhook event reader |
| Mock provider | `esp/mock.ts` | records sends, honours idempotency keys, registers domains and returns records, scripted failures. No network, no account |
| Signatures | `esp/svix.ts` | Svix `v1` verification (HMAC-SHA256 of `id.timestamp.body`, base64 key after `whsec_`, 5 minute window, constant time) |
| Rate limit and batching | `esp/limiter.ts` | a token bucket per company (Resend counts a team's requests together), `retry-after` pauses it, and an opt-in micro-batcher |
| Sending domains | `esp/domains.ts` | `add-sending-domain`, hourly verification, the exact DNS records for the owner or the client |
| The send path | `esp/send.ts`, `pick-sender.ts` | picks the account, applies the rules below, calls the provider, answers with the same `mail.send.result` |
| Webhook | `esp/webhook.ts`, `esp/events.ts` | verifies a delivery, finds its company, applies it once |
| Warm-up and reputation | `esp/warmup.ts` | the daily cap schedule, the 7-day bounce and complaint rates, the soft-bounce back-off |
| Domain health | `domain-health.ts` | a provider domain is judged on the provider's records, and the reputation problems are merged in |

### Switching it on (all one-time, all in the Setup checklist with links)

1. A Resend account (https://resend.com/signup) and an API key with **Full access** (https://resend.com/api-keys): the Mailbox adds domains as well as sending, and a sending-only key is refused for domains (401 `restricted_api_key`). Save it as a Paperclip secret and pick it under Mailbox settings, **Email provider, Resend API key**. Tick **Switch the email provider on**.
2. The webhook (https://resend.com/webhooks, Add Webhook): Endpoint URL `<publicBaseUrl>/api/plugins/partnersinbiz.mailbox/webhooks/resend`; events `email.delivered`, `email.bounced`, `email.complained`, `email.delivery_delayed`, `email.failed`, `email.opened`, `email.clicked`, `email.suppressed`, `domain.updated`. Copy its **Signing Secret** (`whsec_...`), save it as a Paperclip secret and pick it under **Resend webhook signing secret**. **Nothing is sent through the provider until this secret is saved**: without it a bounce or a complaint would be missed.
3. A sending domain. An agent (the Account Manager) runs `add-sending-domain` for a client; the result carries the exact records and who adds them. DNS is edited by the owner, or the client or their web host, never by an agent. The Setup item lists the records while a domain waits.

What the agent does after each is in each item's `agentNext`. The three items are optional: Gmail keeps working without them.

### A per-client sending domain

`add-sending-domain` (the tool, or **Add a sending domain** on the Mailboxes tab, action `mailbox.add-sending-domain`) takes `domain` (a subdomain such as `updates.client.co.za` keeps the client's reputation apart from their main mail), `fromAddress` (default `hello@<domain>`), `fromName`, `replyTo` (a send-only address has no inbox: replies go to an address somebody reads, usually the client's), `clientKind`/`clientRef`, and `region`. It:

- registers the domain at the provider (a domain the owner already added in the dashboard is adopted, never registered twice), at most 25 per company;
- creates a **send-only account** (`accounts.provider = resend`, status `pending`; `connected` once the provider verifies the domain), bound to the client when `clientRef` is given (it then sends only that client's mail, like a client's Gmail mailbox, and the opt-outs are that client's list);
- reads the DNS now and watches the domain every day from then on, judged on what the provider needs: SPF on the return-path host `send.<domain>` (an MX and a TXT), DKIM at `resend._domainkey.<domain>`, DMARC as usual. A domain no Gmail mailbox is on is not asked for an MX or an SPF of its own;
- returns `dns`: the records (type, full host, the host to type in the zone, value, priority), a DMARC record to add when the domain has none, `steps`, `whoAddsIt` and `afterwards`. **DNS is never agent-editable**: the agent puts the steps in one ask for the owner, then re-checks with `check-sender-domain`, which also asks the provider to look at the DNS again (at most every 6 hours per domain; the hourly job does it too) and marks the account `connected` when the provider says `verified`.

`list-sending-domains` shows each domain's status, whether it is ready, the records still to add, today's cap and warm-up day, and the 7-day rates. Only a person (the Mailboxes tab, action `mailbox.set-sending-domain`) can mark a domain as already established or give it a cap of its own: an agent must not lift its own limit.

### How a request reaches the provider

The contract is unchanged: `mail.send.requested` in, `mail.send.result` out, for every plugin in `MAIL_SENDERS`. Which account takes a request (`pick-sender.ts`):

| Request | Sender |
|---|---|
| names a sender (`from`) | that account, Gmail or provider. An address that is neither connected nor a provider account fails for good: it never falls back to the default |
| no `from`, nothing set up | the default Gmail account, as always |
| no `from`, **marketing for a client** that has a provider account | that account. It is never moved to another sender if it cannot send: the send fails with the reason, because a client's mail must not go out as somebody else |
| no `from`, **transactional**, `esp.prefer = transactional` | the company's own provider account (`esp.defaultFrom`, else the oldest ready one), only while it is verified, the provider answers, and its DNS is not failing. Otherwise Gmail takes it: the preference never holds an invoice back |

The provider path (`esp/send.ts`), in this order, the first rule that applies decides:

1. **Allowed to send at all**: the provider is on with the API key AND the webhook signing secret; the account is connected and its domain is `verified` at the provider; the request is for the account's client; the domain's check is not `bad` (a bad SPF or DKIM record at the provider's host holds every send back; a bad bounce or complaint record holds only marketing back). Each is a permanent failure that says what to fix; the plugin that asked hands the mail to a person. It is **never re-routed to Gmail**. Nothing here sends anything that needs approval: the Mailbox sends only what another plugin asked for after its own approval gate, or a draft whose delegation says send, and `add-sending-domain` sends nothing.
2. **The do-not-email list**, per sender, same code as Gmail.
3. **Soft-bounce back-off** (marketing): an address that soft bounced waits 6, then 24, then 72 hours. With nobody else to send to the message is deferred (the sender retries); otherwise the address is left out and the result carries a warning.
4. **An unsubscribe link** (marketing): nobody reads the inbox of a send-only address, so a `mailto` opt-out would be lost. Marketing needs an https one-click link (RFC 8058: `List-Unsubscribe` and `List-Unsubscribe-Post`): the request's `unsubscribeUrl`, or the Mailbox's own once its proxy rule is proved (see One-click unsubscribe). Without one it fails for good and says how to get one.
5. **A blind retry is bounded** (below, "Not accepted is not the same as no answer").
6. **The daily cap** (below), reserved in one SQL statement so two sends at once cannot both pass it. A marketing message with more recipients than the domain is ever handed in a day (the steady cap, or the person's own cap) can never reserve, so it fails for good and says so instead of waiting for days.
7. **The request rate** (`esp.ratePerSecond`), then the call, with a hash of the request key as the `Idempotency-Key`. After an answer that ended an attempt for good (a refused message, a domain the provider said was not verified) a retry by hand gets a new key (a generation counter kept in the send's `delivery` detail), because the provider may have kept the first key together with its answer. Attachments travel base64 inside the request across the host's worker channel, so a message through the provider carries at most 15 MB of them (Gmail allows 25): larger is refused for good with the way out (a download link, or Gmail by hand).

Provider answers: a refused message or a 422 is a permanent failure; a 403 "domain not verified" is a permanent failure and puts the domain back to `pending`; a 429 rate limit or 503 defers the send (`SendThrottled`, nothing stored, the sender's outbox retries for about three days); a refused API key or a used-up quota defers it too and shows on the Cockpit and in Setup (`EspUnavailable`); an idempotency conflict is a permanent failure.

**Not accepted is not the same as no answer.** Two kinds of "not yet" are kept apart, because only one of them can mean a message is already out:

- *Not accepted* (the API key refused, the quota used up, a rate limit, the provider not ready): the provider took nothing and holds no key for the message. It waits as long as the cause lasts, for the sender's whole retry period (about three days), and goes out when the cause is fixed. Nothing about it is "unknown".
- *No answer* (a timeout, a 5xx): the provider MAY have taken it. The send is marked (`delivery.maybeAcceptedAt`, the time of that first unanswered attempt) and retried with the same key, which the provider answers with the first result. The provider remembers a key for 24 hours, so a retry more than 20 hours after that first unanswered attempt fails for good and says to look in the provider's log (resend.com, Emails): sending it again could deliver it twice. A later refusal or deferral says nothing about the unanswered attempt, so the mark stays until the key changes (a retry by hand after a definitive answer). A claim that never settled (the worker died around the call) counts as unanswered too. A send that failed for another reason in between (the domain stopped being verified, say) keeps its mark, so a retry by hand after the window is held to it once: the person is told to look in the provider's log, the mark is cleared as they are told, and their next retry is their decision and goes. After a batch whose outcome is unknown, each message fails for good, because sending them one by one could deliver them twice.

The result is the same `mail.send.result` with `messageId` `resend:<id>` (never mistakable for a Gmail id), `provider: "resend"`, `suppressed[]` and `warnings[]` (no Reply-To, a domain warning). Replies to provider mail go to the Reply-To (the account's, or the request's `replyTo`, which wins); the Mailbox does not read them.

### The daily cap and warm-up (enforced in code)

A new domain has no reputation, and a sudden volume from one is treated as spam, so its daily cap ramps up. Day 1 is the UTC day of its first send:

| day | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14+ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| recipients | 50 | 100 | 200 | 400 | 700 | 1,000 | 1,500 | 2,000 | 3,000 | 4,000 | 5,000 | 6,000 | 8,000 | the steady cap |

The steady cap is `esp.steadyDailyCap` (default 10,000). These are deliberately below Resend's own guide for a new domain (150 to 400 a day for days 1 to 3, 700 to 2,000 for days 4 to 7): a client's list is small and a damaged domain is expensive. A domain idle for 30 days starts again at day 1. The cap counts every recipient handed to the provider that UTC day and is **enforced for marketing**: over it the send is deferred and retried, so it goes the next day. Transactional mail is counted and never held back. The Cockpit warns when a domain has used its cap.

### Bounces, complaints and reputation

Resend's webhook (`esp/webhook.ts`, `esp/events.ts`):

| Event | What the Mailbox does |
|---|---|
| `email.delivered` | counts it, forgets earlier soft bounces of the address, marks the send delivered |
| `email.delivery_delayed` | marks the send delayed (a delay is not a bounce) |
| `email.bounced`, Permanent | the address goes on the do-not-email list for **all** mail (per address, every sender) and is announced as `contact.suppressed`; counted toward the domain's bounce rate |
| `email.bounced`, Transient or Undetermined | marketing to the address waits 6, 24, then 72 hours; the third in 14 days puts it on the marketing list |
| `email.complained` | the address goes on the do-not-email list for marketing, **on the sender's list** (the client's, or the company's own, as Wave 3 built), announced as `contact.suppressed` and as a withdrawn consent; counted toward the complaint rate |
| `email.suppressed` | the provider refused an address on its own list: treated as a hard bounce |
| `email.failed` | marks the send failed; a quota reason is shown on the provider's state |
| `email.opened`, `email.clicked` | counted and noted on the send (opens are unreliable: mail clients preload them) |
| `domain.*` | the provider's status of the domain is read again |

Rules for every event: it is **applied once** (the delivery id `svix-id` and the message, kind and recipient are both recorded, so a replay and a second copy under another id change nothing; an event that fails to apply is taken back out so the provider's retry applies it); it must be about a **domain the company registered** AND **a message this Mailbox sent** (a send it recorded, or, for an event that beats the database write by a few milliseconds, the `pib_company` tag the Mailbox puts on everything it sends). The webhook is team-wide, so when the PiB web app or another app shares the provider team and a domain, its bounces and complaints arrive here too: they are acknowledged and ignored, so they cannot inflate the domain's rates, hold a client's marketing, or fill the do-not-email list with addresses that are not this company's. The day counters move last, after everything that can fail, so an event that fails halfway and is delivered again does not count twice; a message with several recipients says nothing about which one an event is about, so it suppresses nobody (marketing is one recipient per message). The webhook address is public: the Svix headers are checked for shape and age before any secret is read; the company is the one whose saved signing secret verifies (the `pib_company` tag on each message only says which to try first); a delivery that verifies for none is refused with an error (the host answers 502, records the failure, and the provider retries); the signing secret is read from the host at most once a minute per company (and a secret that could not be read at all, a dangling reference or a host error, is remembered as missing for 30 seconds, so a flood of forged deliveries or a stream of sends cannot spend the host's 30 reads a minute, which Gmail's token decryption shares). A refusal is logged at info, once a minute per reason with a count of the others.

**Reputation.** Over the last 7 UTC days, of the recipients handed to the provider, a hard bounce rate of **2%** or more and a complaint rate of **0.1%** or more are health problems on the domain (`esp_bounce_rate`, `esp_complaint_rate`): on the Cockpit, in `mail.domain.health` (so Campaigns will not launch from it), and they **hold the domain's marketing back** (transactional mail still goes) until the window clears. A rate is judged only on a sample that means something: the bounce rate from 100 recipients in the window, the complaint rate from 1,000 (on a new domain's first day, 50 recipients, one bounce would be 2% and holding a client's marketing for a week over one address would punish the client for a typo); under those samples, three hard bounces or two complaints are a problem on their own. A bounce or complaint re-judges the domain at once, not at tomorrow's check. Resend acts on its own limits (under 4% bounces and 0.08% complaints), so a domain near ours is already near its.

**Delivery results.** The send's `mail.send.result` is the single answer the senders settle on (Campaigns, CRM and Billing ignore a second result for the same key), so a later bounce is **not** sent as a second result. It is announced as `mail.delivery` (`plugin.partnersinbiz.mailbox.mail.delivery`): `{ key: "esp:<delivery id>", type: delivered | delayed | bounced | soft_bounced | complained | failed | suppressed | clicked, provider, sendKey, recipient?, at, context, bounce?: { kind, subType } }`, no message content and no link. A hard bounce or complaint reaches Campaigns and the CRM through `contact.suppressed`, as before. `mail-status` shows the delivery status and its history for a send. A plugin that wants delivered, bounced or clicked step events (Campaigns has the event kinds) can listen to `mail.delivery`; nothing needs to.

### Tools, actions, tables

New tools: `add-sending-domain`, `list-sending-domains`. Changed: `check-sender-domain` (a provider domain is judged on the provider's records and asked to verify), `list-mailboxes` (`kind`, `replyTo`, a send-only account's `problem`), `mail-status` (`provider`, `deliveryStatus`, `delivery`). Board actions: `mailbox.add-sending-domain`, `mailbox.sending-domains`, `mailbox.refresh-sending-domain`, `mailbox.set-sending-domain` (signed-in person only). `mailbox.create-account` refuses provider `resend`: a send-only account is made by adding its domain. `mailbox.set-default` refuses a send-only account too: the default mailbox is a Gmail account (invoices go through the provider with the `prefer` setting, not by making it the default). `add-sending-domain` for a domain that is the company's own refuses a client for it, instead of ignoring the client.

Migration `009`: `accounts` + `reply_to`, status `pending`, and a unique index on a company's `resend` addresses (two add-sending-domain calls for one domain at once cannot both make the account; the second is told so); `send_requests` + `provider`, `provider_message_id`, `delivery_status`, `delivery`; `esp_domains`, `esp_domain_days` (UTC day text, recipients sent and what came back), `esp_events` (deliveries seen; kept 90 days), `esp_recipient_health` (soft bounces and the back-off). Erasure removes a person's provider events and soft-bounce rows and wipes the delivery detail of their sends.

Health on the Cockpit: `mailbox:esp` (the API key refused, quota used up, the webhook secret missing, or sends out and no delivery event back in 3 days), `mailbox:esp-cap:<domain>`, and each domain's own check. Setup: three optional items (`esp_account`, `esp_webhook`, `esp_domain`).

### Limits and what is not done

- DNS is never edited by the Mailbox. A client who cannot or will not add records cannot be sent as; their mail goes from the Gmail mailbox the client has given, or by a person.
- Open and click tracking are not switched on (Resend needs a tracking subdomain verified first), so `opened` and `clicked` events only arrive if somebody enabled tracking in the Resend dashboard.
- `esp.batch` is off by default. A batch has one idempotency key; one the provider did not answer is retried once as the same batch and never message by message.
- A message to several recipients is sent as one provider message; the provider's events then name no single recipient (see above). Marketing is one recipient.
- Campaigns, CRM, Billing and Payroll need no change. Campaigns could record `mail.delivery` as delivered, bounce and click step events; the kit does not yet name the event (`MAIL_EVENTS.delivery`).
- The provider's own limits apply: 10 requests per second per team by default, and the free plan's daily quota.
- **A Resend team shared with another app.** The Mailbox acts only on messages it sent (above), but the team's 10 requests per second and its webhook list are shared, and a domain registered here and sent from by the other app too has a reputation neither side alone controls. A separate team for Paperclip keeps all of it apart (an owner decision). If two companies share one webhook signing secret, an untagged `domain.*` event is applied to only the first company whose secret verifies; the hourly refresh of pending domains covers the rest.
- **A reputation hold has no person override** (the cap does). It is judged on the last 7 days and clears itself as the bad days leave the window; the sample sizes above keep one stray bounce or complaint from tripping it.
- **A soft bounce counted by a delivery that then fails halfway** is counted again when the provider delivers it again (the day counters are not; the per-address soft-bounce count is, and the third in 14 days would come one early). Rare, and it only affects marketing to that address.
- Replies to provider mail go to the Reply-To mailbox, and a provider send carries no `threadId` or `rfc_message_id`, so a plugin that attributes replies by thread or Message-ID will not see them as replies to the campaign; that needs Campaigns to match on the Reply-To mailbox or the `mail.delivery` key.

Tests: `pnpm test` (the provider's are in `tests/esp/`), `pnpm typecheck`, `pnpm build`. The provider code is tested against the mock provider and a fake HTTP layer (every documented error answer, idempotent retry, the batch, the domain calls), the Svix scheme against an independent computation, the sender with every rule above (a replayed webhook, a bad or stale signature, a duplicate event, an unverified domain, the cap, the back-off, a bounce rate crossing 2%), and, on a real Postgres with all nine migrations (embedded-postgres; the suite skips where it is not installed), the SQL statement by statement and the worker end to end against an in-memory Resend behind the host's `ctx.http.fetch`: the owner's whole journey from nothing to mail going out as a client's own domain, five sends arriving together against a 50-recipient cap, concurrent and replayed webhook deliveries, and a check that no secret is stored, emitted or logged. Migration `009` was also applied to a restored copy of the live data with `migration-dryrun.sh`, together with an assertion file (the new tables and columns, the account status check, the one-address-per-company index and that a Gmail address is outside it, the delivery detail merging, the per-company retention delete; the same file fails when the index is taken out), and `--pending` lists only `009` as not yet applied live. 42 mutations of the new rules (the cap and its SQL, the signature check and its replay window, v0 signatures, per-sender complaints, the hard-bounce scope, the multi-recipient rule, the reputation thresholds, the unverified-domain refusal, the no-reroute rule, the retry window and idempotency key, the unsubscribe requirement, the soft-bounce back-off, the company a signature belongs to, the do-not-email erasure, the warm-up numbers) were applied one by one and each was caught by a failing test. After the independent review a second pass re-checked what changed: 47 mutations (the blind-retry window and its mark, counted from the first unanswered attempt and not from the first try; a refusal, quota or rate limit leaving no mark and not clearing one; the claim that never settled; the retry by hand; the cap ceiling; the reputation samples and floors; foreign events; the log and secret cache; the default mailbox; the own-domain refusal; the unique address index; the per-company retention and the scope of the delivery notes) were each caught, and 17 mutations of the event rules, which were reordered (the counters last), were re-run: 16 caught, and the 17th (the sender key's fall back from the account's client to the domain's) is an equivalent mutant, because a provider account and its domain are always bound to the same client.
