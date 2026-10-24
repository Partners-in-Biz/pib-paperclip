-- CRM: the hosted-company link of a client (PAR-5160). Additive, nullable columns; old code ignores them.
-- hosted_plan is one of starter, growth, business (checked on write in the worker); hosted_company_id is the Paperclip company the platform service provisioned.

ALTER TABLE plugin_crm_832258244c.companies ADD COLUMN IF NOT EXISTS hosted_company_id text;

ALTER TABLE plugin_crm_832258244c.companies ADD COLUMN IF NOT EXISTS hosted_plan text;
