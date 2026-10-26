-- Billing 0.12: the hosted-company link and plan label of a CRM company, as the CRM sends them with company.upserted (CRM 0.32.5 and later).
-- A json object with companyId and plan. Read by the monthly hosted-retainer job. Null until the CRM sends it.
-- Additive: the previous code ignores the column.
ALTER TABLE plugin_billing_287195dc99.crm_companies ADD COLUMN IF NOT EXISTS hosted jsonb;
