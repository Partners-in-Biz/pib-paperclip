-- Access stage B-D9 (PAR-15207): the People screen shows the CRM companies each limited person manages.
-- crm_companies is the kit CRM projection (companies only) with its managers column, fed by the CRM company events.
-- Undo: DROP TABLE plugin_setup_48494712db.crm_companies (the old code never reads it).
CREATE TABLE plugin_setup_48494712db.crm_companies (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  name text NOT NULL,
  domain text,
  lifecycle text,
  updated_at timestamptz NOT NULL,
  deleted boolean NOT NULL DEFAULT false,
  managers jsonb
);

CREATE INDEX crm_companies_company ON plugin_setup_48494712db.crm_companies (company_id, name);
