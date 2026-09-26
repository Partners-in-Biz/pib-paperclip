# Campaigns

Paperclip plugin `partnersinbiz.campaigns`. Themed email programs that enroll contacts and open a Paperclip issue for each due step.

- A campaign groups email steps that target an audience. `audienceTags` narrows which contacts are enrolled; empty means every visible contact.
- A campaign is PiB's own work (no client) or a client's (`client_kind` + `client_ref`, a CRM company or contact). The Campaigns page shows own work; `/campaigns?client=company:<id>` or `?client=contact:<id>` is that client's workspace tab. A company client's campaign enrolls the contacts at that company by default (`audienceMode: client_contacts`); a contact client's enrolls that contact (`client_contact`); `tags` keeps the tag audience.
- `GET /api/plugins/partnersinbiz.campaigns/api/client-summary?companyId=&kind=&id=` returns `{ headline, stats }` (active campaigns, enrolled contacts, due steps) for the CRM client workspace.
- `launch-campaign` enrolls matching contacts (read from the CRM plugin) and opens the first step's issue. A person sends the email and marks the issue done.
- `pause-campaign`, `resume-campaign`, and `complete-campaign` control a running program.
- `campaign-stats` reports enrolled, running, and completed counts.

The plugin reads contacts from the CRM plugin's namespace to build the audience. Install both plugins together.
