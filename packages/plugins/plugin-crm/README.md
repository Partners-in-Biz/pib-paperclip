# CRM

Paperclip plugin `partnersinbiz.crm`. Companies, contacts, deals, and sequences live in this plugin's Postgres schema. The Paperclip company remains the workspace.

Install from this package after `pnpm build`:

```bash
paperclipai plugin install /absolute/path/to/packages/plugins/plugin-crm
```

Agents use the managed skills `crm-records` (finding clients, records, the client lifecycle) and `crm-outbound` (leads, sequences, marketing email rules). A due sequence step opens a Paperclip issue; marking it done moves the contact on. Won or lost stops running enrollments for that contact.

## Client workspace

`/crm?client=company:<id>` or `/crm?client=contact:<id>` opens that client's workspace (Open on a company or contact in the list goes there). The Overview has editable details (`crm.update-company` / `crm.update-contact`, which broadcast CRM change events), linked people or companies, deals, activity, contact tools, and one card each for Social, SEO, Campaigns and Billing when that module is installed. Each card reads `GET /api/plugins/<pluginKey>/api/client-summary?companyId=&kind=&id=` (`{ headline, stats[] }`) and shows only an Open link when that plugin does not answer. The page loads through the `crm.client-workspace` action, which returns `found: false` for an unknown, deleted or hidden id.

- **Locks.** Each detail and client profile field has a lock: locked means only people change it (agents may still fill it while empty). Record fields go through `crm.set-human-owned`; profile fields through `crm.update-client-profile` with `humanOwned` (a person's list; agents cannot send it). A person's profile edit locks that field.
- **Deal drawer** (Deals tab and client pages): `crm.update-deal` changes the title, value, currency, the client links (`companyRecordId`, `contactId`; empty unlinks) and the stage (a move, with won and lost doing what `move-deal` does). Linking the client of a deal that was won without one runs the won hand-off then. "Draft a quote" opens Billing's quotes for the deal's client. Agents have the same as the `update-deal` tool.
- **Sequence drawer:** `crm.sequence-detail` returns the steps and who is enrolled (with a waiting step's open issue). Switching to email delivery is disabled, with the reason, while the Mailbox has no connected Gmail (read from the Mailbox's `setup-status`).

## Mailbox and Jev (0.3.0)

- **Replies.** The CRM listens to the Mailbox's `mail.received`. The sender is matched to a contact (the reply's sequence context first, then the email address, oldest contact first) and the email is logged as an `email_received` activity with the Gmail ids. When the contact is in a running sequence, Jev reads only the subject and snippet (≤500 chars) and picks `interested`, `question`, `not_now`, `unsubscribe`, `out_of_office`, `bounce` or `other`. Above the `update` threshold (0.7) the CRM acts: interested/question stop the sequence and open a follow-up issue for the contact's agent or owner; not now stops it and sets an email next action in 30 days; unsubscribe stops every sequence, tags the contact and sets `email_status = unsubscribed`; out of office moves the next step 5 days; bounce stops and sets `bounced`. Below the threshold, for `other`, or without Jev, the owner gets an issue to decide. Each message is handled once (kit `receiveOnce`).
- **Lead score.** After a contact is created or updated, and from `score-contact` / "Score this contact", one Jev call scores fit, intent and urgency (levels 0-3, rubrics for an SA digital agency's ideal client) from the name, role, company, lifecycle, tags and the last three activity snippets (≤800 chars). The levels are stored on the contact and shown in its workspace. The 0-100 rule score stays as the fallback.
- **Email sequences.** A sequence's `delivery` is `issue` (default) or `email`. The first switch to email opens an approval issue; nothing is emailed until a board user marks it done. A due step is then sent through the kit outbox as `mail.send.requested` (key `crm:seq:<enrollmentId>:<step>`, context kind `sequence_step`, title = subject, body with `{{first_name}}`, `{{name}}`, `{{company}}`). `mail.send.result` moves the contact on; a permanent failure (or no answer after every retry) opens an issue, and marking it done moves the contact on. The `redeliver-mail` job (every 5 minutes) re-emits unanswered requests. Bounced and unsubscribed contacts are never emailed.
- **Settings.** `jev` (TypeSafe key as a Paperclip secret; empty = rules only) and `mailFrom` (optional Mailbox address). Capability `secrets.read-ref` is new.
- Migration `005_crm.sql` adds these columns plus the kit `decisions`, `inbox` and `outbox` tables. Never edit 001-006; add `007_crm.sql` and up.

## The Account Manager and hand-offs (0.4.0)

- **Account Manager.** The CRM staffs the kit team role `account-manager` (hired in Setup → Team through `crm.hire-options`, `crm.start-hire`, `crm.link-agent`, `crm.unlink-agent`, `crm.resync-agent`). Linking merges plugin tool access into the agent's one `tools:use` grant and hands it waiting CRM work. The page attaches its skills (and the Billing, Campaigns, Mailbox and Partners skills that exist) and shows an agent box only when something is wrong. The Cockpit snapshot reports it in `team`.
- **Routing.** Every CRM issue has an assignee: the contact's own agent or owner (setting `sequenceIssueAssignee: contact`), else the Account Manager, the Operator, then the company owner (kit `routeWork`). Approvals go to the Reviewer, else the owner.
- **Read tools.** `find-records`, `get-company`, `get-contact`, `list-deals`, `list-stages`, `list-sequences`, `get-client-profile`, `update-client-profile`, `set-email-status`. Results are JSON with `company:<id>` / `contact:<id>` refs and deep links. `complete-step` is gone: marking a step's issue done moves the contact on.
- **Leads.** Every `lead.captured` gets `lead.captured.result` (`stored`, `held`, `ignored`). A lead from a client's own channel goes to `client_leads` (shown on that client's page), never to our contacts. Own leads that arrive while the CRM is off or unsaved wait in `held_leads`; the `held-leads` job adds them and the Cockpit shows a health check meanwhile.
- **Hand-offs.** Emits `deal.won` (client becomes customer; `firstWin`), `contact.suppressed` (unsubscribe reply, bounce, `set-email-status`) and `company.deleted` (a person deletes a company), each re-sent hourly for a day. Consumes Billing `quote.accepted` and `invoice.paid`, and Campaigns/Mailbox `contact.suppressed`. Sequence email sets `marketing: true`.
- **Approvals.** A sequence approval an agent closes is reopened for the approver; a person's cancel refuses it (back to issues, with a hand-off). The Cockpit lists open approvals even while the Reviewer holds them.
- Migration `006_crm.sql`: `client_profiles`, `client_leads`, `held_leads`, `handoffs`, and `deals.won_at`.
