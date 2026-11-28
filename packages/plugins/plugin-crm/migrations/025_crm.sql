-- CRM: Managed by on a company (access stage B, PAR-12581). manager_user_ids: the people who manage the company
-- beside its owner (owner_user_id), as a JSON list of user ids, at most 3. The own companies of a limited person are the ones
-- he owns or manages. Every existing company gets an empty list, so nothing changes until an owner or admin adds someone.
-- Rollback: revert the code. The column, CHECK and index can stay: old code never names the column.

ALTER TABLE plugin_crm_832258244c.companies ADD COLUMN IF NOT EXISTS manager_user_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE plugin_crm_832258244c.companies DROP CONSTRAINT IF EXISTS companies_manager_user_ids;

ALTER TABLE plugin_crm_832258244c.companies ADD CONSTRAINT companies_manager_user_ids CHECK (
  jsonb_typeof(manager_user_ids) = 'array' AND jsonb_array_length(manager_user_ids) <= 3
);

CREATE INDEX IF NOT EXISTS companies_managers ON plugin_crm_832258244c.companies USING gin (manager_user_ids);
