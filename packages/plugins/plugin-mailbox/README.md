# Mailbox

Paperclip plugin `partnersinbiz.mailbox`. Accounts keep credential secret refs. A delegation lets an agent read or draft. Sending stays off unless that delegation says send.

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

