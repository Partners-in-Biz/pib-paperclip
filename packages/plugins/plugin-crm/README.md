# CRM

Paperclip plugin `partnersinbiz.crm`. Companies, contacts, deals, and sequences live in this plugin's Postgres schema. The Paperclip company remains the workspace.

Install from this package after `pnpm build`:

```bash
paperclipai plugin install /absolute/path/to/packages/plugins/plugin-crm
```

Agents use the managed skills `crm-records` and `crm-outbound`. A due sequence step opens a Paperclip issue. Won or lost stops running enrollments for that contact.

## Client workspace

`/crm?client=company:<id>` or `/crm?client=contact:<id>` opens that client's workspace (Open on a company or contact in the list goes there). The Overview has editable details (`crm.update-company` / `crm.update-contact`, which broadcast CRM change events), linked people or companies, deals, activity, contact tools, and one card each for Social, SEO, Campaigns and Billing. Each card reads `GET /api/plugins/<pluginKey>/api/client-summary?companyId=&kind=&id=` (`{ headline, stats[] }`) and shows only an Open link when that plugin does not answer. The page loads through the `crm.client-workspace` action, which returns `found: false` for an unknown, deleted or hidden id.
