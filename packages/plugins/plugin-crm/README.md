# CRM

Paperclip plugin `partnersinbiz.crm`. Companies, contacts, deals, and sequences live in this plugin's Postgres schema. The Paperclip company remains the workspace.

Install from this package after `pnpm build`:

```bash
paperclipai plugin install /absolute/path/to/packages/plugins/plugin-crm
```

Agents use the managed skills `crm-records` and `crm-outbound`. A due sequence step opens a Paperclip issue. Won or lost stops running enrollments for that contact.
