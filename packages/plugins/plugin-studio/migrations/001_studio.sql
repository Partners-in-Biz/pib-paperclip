CREATE TABLE plugin_studio_e414325bb6.assets (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  client_kind text,
  client_ref text,
  client_name text,
  project_id text,
  name text NOT NULL,
  kind text NOT NULL,
  alt_text text,
  status text NOT NULL DEFAULT 'draft',
  source text NOT NULL,
  source_ref text,
  generation_id text,
  current_version integer NOT NULL DEFAULT 1,
  created_by_agent_id text,
  created_by_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX assets_scope ON plugin_studio_e414325bb6.assets (company_id, client_ref, created_at DESC);

CREATE UNIQUE INDEX assets_source ON plugin_studio_e414325bb6.assets (company_id, source_ref) WHERE source_ref IS NOT NULL;

CREATE TABLE plugin_studio_e414325bb6.asset_versions (
  asset_id text NOT NULL REFERENCES plugin_studio_e414325bb6.assets (id),
  version integer NOT NULL,
  company_id text NOT NULL,
  r2_key text NOT NULL,
  mime text NOT NULL,
  bytes bigint NOT NULL,
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_id, version)
);

CREATE TABLE plugin_studio_e414325bb6.asset_links (
  company_id text NOT NULL,
  asset_id text NOT NULL REFERENCES plugin_studio_e414325bb6.assets (id),
  target_type text NOT NULL,
  target_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_id, target_type, target_id)
);

CREATE INDEX asset_links_target ON plugin_studio_e414325bb6.asset_links (company_id, target_type, target_id);

CREATE TABLE plugin_studio_e414325bb6.generations (
  id text PRIMARY KEY,
  group_id text NOT NULL,
  company_id text NOT NULL,
  client_kind text,
  client_ref text,
  client_name text,
  project_id text,
  issue_id text,
  agent_id text,
  run_id text,
  user_id text,
  provider text NOT NULL,
  model text NOT NULL,
  prompt text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}',
  name text,
  status text NOT NULL DEFAULT 'queued',
  period text NOT NULL,
  estimated_credits numeric NOT NULL,
  actual_credits numeric,
  provider_job_id text,
  output_url text,
  attempts integer NOT NULL DEFAULT 0,
  asset_id text,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  finished_at timestamptz
);

CREATE INDEX generations_open ON plugin_studio_e414325bb6.generations (status, created_at) WHERE status IN ('queued', 'submitting', 'submitted', 'storing');

CREATE INDEX generations_group ON plugin_studio_e414325bb6.generations (group_id);

CREATE TABLE plugin_studio_e414325bb6.credit_ledger (
  generation_id text NOT NULL REFERENCES plugin_studio_e414325bb6.generations (id),
  kind text NOT NULL,
  company_id text NOT NULL,
  client_kind text,
  client_ref text,
  period text NOT NULL,
  credits numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (generation_id, kind)
);

CREATE INDEX credit_ledger_period ON plugin_studio_e414325bb6.credit_ledger (company_id, period, client_ref);

CREATE TABLE plugin_studio_e414325bb6.credit_limits (
  company_id text NOT NULL,
  scope_key text NOT NULL,
  monthly_credits numeric NOT NULL CHECK (monthly_credits >= 0),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, scope_key)
);

CREATE TABLE plugin_studio_e414325bb6.credit_limit_changes (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  scope_key text NOT NULL,
  old_credits numeric,
  new_credits numeric,
  changed_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX credit_limit_changes_company ON plugin_studio_e414325bb6.credit_limit_changes (company_id, created_at DESC);

CREATE TABLE plugin_studio_e414325bb6.crm_companies (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  name text NOT NULL,
  domain text,
  lifecycle text,
  updated_at timestamptz NOT NULL,
  deleted boolean NOT NULL DEFAULT false
);

CREATE INDEX crm_companies_company ON plugin_studio_e414325bb6.crm_companies (company_id, name);

CREATE TABLE plugin_studio_e414325bb6.crm_contacts (
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

CREATE INDEX crm_contacts_company ON plugin_studio_e414325bb6.crm_contacts (company_id, name);
