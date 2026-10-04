# Campaigns

Paperclip plugin `partnersinbiz.campaigns`. Themed email, SMS and WhatsApp programs that enroll contacts and send each due step by itself or open a Paperclip issue for it, as PiB or as a client.

- A campaign groups email steps that target an audience. `audienceTags` narrows which contacts are enrolled; empty means every CRM contact, which launches only when the approval said "All contacts (N)".
- A campaign is PiB's own work (no client) or a client's (`client_kind` + `client_ref`, a CRM company or contact). The Campaigns page shows own work; `/campaigns?client=company:<id>` or `?client=contact:<id>` is that client's workspace tab. A company client's campaign enrolls the contacts at that company by default (`audienceMode: client_contacts`); a contact client's enrolls that contact (`client_contact`); `tags` keeps the tag audience.
- `GET /api/plugins/partnersinbiz.campaigns/api/client-summary?companyId=&kind=&id=` returns `{ headline, stats }` (active campaigns, enrolled contacts, due steps) for the CRM client workspace.
- `request-campaign-approval` opens the launch approval (audience with its count, delivery, start, every step), for the Reviewer first when there is one, else the approver. When a person marks it done the campaign launches by itself (see 0.4.0 below); `launch-campaign` is for a paused campaign or an approved draft that did not launch.
- `pause-campaign`, `resume-campaign`, and `complete-campaign` control a running program.
- `campaign-stats` reports enrolled, running, and completed counts.

The plugin reads contacts from the CRM plugin's namespace to build the audience. Install both plugins together.

## Mailbox and Jev (0.3.0)

- **Delivery.** `delivery: issue | email` on a campaign (default `issue`). An email campaign sends each due step through the kit outbox once it is launched (the launch approval covers it; switching a draft to email after approval needs a new approval): `mail.send.requested` with key `campaigns:step:<enrollmentId>:<position>`, context kind `campaign_step`, subject and body (or HTML body) with `{{first_name}}`, `{{name}}`, `{{company}}` filled in, in the same Gmail thread as earlier steps. `mail.send.result` records a `sent` step event and moves the contact on; a permanent failure (or no answer after every retry) opens an issue, and marking it done moves the contact on. The `redeliver-mail` job re-emits unanswered requests every 5 minutes. Suppressed addresses are never emailed.
- **A/B.** Without a declared winner, contacts are split evenly between A and B (stable per contact) and keep their arm; a step without a B version sends A. `suggest-ab-winner` (and the result of `declare-ab-winner`) compares reply rates per variant with the kit `experimentVerdict` on batches of 5 sends; below 20 sends per variant it is inconclusive. A person still declares.
- **Replies.** `mail.received` is matched to an enrollment by the send context, else by the sender's CRM contact (most recently emailed enrollment first). Jev reads only the subject and snippet (≤500 chars). Above the `update` threshold: interested/question → `reply` event, stop this enrollment, follow-up issue for the campaign's creator; not now → `reply`, stop; unsubscribe/bounce → `unsubscribe`/`bounce` event, `stopEnrollmentsForContact`, address suppressed; out of office → next step 5 days later. Unsure, `other` or no Jev → `reply` event and an issue for the creator. Each message is handled once (kit `receiveOnce`).
- **Settings and capabilities.** `jev` settings block (TypeSafe key as a Paperclip secret). New capabilities: `events.emit`, `secrets.read-ref`.
- Migration `010_campaigns.sql`: `delivery`, owner and send columns, `campaign_step_events.event_type` widened to `sent`, `reply`, `bounce`, `unsubscribe` (plus `variant`, `source_key`, `meta`), a `suppressions` table, and the kit `decisions`, `inbox` and `outbox` tables. Never edit 001-010; add `011_campaigns.sql` and up.

## Launch on approval and the shared do-not-email list (0.4.0)

