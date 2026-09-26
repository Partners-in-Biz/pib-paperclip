# Campaigns

Paperclip plugin `partnersinbiz.campaigns`. Themed email programs that enroll contacts and open a Paperclip issue for each due step.

- A campaign groups email steps that target an audience. `audienceTags` narrows which contacts are enrolled; empty means every visible contact.
- A campaign is PiB's own work (no client) or a client's (`client_kind` + `client_ref`, a CRM company or contact). The Campaigns page shows own work; `/campaigns?client=company:<id>` or `?client=contact:<id>` is that client's workspace tab. A company client's campaign enrolls the contacts at that company by default (`audienceMode: client_contacts`); a contact client's enrolls that contact (`client_contact`); `tags` keeps the tag audience.
- `GET /api/plugins/partnersinbiz.campaigns/api/client-summary?companyId=&kind=&id=` returns `{ headline, stats }` (active campaigns, enrolled contacts, due steps) for the CRM client workspace.
- `launch-campaign` enrolls matching contacts (read from the CRM plugin) and opens the first step's issue. A person sends the email and marks the issue done.
- `pause-campaign`, `resume-campaign`, and `complete-campaign` control a running program.
- `campaign-stats` reports enrolled, running, and completed counts.

The plugin reads contacts from the CRM plugin's namespace to build the audience. Install both plugins together.

## Mailbox and Jev (0.3.0)

- **Delivery.** `delivery: issue | email` on a campaign (default `issue`). An email campaign sends each due step through the kit outbox once it is launched (the launch approval covers it; switching a draft to email after approval needs a new approval): `mail.send.requested` with key `campaigns:step:<enrollmentId>:<position>`, context kind `campaign_step`, subject and body (or HTML body) with `{{first_name}}`, `{{name}}`, `{{company}}` filled in, in the same Gmail thread as earlier steps. `mail.send.result` records a `sent` step event and moves the contact on; a permanent failure (or no answer after every retry) opens an issue, and marking it done moves the contact on. The `redeliver-mail` job re-emits unanswered requests every 5 minutes. Suppressed addresses are never emailed.
- **A/B.** Without a declared winner, contacts are split evenly between A and B (stable per contact) and keep their arm; a step without a B version sends A. `suggest-ab-winner` (and the result of `declare-ab-winner`) compares reply rates per variant with the kit `experimentVerdict` on batches of 5 sends; below 20 sends per variant it is inconclusive. A person still declares.
- **Replies.** `mail.received` is matched to an enrollment by the send context, else by the sender's CRM contact (most recently emailed enrollment first). Jev reads only the subject and snippet (≤500 chars). Above the `update` threshold: interested/question → `reply` event, stop this enrollment, follow-up issue for the campaign's creator; not now → `reply`, stop; unsubscribe/bounce → `unsubscribe`/`bounce` event, `stopEnrollmentsForContact`, address suppressed; out of office → next step 5 days later. Unsure, `other` or no Jev → `reply` event and an issue for the creator. Each message is handled once (kit `receiveOnce`).
- **Settings and capabilities.** `jev` settings block (TypeSafe key as a Paperclip secret). New capabilities: `events.emit`, `secrets.read-ref`.
- Migration `010_campaigns.sql`: `delivery`, owner and send columns, `campaign_step_events.event_type` widened to `sent`, `reply`, `bounce`, `unsubscribe` (plus `variant`, `source_key`, `meta`), a `suppressions` table, and the kit `decisions`, `inbox` and `outbox` tables. Never edit 001-010; add `011_campaigns.sql` and up.
