CREATE TABLE plugin_crm_832258244c.products (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  unit_amount_minor bigint NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'ZAR',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX products_workspace ON plugin_crm_832258244c.products (company_id);
