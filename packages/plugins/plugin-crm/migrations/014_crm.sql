-- CRM 0.17.0: client projects may have a kind (seo, website, app, social, ads, campaigns, book, platform, ops).
-- Rollback: old code ignores the column.

ALTER TABLE plugin_crm_832258244c.client_projects
  ADD COLUMN IF NOT EXISTS kind text;

-- A project of a client may have only one kind; null is allowed (many projects per client).
CREATE UNIQUE INDEX IF NOT EXISTS client_projects_client_kind_partial
  ON plugin_crm_832258244c.client_projects (company_id, client_kind, client_ref, kind)
  WHERE kind IS NOT NULL;