- **Launch on approval.** `issue.updated` on a launch approval: a person marking it done launches the campaign at once (a comment says how many were enrolled); if it cannot launch, the issue goes back to the approver with the reason and `launch_error` is kept for the page and the Cockpit. A person cancelling it refuses it: the approval is cleared and the campaign's agent gets a "Revise campaign" issue. An agent closing it goes back to a person (kit `reopenApprovalForPerson`). The `open-due-steps` job catches approvals and step issues whose events were missed.
- **Edits after asking** (steps, HTML, audience, sender, delivery, dates) cancel the pending approval (`approvalReset: true`); `set-step-html` works on drafts only.
- **Owners.** Step, reply, failed-send and revise issues go to the campaign's creator agent while it runs, else kit `routeWork(["account-manager"])` (Account Manager, Operator, owner). Step issues show the email filled in for the contact; done moves them on, cancelled stops them. `complete-step` is gone.
- **Audience guard.** Unsubscribed and bounced addresses are never enrolled, emailed or given a step issue. `startAt` delays the first step.
- **Suppression.** Campaign email is `marketing: true` (the Mailbox skips suppressed addresses and adds List-Unsubscribe). An unsubscribe reply, or `suppress-address`, emits `contact.suppressed` (scope marketing); `contact.suppressed` from the CRM and the Mailbox joins the list, stops the contact's campaigns and cancels open step issues. A Mailbox refusal carrying `suppressed` stops the contact instead of opening a send-it-yourself issue. The hourly job announces Campaigns' own unsubscribes from the last 3 days again.
- **New tools:** `stop-enrollment` (`enrollmentId`, `everyCampaign`), `suppress-address` (`email`, `reason`). Every tool parameter is described, with enums where fixed.
- **Capabilities:** `agents.read`, `issues.update`, `issue.comments.create`.
- Migration `011_campaigns.sql`: suppressions get `scope`, `source` and more reasons; campaigns get `approved_by_user_id`, `launched_at`, `launch_error`.

## Flows and done checks (0.5.0)

