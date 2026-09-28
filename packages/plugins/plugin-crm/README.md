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

## Flows and done-checks (0.5.0)

- **Company graph.** The Cockpit snapshot's `flows` reports the two kit `FLOWS` stages the CRM owns. `lead.in`: open lead follow-ups plus held leads; stuck = follow-ups open over 2 days, blocked or unassigned, plus every held lead (the reason says why). `deal.open`: open deals with the Open pipeline KPI's value (default currency first); stuck = nothing logged on the deal, its contact or its company, and no change to the deal, for 14 days.
- **Origin ids.** Every CRM issue's id now starts with `crm:`: `crm:lead-followup:<lead key>`, `crm:reply:<message id>`, `crm:step:<enrollment>:<step>`, `crm:send-failed:<enrollment>:<step>`, `crm:won-client:<deal id>`, `crm:quote-deal:<quote id>`, `crm:sequence-refused:<approval issue id>`, `crm:sequence-email:<sequence id>`. Done-checks match by prefix only, and Campaigns opens `reply:` and `send-failed:` issues too. Older ids are still deduped, adopted and listed, but never checked.
- **Done-checks** (kit `registerDoneChecks`, `src/done-checks.ts`). When an agent closes one of these issues, the CRM checks its own data and reopens unfinished work with what is missing:
  - lead follow-up: work logged since the lead came in, plus a next action, a deal or a lifecycle decision;
  - contact reply: a logged answer, or a next action, lifecycle, deal move or opt-out since;
  - sequence step: the step logged on the contact (only then does the close move the contact on);
  - email not sent: the address fixed, the contact reached and logged, or the address marked bounced;
  - won deal without a client: the deal linked to one;
  - accepted quote: a deal carries the quote, or one of the client's deals was won since.
  An opt-out, a stopped or finished sequence, a deleted record or no open deal left also counts as finished. Approvals and the refused-sequence hand-off have no check.
- **`move-deal` `quoteId`.** Moving a deal to won with the accepted quote's id records it on the deal (custom `quoteId`, `quoteNumber`) and logs it on the deal's timeline.

## Sales team and one record per person (0.7.0)
- **Roles:** four optional roles alongside the Account Manager, staffed in Setup → Team: Sales Lead, Inbound Qualifier, CRM Data Steward, Deal Desk. While a role has no agent, the Account Manager covers it (kit `coveredBy`, `teamRoleChain`). The `crm.*-agent` actions take `params.role` (default `account-manager`).
- **Routing:** new leads and leads' replies go to the Inbound Qualifier; won-deal and accepted-quote hand-offs to the Sales Lead; duplicates to the Data Steward. Billing sends quote replies to the Deal Desk.
- **Jobs:** `sales-daily` (07:30 SAST) opens a pipeline check for deals quiet 14 days and a duplicates issue. `sales-weekly` (Mondays 08:00 SAST) opens the pipeline summary and the CRM hygiene report. The pipeline check and duplicates issues have done-checks.
- **No duplicates:** `create-contact` and `import-contacts` match on email, then on phone (last 9 digits); `create-company` matches on the website domain, then the name. A match fills only empty fields, adds missing emails, phones and tags, logs a note, and returns `matched: true`.
- **Skills:** `pib-sales-lead`, `pib-inbound-qualify`, `pib-data-steward`, `pib-deal-desk`.

## Websites, the PiB Connector and projects (0.6.0)

- **Websites.** A client (company or contact) can have several sites (`client_sites`): address (scheme and host; one record per host per company), label, platform (wordpress, nextjs, custom, shopify, wix, other), SEO plugin (yoast, rankmath, none), hosting, access (`repo`, `connector`, `sftp`), the site's project, the SFTP `webRoot` and notes for agents. Tools `list-client-sites`, `save-client-site`, `check-client-site`, `site-changes`; actions `crm.save-client-site`, `crm.delete-client-site` (people), `crm.connect-client-site`, `crm.check-client-site`. The client page has a Websites card.
- **Sharing.** `site.upserted` / `site.deleted` (a hand-off) carry the kit `CrmSiteEvent`, without the key. `emit-recent`, `emit-all` and `crm.resync` re-send them. Consumers use the kit `registerCrmSiteProjection` and `crmSiteProjectionMigration` (SEO does).
- **PiB Connector.** The WordPress plugin in `packages/plugins/pib-wp-connector` (protocol: its `PROTOCOL.md`). The CRM build puts `pib-connector.zip` into `dist/ui/`, so it is served next to the page. A person presses Connect WordPress (a `pibc_` key shown once) and pastes the key into wp-admin → Settings → PiB Connector. An agent may pair a site it already reaches over SFTP (`connect-client-site` tool: key file plus mu-plugin loader). Check pings and stores health (SEO plugin, sitemap, search engine visibility, plugins); the hourly `setup-status` job re-checks sites not heard from in 6 hours.
- **Connector tools.** `wp-health`, `wp-seo`, `wp-schema`, `wp-redirects`, `wp-robots`, `wp-sitemap`, `wp-plugins`, `wp-log`, `wp-undo`. Every request is signed (HMAC-SHA256 over timestamp, nonce, route and body hash) and sent with the host's `ctx.http.fetch` (`/wp-json/…`, then `?rest_route=…`). Writes need a `reason` and are logged in `site_changes`. Plugin installs and rollbacks are for people only. A connection failure marks the site `error` for every module.
- **Projects.** `client_projects` links Paperclip projects (a client's code folders) to one client each: tools `list-client-projects` (with unlinked projects, suggested by name), `link-client-project`; `crm.unlink-client-project` is for people. The client page has a Projects card.
- **Skills.** `wp-sites` (Connector tools, pairing over SFTP, the SFTP deploy routine for our own plugins: backup, upload to a new name, swap, sha256 readback, live check, rollback) is an extra skill of the SEO Specialist. `ios-release` (Mac build environment, API-key signing, `asc` upload, App Review needs a person) is for the agent that builds iOS apps.
- New capabilities: `projects.read`, `http.outbound`. Migration `007_crm.sql`: `client_sites`, `site_changes`, `client_projects`.
