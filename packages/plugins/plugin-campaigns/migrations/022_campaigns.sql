-- Stage B2 (PAR-15209): the CRM copy keeps who manages each company (owner and Managed by), so Campaigns can limit a
-- limited person to the campaigns of his own companies. Filled by the company.upserted events of the CRM; null manages nothing.
-- Never edit this file once it may have run: add the next number.
-- Rollback: none needed. An added nullable column the previous code never reads.
ALTER TABLE plugin_campaigns_d355219713.crm_companies ADD COLUMN IF NOT EXISTS managers jsonb;
