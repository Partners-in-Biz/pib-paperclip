# Billing

Paperclip plugin `partnersinbiz.billing`. Commercial invoices only. Agents draft lines in minor units. Sending and marking paid open a Paperclip issue, and the invoice status changes when a person marks that issue done.

- The Billing page is PiB's whole book (every invoice, quote and expense). The customer picker offers CRM companies and contacts.
- `/billing?client=company:<id>` or `?client=contact:<id>` is that client's workspace tab: only its invoices, quotes, recurring schedules and credit notes (no expenses), and new invoices and quotes are locked to the client.
- `GET /api/plugins/partnersinbiz.billing/api/client-summary?companyId=&kind=&id=` returns `{ headline, stats }` (outstanding per currency, overdue invoices, open quotes, last paid) for the CRM client workspace.
