CREATE TABLE plugin_crm_832258244c.saved_views (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  name text NOT NULL,
  record_type text NOT NULL,
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saved_views_record_type CHECK (record_type IN ('contact', 'company', 'deal'))
);

CREATE INDEX saved_views_workspace ON plugin_crm_832258244c.saved_views (company_id);
