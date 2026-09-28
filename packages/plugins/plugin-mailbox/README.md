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

- **Suppression.** `suppressions` (per company and address, scope `marketing` or `all`). Marketing sends (`marketing: true`) leave out every listed address and carry `List-Unsubscribe: <mailto:{from}?subject=unsubscribe>`; every send leaves out hard bounces. With nobody left the result is `failed`, `permanent: true`, with the reason and `suppressed: [{email, scope, reason}]`; recipients left out of a sent mail are kept in `send_requests.skipped`. An inbound message whose subject or first line is "unsubscribe" or "stop" suppresses the sender for marketing; a hard bounce for an address we emailed in the last 30 days suppresses it for all mail (delay and full-inbox notices do not). Both emit `contact.suppressed`; `contact.suppressed` from the CRM and Campaigns joins the list. The hourly job announces the Mailbox's own finds from the last 3 days again.
- **Leads.** A lead from a sender who is not a CRM contact goes out as `lead.captured` through the kit outbox (re-sent with backoff until the CRM answers `lead.captured.result`), with `messageId`, `accountId`, `threadId`, a Gmail `url`, and the client triage matched as `mentionsClient*` (the lead's own `clientKind`/`clientRef` stay empty: our mailboxes are our own). No reply issue opens for it; with the CRM switched off the reply issue covers it.
- **Reply issues** default to the Account Manager (kit `routeWork`). Without Jev, known leads, clients and support mail score 0.75 needs-reply, so reply issues open on the rules too.
- **Tools:** `list-mailboxes` (accounts, default sender, your delegation) and `get-attachment` (`messageId`, `attachmentId`, optional `account`): `filename`, `mime`, `bytes`, an https `url` (private R2, 15 minutes) and `text` for CSV, OFX, QIF, TXT and MT940 up to 200 KB, ready for `partnersinbiz.accounting:import-statement`. Attachment ids now show in `get-message` and `list-inbox`.
- **Setup:** one-click grants for the Account Manager (read and draft) and the Bookkeeper (read) on the default mailbox, and optional private R2.

### Tables (migrations 003–007)

`accounts` + Gmail columns (status, sealed token, `history_id`, label cache), `messages` + Gmail ids, headers, triage and send context, `send_requests`, `oauth_sessions`, `thread_issues`, the kit CRM projection, `decisions` and `inbox`; 006 adds `messages.bounce`; 007 adds `suppressions`, `send_requests.skipped` and the kit `outbox`.

### Done-check (0.4.0)

- "Reply needed" issues now use origin `mailbox:reply:<accountId>:<threadId>` (the reconnect issue `mailbox:reconnect:<accountId>`). When an agent closes a reply issue, the Mailbox checks the thread (kit `registerDoneChecks`): the newest mail that still needs a reply must have a reply draft (`create-draft` with `replyToMessageId`, also queued or sent) or a sent reply after it, or be triaged as needing none (`correct-triage` needsReply false or another category). Otherwise the issue is reopened with what is missing. A person's close is never checked; the reconnect issue has no check.
- New capability `issue.comments.create` (the reopen comment). The Mailbox owns no stage in the kit `FLOWS`, so its snapshot reports no `flows`.
