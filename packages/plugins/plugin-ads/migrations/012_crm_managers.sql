-- Stage B2 (PAR-12582): the CRM copy keeps who manages each company (owner and Managed by), so Ads can limit a
-- limited person to the scopes of his own companies. Filled by the company.upserted events of the CRM; null manages nothing.
-- Rollback: none needed. An added nullable column the previous code never reads; drop it once no newer code runs.
ALTER TABLE plugin_ads_caac8387d2.crm_companies ADD COLUMN IF NOT EXISTS managers jsonb;
