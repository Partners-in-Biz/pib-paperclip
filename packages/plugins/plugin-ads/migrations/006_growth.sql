CREATE TABLE plugin_ads_caac8387d2.growth_programs (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  client_kind text,
  client_ref text,
  client_name text,
  channel text NOT NULL,
  objective text NOT NULL,
  metric text NOT NULL,
  scope_key text NOT NULL,
  project_id text,
  constraints jsonb NOT NULL DEFAULT '{}'::jsonb,
  playbook text NOT NULL DEFAULT '',
  playbook_version integer NOT NULL DEFAULT 1,
  autopilot text NOT NULL DEFAULT 'reviewed',
  scoreboard jsonb NOT NULL DEFAULT '{}'::jsonb,
  feature_questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active',
  owner_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT growth_programs_autopilot CHECK (autopilot IN ('off', 'safe', 'reviewed', 'full')),
  CONSTRAINT growth_programs_client_kind CHECK (client_kind IS NULL OR client_kind IN ('company', 'contact')),
  CONSTRAINT growth_programs_status CHECK (status IN ('active', 'paused', 'archived'))
);
CREATE UNIQUE INDEX growth_programs_scope ON plugin_ads_caac8387d2.growth_programs (company_id, channel, scope_key);

CREATE TABLE plugin_ads_caac8387d2.growth_playbook_versions (
  id text PRIMARY KEY,
  program_id text NOT NULL REFERENCES plugin_ads_caac8387d2.growth_programs(id) ON DELETE CASCADE,
  version integer NOT NULL,
  playbook text NOT NULL,
  reason text NOT NULL,
  experiment_id text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (program_id, version)
);

CREATE TABLE plugin_ads_caac8387d2.growth_experiments (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  program_id text NOT NULL REFERENCES plugin_ads_caac8387d2.growth_programs(id) ON DELETE CASCADE,
  hypothesis text NOT NULL,
  hypothesis_type text NOT NULL,
  variable text NOT NULL,
  arms jsonb NOT NULL,
  metric text NOT NULL,
  min_per_arm integer NOT NULL DEFAULT 3,
  window_days integer NOT NULL DEFAULT 7,
  status text NOT NULL DEFAULT 'proposed',
  proposed_by text,
  approval_issue_id text,
  approved_at timestamptz,
  approved_by text,
  started_at timestamptz,
  measure_after timestamptz,
  measured_at timestamptz,
  verdict text,
  outcome jsonb,
  playbook_diff text,
  playbook_decision text,
  decision_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT growth_experiments_status CHECK (status IN ('proposed', 'running', 'measured', 'rejected', 'abandoned')),
  CONSTRAINT growth_experiments_verdict CHECK (verdict IS NULL OR verdict IN ('win', 'loss', 'no_change', 'inconclusive')),
  CONSTRAINT growth_experiments_decision CHECK (playbook_decision IS NULL OR playbook_decision IN ('kept', 'discarded', 'pending'))
);
CREATE INDEX growth_experiments_program ON plugin_ads_caac8387d2.growth_experiments (program_id, status);

CREATE TABLE plugin_ads_caac8387d2.growth_experiment_items (
  experiment_id text NOT NULL REFERENCES plugin_ads_caac8387d2.growth_experiments(id) ON DELETE CASCADE,
  arm text NOT NULL,
  subject_kind text NOT NULL,
  subject_id text NOT NULL,
  value numeric,
  measured_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (experiment_id, subject_kind, subject_id)
);

CREATE TABLE plugin_ads_caac8387d2.growth_playbook_changes (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  program_id text NOT NULL REFERENCES plugin_ads_caac8387d2.growth_programs(id) ON DELETE CASCADE,
  experiment_id text,
  op text NOT NULL,
  section text,
  body text NOT NULL,
  diff text NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  base_version integer NOT NULL,
  result_version integer,
  proposed_by text,
  decided_by text,
  decided_at timestamptz,
  decision_note text,
  owner_user_id text,
  approval_issue_id text,
  approval_week text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT growth_playbook_changes_op CHECK (op IN ('add', 'remove', 'replace')),
  CONSTRAINT growth_playbook_changes_status CHECK (status IN ('pending', 'kept', 'discarded'))
);
CREATE INDEX growth_playbook_changes_program ON plugin_ads_caac8387d2.growth_playbook_changes (program_id, status);
