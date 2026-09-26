-- CRM projection (kit crmProjectionMigration). Clients are CRM companies:
-- the CRM plugin emits company/contact events and this copy is upserted.
CREATE TABLE plugin_social_e70c4e79f2.crm_companies (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  name text NOT NULL,
  domain text,
  lifecycle text,
  updated_at timestamptz NOT NULL,
  deleted boolean NOT NULL DEFAULT false
);
CREATE INDEX crm_companies_company ON plugin_social_e70c4e79f2.crm_companies (company_id, name);

CREATE TABLE plugin_social_e70c4e79f2.crm_contacts (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  name text NOT NULL,
  emails text[] NOT NULL DEFAULT '{}',
  phones text[] NOT NULL DEFAULT '{}',
  lifecycle text,
  tags text[] NOT NULL DEFAULT '{}',
  account_ids text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL,
  deleted boolean NOT NULL DEFAULT false
);
CREATE INDEX crm_contacts_company ON plugin_social_e70c4e79f2.crm_contacts (company_id, name);
