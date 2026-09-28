# Campaigns

Paperclip plugin `partnersinbiz.campaigns`. Themed email programs that enroll contacts and open a Paperclip issue for each due step.

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
