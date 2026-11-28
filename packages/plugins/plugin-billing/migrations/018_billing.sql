-- Billing 0.25 (access stage B-4, PAR-15206): who manages a CRM company ({ownerUserId, managerUserIds}), as the CRM sends it with
-- company.upserted (CRM 0.56.0 and later). The own companies of a limited person are the ones he manages; read only under the access
-- switch `enforce`. Null until the CRM sends it, which manages nothing (fail closed).
-- Additive: the previous code ignores the column. Rollback: the previous release runs on this schema unchanged;
-- to undo by hand: ALTER TABLE plugin_billing_287195dc99.crm_companies DROP COLUMN managers;
ALTER TABLE plugin_billing_287195dc99.crm_companies ADD COLUMN IF NOT EXISTS managers jsonb;
