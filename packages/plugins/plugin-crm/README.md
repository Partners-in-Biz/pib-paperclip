# CRM

Paperclip plugin `partnersinbiz.crm`. Companies, contacts, deals, and sequences live in this plugin's Postgres schema. The Paperclip company remains the workspace.

Install from this package after `pnpm build`:

```bash
paperclipai plugin install /absolute/path/to/packages/plugins/plugin-crm
```

Agents use the managed skills `crm-records` and `crm-outbound`. A due sequence step opens a Paperclip issue. Won or lost stops running enrollments for that contact.

## Client workspace

`/crm?client=company:<id>` or `/crm?client=contact:<id>` opens that client's workspace (Open on a company or contact in the list goes there). The Overview has editable details (`crm.update-company` / `crm.update-contact`, which broadcast CRM change events), linked people or companies, deals, activity, contact tools, and one card each for Social, SEO, Campaigns and Billing. Each card reads `GET /api/plugins/<pluginKey>/api/client-summary?companyId=&kind=&id=` (`{ headline, stats[] }`) and shows only an Open link when that plugin does not answer. The page loads through the `crm.client-workspace` action, which returns `found: false` for an unknown, deleted or hidden id.

## Mailbox and Jev (0.3.0)

- **Replies.** The CRM listens to the Mailbox's `mail.received`. The sender is matched to a contact (the reply's sequence context first, then the email address, oldest contact first) and the email is logged as an `email_received` activity with the Gmail ids. When the contact is in a running sequence, Jev reads only the subject and snippet (≤500 chars) and picks `interested`, `question`, `not_now`, `unsubscribe`, `out_of_office`, `bounce` or `other`. Above the `update` threshold (0.7) the CRM acts: interested/question stop the sequence and open a follow-up issue for the contact's agent or owner; not now stops it and sets an email next action in 30 days; unsubscribe stops every sequence, tags the contact and sets `email_status = unsubscribed`; out of office moves the next step 5 days; bounce stops and sets `bounced`. Below the threshold, for `other`, or without Jev, the owner gets an issue to decide. Each message is handled once (kit `receiveOnce`).
- **Lead score.** After a contact is created or updated, and from `score-contact` / "Score this contact", one Jev call scores fit, intent and urgency (levels 0-3, rubrics for an SA digital agency's ideal client) from the name, role, company, lifecycle, tags and the last three activity snippets (≤800 chars). The levels are stored on the contact and shown in its workspace. The 0-100 rule score stays as the fallback.
- **Email sequences.** A sequence's `delivery` is `issue` (default) or `email`. The first switch to email opens an approval issue; nothing is emailed until a board user marks it done. A due step is then sent through the kit outbox as `mail.send.requested` (key `crm:seq:<enrollmentId>:<step>`, context kind `sequence_step`, title = subject, body with `{{first_name}}`, `{{name}}`, `{{company}}`). `mail.send.result` moves the contact on; a permanent failure (or no answer after every retry) opens an issue, and marking it done moves the contact on. The `redeliver-mail` job (every 5 minutes) re-emits unanswered requests. Bounced and unsubscribed contacts are never emailed.
- **Settings.** `jev` (TypeSafe key as a Paperclip secret; empty = rules only) and `mailFrom` (optional Mailbox address). Capability `secrets.read-ref` is new.
- Migration `005_crm.sql` adds these columns plus the kit `decisions`, `inbox` and `outbox` tables. Never edit 001-005; add `006_crm.sql` and up.