- **Stages.** The Cockpit snapshot carries `flows` for the campaigns flow: `campaign.draft` (drafts without a launch approval, or with a refused one), `campaign.approval` (drafts whose approval is open, or approved and launching), `campaign.running` (active campaigns; stuck = campaigns with a failed send or a send due over a day ago) and `campaign.replies` (open reply issues; stuck = open over 2 days).
- **Origin ids.** Every issue has `campaigns:<kind>:…`: `campaigns:step:<enrollment>:<position>`, `campaigns:send-failed:<enrollment>:<position>`, `campaigns:revise:<campaign>:<refused approval>`, `campaigns:reply:<enrollment>:<message>` and `campaigns:approval:<campaign>` (a person's decision). They are namespaced because the CRM also uses `reply:` and `send-failed:`.
- **Done checks** (kit `registerDoneChecks`, registered after the plugin's own `issue.updated` handler): an agent closing a step issue or "Email not sent" passes once the contact moved on or was stopped; "Revise campaign" needs the draft changed after the refusal (`campaigns.edited_at`) and a new approval; a reply needs `log-reply`, a stop after the reply, or the address suppressed. Unfinished closes reopen with what is missing; the third goes to the Operator.
- **New tool** `log-reply` (`messageId`, `outcome` `answered` | `no-reply-needed`, `note`, `mailDraftId`).
- Migration `012_campaigns.sql`: `campaigns.edited_at` and the `reply_log` table.

## Send as the client, one list per sender, texts and privacy (0.6.0)

Closes the audit findings Q1a-3 (client email), Q10-7 and Q1a-6 (SMS, WhatsApp, unsubscribe), Q1a-12 (client project) and Q10-13 (consent and erasure) on the Campaigns side. Migration `013_campaigns.sql`; stop-first deploy (new capabilities, a new migration). The host's webhook route, one front-door rule and a few Mailbox changes are listed under "Needs elsewhere" at the end.

### Who a campaign goes out as (Q1a-3)

- Before 0.6 a campaign saved `fromName`, `fromLocal` and `replyTo`, showed them to the approver and then discarded them: the mail went out from the Mailbox default account (PiB's Gmail) with no Reply-To. Now each **sender** (`own`, `company:<id>`, `contact:<id>`, the kit `senderKeyOf`) has an identity in `sender_identities`: `fromAddress` (a Mailbox account: a Gmail mailbox the client connected, or since 0.7.0 a send-only address on the client's verified sending domain), `fromName`, `replyTo`, `smsFrom`, `whatsappFrom`. Tools: `set-sender-identity`, `remove-sender-identity`, `list-sender-identities`.
- The send request carries `from`, `fromName` and `replyTo` (kit `mailSenderFields`). The campaign's own `fromName` and `replyTo` win over the identity's; `fromLocal` no longer picks anything (kept for compatibility). The Mailbox must honour them and refuse a `from` that is not a connected account (needs elsewhere).
- Own marketing without an identity still uses the default account. A client's marketing without an identity is refused at `request-campaign-approval`, at launch (the approval goes back to the person with the reason) and at every send (the step is held: nothing goes out, no issue per contact, the Cockpit goes red with `campaigns:cannot-send`). It is never sent from PiB's Gmail or number. A campaign whose delivery is `issue` (an agent sends each email by hand) needs no identity. Its step issues, and the "Email not sent" issue of a failed automatic send, carry the same text an automatic send would: the body for the contact followed by the footer (who sent it, the person's own unsubscribe link, reply STOP), and say to send it whole. The skill tells agents not to write their own opt-out line, so the footer must be in the issue; preflight warns when no link can be built (the footer then says reply STOP only).
- The approval issue states "Sent as: Name <address>, replies to ...", the audience reachable per channel, the send window, the footer that is added, and the preflight warnings. Changing an identity cancels the open approval of that sender's drafts.
- Approvals now open through the kit `openApprovalIssue` (Reviewer first, then the owner, then the Operator with a note; never unassigned). The approver is the company owner by the kit chain; the creating person is only the fallback (it used to be first). This is the one behaviour change for existing campaigns.

### One list per sender, and unsubscribing

- `suppressions` is keyed by (company, address, sender). An unsubscribe or complaint is on one sender's list: unsubscribing from a client's emails does not silence PiB's own or another client's, and stops only that sender's running campaigns for the person. A hard bounce is about the address and stops every sender. A row from before 0.6, or an event with no `senderKey`, has an empty sender and keeps blocking every sender (nobody who opted out is emailed because a sender was unknown). `suppress-address` takes `client` for the sender; without it the opt-out is for every sender. A withdrawn consent that arrives as `consent.recorded` (the Mailbox sends one for every unsubscribe, the CRM for a withdrawal) goes on the list of the sender its subject names (`senderKeyOf`: PiB's own list for a subject with no client, that client's otherwise), never on every list.
- `contact.suppressed` carries `senderKey` both ways (the kit contract); the hourly job re-announces with it. The reply path (Jev "unsubscribe") uses the campaign's own sender.
- **Footer.** Every marketing email gets who sent it, an unsubscribe link and "reply STOP". `{{unsubscribe_url}}` is a merge token for the same link. The link opens a static page, `/_plugins/<installation uuid>/ui/unsubscribe.html?t=<token>`, that asks the person to confirm (a mail scanner opening it unsubscribes nobody) and posts the token to the plugin's `unsubscribe` webhook. The token is the kit's signed unsubscribe token (company, address, sender) made with a per-company secret the plugin generates and keeps in its own state; the webhook never creates a secret, refuses every bad token with one message, and repeats are harmless. It needs the **Public base URL** setting and the Campaigns page opened once (the plugin learns its UI path then).
- **One-click (RFC 8058).** `unsubscribeUrl` is put on the send request, and so the Mailbox adds `List-Unsubscribe-Post`, only when the **One-click unsubscribe address** setting is saved. The host's webhook route is public but takes only JSON, drops the query string and answers `{ deliveryId, status }`, so it cannot carry a per-person address by itself. A front-door rule forwards a mail client's POST to `/u?t=<token>` to the webhook with the token in the `X-Unsubscribe-Token` header (the handler reads that header, then the JSON body). The rule for the live Caddyfile (not run against it; check with `caddy validate`):

```
paperclip.partnersinbiz.online {
	encode zstd gzip
	@unsubscribe path /u
	handle @unsubscribe {
		@post method POST
		route @post {
			request_header X-Unsubscribe-Token {http.request.uri.query.t}
			rewrite * /api/plugins/partnersinbiz.campaigns/webhooks/unsubscribe
			reverse_proxy 127.0.0.1:3100 {
				header_up X-Forwarded-Proto {scheme}
				header_up X-Real-IP {remote_host}
			}
		}
		respond "Use the unsubscribe link in your email." 405
	}
	reverse_proxy 127.0.0.1:3100 { ... the existing block ... }
}
```

  Then save `https://paperclip.partnersinbiz.online/u` as the one-click address in the Campaigns settings. Until then the footer link, reply STOP and the Mailbox's mailto header work, and preflight warns.
- The host keeps the headers and body of every webhook delivery in its own `plugin_webhook_deliveries` table, which a plugin cannot prune: the unsubscribe token (so the address in it), a forwarded reply's JSON and the plain `x-pib-webhook-secret` header of the `messaging-inbound` webhook all land there. Prune it from the VPS janitor (rows older than 30 days), and rotate the inbound secret if that table ever leaks.
- **Opens and clicks are not captured, on purpose.** A tracking pixel needs a public GET that answers with an image, and click tracking needs a GET that redirects to a checked address; the host's public routes are POST-only JSON and static files, and a redirect page that trusts an unchecked address in the URL would be an open redirect on our domain. Replies, bounces, unsubscribes, SMS delivery results and `record-step-event` for a real report are captured.

### Preflight

`preflight-campaign` (tool) runs the same checks `request-campaign-approval` runs (and the launch re-runs without the web): every step complete and its merge tokens known; a client has its own sender; the Mailbox is on; each text channel is configured and has a number; a client's email can carry an unsubscribe link (error), PiB's own warns; the sender's domain health when the Mailbox has reported it (events `mail.domain.health` and `sender.health`: bad blocks for a domain only the email provider sends from, a warning for a domain with a Gmail mailbox on it; unknown warns); links are https, not test or private addresses, and answer (404 or an unknown host is an error, a site that blocks robots a warning; up to 12 links through the host's SSRF-guarded fetch); SMS parts and characters that force UCS-2; WhatsApp templates; and who can receive each channel (nobody is an error). Errors block the request, warnings go to the approver.

### SMS and WhatsApp (Q10-7, Q1a-6)

- A step has a `channel` (`email` default, `sms`, `whatsapp`); WhatsApp steps may carry `templateRef` (a Twilio Content SID) and `templateVars`. SMS and WhatsApp need the campaign's delivery `auto` (every step goes out by itself on its channel); `email` stays email-only; `issue` stays a task per step. A later step on another channel is skipped for a contact it cannot reach.
- `MessagingProvider` is the interface (`send`, `inbound`, `statuses`). `TwilioProvider` is the real adapter written against the documented Programmable Messaging REST API; it is **off until the company saves the account SID, an auth token secret and a sender number** in the Campaigns settings (`messaging` block). Setup shows the owner steps with deep links (create the account, find the SID and token, store the token as a Paperclip secret, buy or register a number, register the WhatsApp sender and templates); account creation is a person's job, never the plugin's. Tests use a mock provider; nothing touches the network. A launch refuses a channel that is not configured and the Cockpit shows an active campaign that cannot send.
- **Opt-in.** SMS and WhatsApp marketing reaches only people with a granted opt-in for that sender and channel (`channel_consents`): `record-channel-consent` (agents, evidence required) or the kit's `consent.recorded` (SMS). Email stays opt-out. An agent's typed-in evidence cannot be checked, so the approval says how many of the reachable opt-ins were recorded by an agent (not a form or an import) and tells the approver to ask to see the evidence.
- **Opt-out.** STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, OPTOUT and sentences that plainly ask to stop (never a word inside another sentence) put the number on that sender's do-not-message list, stop that sender's running campaigns for the person, cancel their open step issues and announce a withdrawn consent. START and UNSTOP lift only the person's own opt-out and record a new opt-in; a block a person set stays. A STOP to a number the plugin does not know stops every sender. A STOP or START to a client's number is announced to the CRM as that client's consent (the subject carries the client), never as PiB's own. Twilio's own block (error 21610) is recorded the same way. `suppress-phone` covers an opt-out said any other way.
- **Replies** are read by the `poll-messaging` job every 10 minutes (`GET Messages.json` for the company's numbers; the host's webhook route cannot take Twilio's form posts, so STOP works without a public endpoint). The `messaging-inbound` webhook takes the same message as JSON (Twilio Studio or a Function can forward it) with a shared secret of at least 16 characters in `x-pib-webhook-secret`; without a secret saved nothing is accepted. A reply opens the same "Reply from" issue as an email reply, with the message in it; the plugin cannot answer a text. A reply belongs to the campaign of the number that was texted: someone texted by a client who answers PiB's own number (or the reverse) is not answering the other sender's campaign. The read window only moves forward (five minutes of overlap, repeats skipped); a read that returns as many messages as the provider lets one poll read (500 per number) is logged as possibly incomplete, and Twilio still blocks a recipient who replied STOP. A Messaging Service alone sends but reads no replies (they are read on a number): Setup says so.
- **Send window.** SMS and WhatsApp marketing is sent only inside Mon-Fri 08:00-20:00 and Sat 09:00-13:00 in the company timezone, never on a Sunday (South African direct marketing rules); the `messaging` settings change the hours and list public holidays. A step outside the window is put back to the next opening.
- **Length.** GSM-7 160 / 153 per part, UCS-2 70 / 67 (one smart quote or emoji switches the whole message); preflight warns above 3 parts and refuses over 1,600 characters. Every text ends "Reply STOP to opt out." unless the step already tells the reader to send STOP ("Reply STOP to unsubscribe", "Text STOP"); copy that only contains the word ("Stop paying too much", "next to the bus stop") still gets the line, and so does a WhatsApp template check (a template without the instruction is a warning).
- **At most once.** The `channel_messages` row is written before the provider is called. A send whose outcome is unknown (no answer, a 5xx, a crash between the row and the answer) is recorded `unknown` and handed to a person; only a "not accepted, try later" answer (429, 503) or a request that provably never left (no DNS answer, connection refused, a bad certificate) is retried, five times ten minutes apart. A refused account or sender leaves the step due and turns the Cockpit red (`campaigns:messaging`). After three failures in a row for a company (no answer, a refused account, a rate limit; failures more than ten minutes apart do not add up) the provider is left alone for ten minutes and the due steps wait untouched, so an outage opens at most a few issues and a refused account is not asked for every contact every five minutes. Delivery results are read newest first, so messages a carrier never confirms cannot crowd out newer ones. Delivery results (delivered, undelivered, failed) are read from the provider and recorded as step events; a number the carrier says is unreachable is not tried again.
- If Twilio's South African coverage does not suit, another gateway is one more `MessagingProvider`.

### Client project routing (Q1a-12, Q9-1 context)

The plugin declares a managed **Campaigns** project (`projects.managed`) and calls `registerClientProjectWatch`; every issue it opens (step, reply, failed send, revision, approval) goes through `resolveClientProjectId`: the project the CRM linked to the client (event `client.projects.updated`, the CRM builder emits it), else the managed Campaigns project; own work uses the managed project. A linked project that no longer exists or is archived is skipped (`projects.read`).

### Consent and erasure (Q10-13, Campaigns side)

- `registerConsentReceiver`: `consent.recorded` stores opt-ins per sender (a client in the subject is that client's list) and ignores an older record; a withdrawal puts the address or number on the list of that same sender (PiB's own for a subject with no client), so a client's unsubscribe does not silence PiB or another client.
- `registerEraseReceiver`: `contact.erase.requested` (the kit receiver refuses it without an approving person and never runs it twice) removes the person's enrollments, step events, reply log, mail send requests, text messages and consents, blanks the plugin's projected copy of the contact, and clears the name and message text from their step, reply and failed-send issues (cancelled, kept). Their do-not-contact entries stay as a one-way hash (still blocking; an entry that would collide with a hash entry from an earlier erasure folds into it, the wider scope winning) and agents' issue comments stay (a plugin cannot edit them): both are reported as `retained`. `marketing_only` only adds the opt-outs and stops the campaigns.

### Other changes

- `registerCompanyBootstrap` replaces the hand-written `company.created` handler (skills, Campaigns project); the hourly `setup-status` job also runs `syncAllCompanies`; the Cockpit snapshot adds `skillSyncCheck`, `campaigns:cannot-send`, `campaigns:unsubscribe`, `campaigns:messaging*` and the `poll-messaging` job.
- Setup items: public address, one-click unsubscribe, client senders, Twilio, SMS sender, WhatsApp sender and templates (all optional, none blocks PiB's own email).
- Campaign detail shows who it goes out as, each step's channel and the checks; the add-step dialog has a channel.
- Capabilities added: `webhooks.receive`, `http.outbound`, `projects.read`, `projects.managed`. The only core tables read are still `issues` and `heartbeat_runs`.
- The test `mail.spec.ts` that hard-coded a date (it failed from 2026-10-03) now computes it.

### Settings

`publicBaseUrl`, `oneClickUnsubscribeUrl`, and the `messaging` block: `accountSid`, `authToken` (secret), `smsFrom`, `messagingServiceSid`, `whatsappFrom`, `defaultCountry` (+27), `weekdays`, `saturday`, `sunday`, `blackoutDates`, `inboundWebhookSecret` (secret).

### Needs elsewhere

- **Mailbox:** done in Mailbox 0.5.0 and 0.6.0 (`from`, `fromName`, `replyTo`, the headers, `senderKey`). It announces `mail.domain.health` (one event per sending domain), not the `sender.health` this section first asked for; Campaigns reads both since 0.7.0.
- **CRM:** emit `client.projects.updated`; be the erasure originator and publish `consent.recorded`.
- **VPS ops:** the Caddy rule above; prune `plugin_webhook_deliveries` older than 30 days.

## What the email provider reports, replies to provider sends, and send-only senders (0.7.0)

Finishes the Campaigns side of the Mailbox's email provider (Mailbox 0.6.0 and 0.6.1, Wave 4 and 5 of the 2026-10-03 audit, Q10-7 and Q1a-3). Migration `014_campaigns.sql`. **Deploy: stop-first** because of the migration (no new capability, no new core table). The contract with the Mailbox stays `mail.send.requested`; **with the provider off Campaigns works exactly as before** (Gmail sends report none of this, and no `mail.delivery` event arrives).

### Delivery reports (`mail.delivery`, `src/delivery.ts`)

The Mailbox announces what became of an email the provider took (kit `MAIL_EVENTS.delivery`, type `MailDelivery`). Campaigns listens, reads only its own sends (context `campaign_step` of this plugin, key `campaigns:step:<enrollment>:<n>`; another plugin's mail and a malformed event are ignored and store nothing) and records a **step event** per send and kind:

| Report | Step event | What else |
|---|---|---|
| `delivered` | `delivered` | |
| `opened`, `clicked` | `open`, `click` | counted once per send (a mail client may preload a pixel, a person may click twice); they exist only when somebody switched tracking on for the domain at the provider, which the Mailbox never does |
| `bounced` (hard) | `bounce` (`bounceKind` hard, `bounceSubType`) | the address goes on the do-not-email list for **every sender** (a hard bounce is about the address), reason `bounce`, source the Mailbox, and the contact's running campaigns stop |
| `suppressed` | `bounce` | the provider refused an address on its own list: the same as a hard bounce |
| `complained` | `complaint` | the address goes on **this client's** marketing list (the sender's: the client's, or PiB's own), reason `complaint`; only that sender's campaigns stop for the person |
| `soft_bounced` | `soft_bounce` | nothing is suppressed: the address may work next time (the Mailbox backs it off itself) |
| `failed` | `failed` | the provider could not send it |
| `delayed` | none | a delay is not an outcome |

**Idempotency, the same discipline as `mail.send.result` and `mail.received`:** the report is handled once per its key (`esp:<delivery id>`, kit `receiveOnce`, answered from the `inbox` table on a repeat); a step event is written once per `source_key` `delivery:<kind>:<send key>`, so the same fact under another delivery id changes nothing; the do-not-email row is written once per (company, address, sender) (`ON CONFLICT DO NOTHING`), so a redelivered report, the same bounce under a new id, or the Mailbox's own `contact.suppressed` for the same bounce (it always sends one, before or after the report) adds nothing. A report whose recipient is not the address the campaign emailed changes the numbers and suppresses nobody. A failure is logged, nothing is stored, and the event handler never throws into the host; the Mailbox's hourly re-announcement of its own suppressions still reaches the list.

**Reporting.** `campaign-step-analytics` gives per step: `sent`, `delivered`, `replies`, `bounces` (hard), `softBounces`, `complaints`, `unsubscribes`, `opens`, `clicks`. The overview's event totals carry `delivered`, `complaints` and `softBounces`, and the Bounce-rate card says what the provider reported ("From the email provider: 12 delivered, 1 complaint"). For Gmail sends delivered, soft bounces, complaints, opens and clicks are 0 (Gmail reports none of them): replies, hard bounces and unsubscribes are captured as before.

### Replies to a provider send

A provider send has no Gmail `threadId` or Message-ID the Mailbox knows, and its replies go to the **Reply-To mailbox**, so the Mailbox cannot link a reply to the send. Each `sent` step event now keeps what is needed to do it here: the **Reply-To** the message carried (the Mailbox says so in `mail.send.result.replyTo`, kit 0.2.2; else the campaign's own), the address it went to, the subject and the provider. A reply (`mail.received`) is attributed in this order, and the first that applies wins:

1. **The send context the Mailbox linked** (a Gmail reply in the same thread): unchanged. The reply event records `matchedBy: send-context`.
2. **The Reply-To mailbox plus the send** (`matchByReplyTo`): the reply arrived at a mailbox that is the send's Reply-To (its account or any recipient), from the person the email went to, within 90 days, sent before it arrived (5 minutes of clock skew allowed). Of several such sends the newest wins, and among those the one whose subject the reply carries (`Re:`, `Fwd:` and spacing ignored). The reply event records `matchedBy: reply-to` and the send's key (`sendKey`), so the attribution can be checked. The lookup is the partial index `step_events_sent_to` of migration 014.
3. **The sender's CRM contact** (their most recently emailed enrollment, else their newest running one): the old fallback, `matchedBy: contact`.

A reply that arrives at a mailbox the Mailbox does not read (a Reply-To that is not one of the company's connected Gmail mailboxes) is never seen at all: set a Reply-To somebody connected to the Mailbox reads. A send-only address has no inbox, and the preflight says so.

### A send-only address as the sender

`fromAddress` may be a connected Gmail mailbox or a send-only address on a verified sending domain of the provider (Mailbox `add-sending-domain`, `list-mailboxes`, `list-sending-domains`). The Mailbox refuses any other address and never falls back for a client. What changed here: the tool descriptions, the Setup item ("Give the client a sending account": connect their Gmail, or add their sending domain, whose DNS records go to the owner or the client's web host), the "Email through the Mailbox" delivery label, the Cockpit fix text and the page banner ("PiB's own emails can't go out: Gmail isn't connected": a client with its own sending domain does not need PiB's Gmail), none of which assumes a Gmail account any more. The no-reply-to warning now says a send-only address has no inbox.

**Domain health.** The Mailbox never sent `sender.health`; it announces `mail.domain.health` per domain. Campaigns now keeps it (newest `checkedAt` wins) and the preflight reads it for the domain of the address the campaign goes out from: a domain **only the provider sends from** reported bad (SPF or DKIM at the provider's records wrong, or a bounce or complaint rate over the limit: the Mailbox holds that domain's marketing back) blocks the approval and the launch; a domain with a Gmail mailbox on it reported bad stays a warning to the approver (the Mailbox still sends from it, as before this event was read); healthy but not send-ready (the first month of DMARC) is a warning; unknown stays a warning. When a person lifts a reputation hold on the Mailbox page the Mailbox announces the domain healthy again at once and the block goes.

### Tests

`pnpm test` (419): `delivery.spec.ts` (the payload, every type, redelivery, the Mailbox's own suppression in both orders, scoped stops, foreign events, a failing database), `delivery.pg.spec.ts` (migration 014 and the delivery handler, the counts and the reply lookup against a real Postgres with all 14 migrations, and that the lookup uses the new index), `provider-replies.spec.ts`, `domain-health.spec.ts`, plus the changed series, manifest and setup tests. 40 mutations (the receiveOnce, the step event key and the kind in it, the scope, sender and reason of each suppression, soft bounces, the recipient check, the context and foreign-event checks, the listener wiring, every reply-attribution rule and its order against the Gmail path, the domain-health rules, the counts, the migration's kinds and index, and the kit's contract tests) were applied one by one and each was caught by a failing test; the two company guards in the delivery handler each survive alone because the other covers them, and are caught when both are removed.

### Needs elsewhere

None. Opens and clicks stay at 0 unless somebody switches tracking on for the domain in the provider's dashboard; nothing here does.
