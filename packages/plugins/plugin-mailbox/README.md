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
| `triageIssueAssignee` | optional agent id (or `user:<id>`): one "Reply needed" issue per thread for leads, clients and support that need a reply |
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

### Tables (migrations 003–006)

`accounts` + Gmail columns (status, sealed token, `history_id`, label cache), `messages` + Gmail ids, headers, triage and send context, `send_requests`, `oauth_sessions`, `thread_issues`, the kit CRM projection, `decisions` and `inbox`; 006 adds `messages.bounce`.
