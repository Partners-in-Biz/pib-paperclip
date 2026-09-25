CREATE TABLE plugin_crm_832258244c.companies (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  name text NOT NULL,
  domain text,
  lifecycle text NOT NULL DEFAULT 'lead',
  currency text NOT NULL DEFAULT 'ZAR',
  custom jsonb NOT NULL DEFAULT '{}'::jsonb,
  human_owned_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  owner_user_id text,
  assignee_agent_id text,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companies_lifecycle CHECK (lifecycle IN ('lead', 'prospect', 'customer', 'churned'))
);

CREATE INDEX companies_workspace ON plugin_crm_832258244c.companies (company_id);

CREATE TABLE plugin_crm_832258244c.contacts (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  name text NOT NULL,
  emails jsonb NOT NULL DEFAULT '[]'::jsonb,
  phones jsonb NOT NULL DEFAULT '[]'::jsonb,
  lifecycle text NOT NULL DEFAULT 'lead',
  custom jsonb NOT NULL DEFAULT '{}'::jsonb,
  human_owned_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  owner_user_id text,
  assignee_agent_id text,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  next_action_kind text,
  next_action_due_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contacts_lifecycle CHECK (lifecycle IN ('lead', 'prospect', 'customer', 'churned')),
  CONSTRAINT contacts_next_action CHECK (next_action_kind IS NULL OR next_action_kind IN ('call', 'email', 'meet'))
);

CREATE INDEX contacts_workspace ON plugin_crm_832258244c.contacts (company_id);

CREATE TABLE plugin_crm_832258244c.contact_companies (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  contact_id text NOT NULL REFERENCES plugin_crm_832258244c.contacts (id),
  account_id text NOT NULL REFERENCES plugin_crm_832258244c.companies (id),
  role_label text NOT NULL DEFAULT 'staff',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX contact_companies_pair ON plugin_crm_832258244c.contact_companies (contact_id, account_id);

CREATE TABLE plugin_crm_832258244c.field_defs (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  record_type text NOT NULL,
  field_key text NOT NULL,
  label text NOT NULL,
  field_type text NOT NULL DEFAULT 'text',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT field_defs_record_type CHECK (record_type IN ('contact', 'company', 'deal'))
);

CREATE UNIQUE INDEX field_defs_key ON plugin_crm_832258244c.field_defs (company_id, record_type, field_key);

CREATE TABLE plugin_crm_832258244c.facts (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  record_type text NOT NULL,
  record_id text NOT NULL,
  field_key text NOT NULL,
  value jsonb NOT NULL,
  source text NOT NULL,
  refused boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX facts_record ON plugin_crm_832258244c.facts (record_type, record_id);

CREATE TABLE plugin_crm_832258244c.activities (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  record_type text NOT NULL,
  record_id text NOT NULL,
  kind text NOT NULL,
  body text NOT NULL,
  issue_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX activities_record ON plugin_crm_832258244c.activities (record_type, record_id);

CREATE TABLE plugin_crm_832258244c.pipelines (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plugin_crm_832258244c.pipeline_stages (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  pipeline_id text NOT NULL REFERENCES plugin_crm_832258244c.pipelines (id),
  name text NOT NULL,
  kind text NOT NULL,
  position integer NOT NULL,
  CONSTRAINT pipeline_stages_kind CHECK (kind IN ('open', 'won', 'lost'))
);

CREATE TABLE plugin_crm_832258244c.deals (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  pipeline_id text NOT NULL REFERENCES plugin_crm_832258244c.pipelines (id),
  stage_id text NOT NULL REFERENCES plugin_crm_832258244c.pipeline_stages (id),
  account_id text REFERENCES plugin_crm_832258244c.companies (id),
  contact_id text REFERENCES plugin_crm_832258244c.contacts (id),
  title text NOT NULL,
  amount_minor bigint NOT NULL DEFAULT 0,
  currency text NOT NULL,
  owner_user_id text,
  assignee_agent_id text,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  next_action_kind text,
  next_action_due_at timestamptz,
  custom jsonb NOT NULL DEFAULT '{}'::jsonb,
  human_owned_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deals_next_action CHECK (next_action_kind IS NULL OR next_action_kind IN ('call', 'email', 'meet'))
);

CREATE INDEX deals_workspace ON plugin_crm_832258244c.deals (company_id);

CREATE TABLE plugin_crm_832258244c.record_grants (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  record_type text NOT NULL,
  record_id text NOT NULL,
  principal_type text NOT NULL,
  principal_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT record_grants_principal CHECK (principal_type IN ('user', 'agent', 'company')),
  CONSTRAINT record_grants_record_type CHECK (record_type IN ('contact', 'company', 'deal'))
);

CREATE UNIQUE INDEX record_grants_principal_idx ON plugin_crm_832258244c.record_grants (record_type, record_id, principal_type, principal_id);

CREATE TABLE plugin_crm_832258244c.sequences (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  name text NOT NULL,
  completion_mode text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sequences_completion CHECK (completion_mode IN ('manual', 'sent'))
);

CREATE TABLE plugin_crm_832258244c.sequence_steps (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  sequence_id text NOT NULL REFERENCES plugin_crm_832258244c.sequences (id),
  position integer NOT NULL,
  delay_minutes integer NOT NULL DEFAULT 0,
  title text NOT NULL,
  body text NOT NULL DEFAULT ''
);

CREATE TABLE plugin_crm_832258244c.enrollments (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  sequence_id text NOT NULL REFERENCES plugin_crm_832258244c.sequences (id),
  contact_id text NOT NULL REFERENCES plugin_crm_832258244c.contacts (id),
  status text NOT NULL,
  step_position integer NOT NULL,
  next_due_at timestamptz,
  open_issue_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT enrollments_status CHECK (status IN ('running', 'stopped', 'done'))
);

CREATE UNIQUE INDEX enrollments_one_running ON plugin_crm_832258244c.enrollments (sequence_id, contact_id) WHERE status = 'running';

CREATE INDEX enrollments_due ON plugin_crm_832258244c.enrollments (next_due_at) WHERE status = 'running';
