CREATE TABLE plugin_campaigns_d355219713.campaigns (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',
  from_name text NOT NULL DEFAULT '',
  from_local text NOT NULL DEFAULT 'campaigns',
  reply_to text,
  audience_tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  start_at timestamptz,
  end_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaigns_status CHECK (status IN ('draft', 'scheduled', 'active', 'paused', 'completed'))
);

CREATE INDEX campaigns_workspace ON plugin_campaigns_d355219713.campaigns (company_id);

CREATE TABLE plugin_campaigns_d355219713.campaign_steps (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  campaign_id text NOT NULL REFERENCES plugin_campaigns_d355219713.campaigns (id),
  position integer NOT NULL,
  delay_days integer NOT NULL DEFAULT 0,
  subject text NOT NULL,
  body text NOT NULL DEFAULT ''
);

CREATE TABLE plugin_campaigns_d355219713.campaign_enrollments (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  campaign_id text NOT NULL REFERENCES plugin_campaigns_d355219713.campaigns (id),
  contact_id text NOT NULL,
  status text NOT NULL,
  step_position integer NOT NULL,
  next_due_at timestamptz,
  open_issue_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaign_enrollments_status CHECK (status IN ('running', 'stopped', 'done'))
);

CREATE UNIQUE INDEX campaign_enrollments_one_running ON plugin_campaigns_d355219713.campaign_enrollments (campaign_id, contact_id) WHERE status = 'running';

CREATE INDEX campaign_enrollments_due ON plugin_campaigns_d355219713.campaign_enrollments (next_due_at) WHERE status = 'running';
