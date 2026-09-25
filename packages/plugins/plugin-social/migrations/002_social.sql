CREATE TABLE plugin_social_e70c4e79f2.templates (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  name text NOT NULL,
  body text NOT NULL,
  platform text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX templates_workspace ON plugin_social_e70c4e79f2.templates (company_id);
