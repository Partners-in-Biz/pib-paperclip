CREATE TABLE plugin_campaigns_d355219713.campaign_templates (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX campaign_templates_workspace ON plugin_campaigns_d355219713.campaign_templates (company_id);
