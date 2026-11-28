-- Stage B2 (PAR-15210): the CRM copy keeps who manages each company (owner and Managed by), so Social can limit a
-- limited person to the posts, accounts and inbox of his own companies. Filled by the company.upserted events of the CRM; null manages nothing.
-- Additive: older code ignores the column. Rollback: leave it in place.
ALTER TABLE plugin_social_e70c4e79f2.crm_companies ADD COLUMN IF NOT EXISTS managers jsonb;
