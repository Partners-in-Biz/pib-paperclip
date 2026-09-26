-- 0.5.0: Jev decisions (kit decisionsMigration), inbox triage stored on each
-- item, and the Growth Lab (kit experimentsMigration) with per-destination
-- scores, per-post features, playbook changes and experiment tags on posts.

CREATE TABLE plugin_social_e70c4e79f2.decisions (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  purpose text NOT NULL,
  subject_kind text NOT NULL,
  subject_id text NOT NULL,
  question_key text NOT NULL,
  answer_type text NOT NULL,
  value_text text,
  value_num numeric,
  confidence numeric NOT NULL,
  probabilities jsonb,
  model text NOT NULL,
  acted boolean NOT NULL DEFAULT false,
  corrected_to text,
  corrected_by text,
  corrected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX decisions_subject ON plugin_social_e70c4e79f2.decisions (company_id, subject_kind, subject_id);
CREATE INDEX decisions_purpose ON plugin_social_e70c4e79f2.decisions (company_id, purpose, created_at);

-- Inbox triage: the answers, what the plugin did, and the digest issue.
ALTER TABLE plugin_social_e70c4e79f2.inbox_items
  ADD COLUMN IF NOT EXISTS triage jsonb,
  ADD COLUMN IF NOT EXISTS triaged_at timestamptz,
  ADD COLUMN IF NOT EXISTS triage_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS triage_issue_id text;
CREATE INDEX IF NOT EXISTS inbox_items_untriaged ON plugin_social_e70c4e79f2.inbox_items (company_id, created_at) WHERE triaged_at IS NULL;

-- Growth Lab (kit experimentsMigration).
CREATE TABLE plugin_social_e70c4e79f2.growth_programs (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  client_kind text,
  client_ref text,
  client_name text,
  channel text NOT NULL,
  objective text NOT NULL,
  metric text NOT NULL,
  constraints jsonb NOT NULL DEFAULT '{}'::jsonb,
  playbook text NOT NULL DEFAULT '',
  playbook_version integer NOT NULL DEFAULT 1,
  autopilot text NOT NULL DEFAULT 'safe',
  scoreboard jsonb NOT NULL DEFAULT '{}'::jsonb,
  feature_questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT growth_programs_autopilot CHECK (autopilot IN ('off', 'safe', 'full')),
  CONSTRAINT growth_programs_status CHECK (status IN ('active', 'paused', 'archived'))
);
CREATE UNIQUE INDEX growth_programs_scope ON plugin_social_e70c4e79f2.growth_programs (company_id, channel, coalesce(client_kind, ''), coalesce(client_ref, ''));

CREATE TABLE plugin_social_e70c4e79f2.growth_playbook_versions (
  id text PRIMARY KEY,
  program_id text NOT NULL REFERENCES plugin_social_e70c4e79f2.growth_programs(id) ON DELETE CASCADE,
  version integer NOT NULL,
  playbook text NOT NULL,
  reason text NOT NULL,
  experiment_id text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (program_id, version)
);

CREATE TABLE plugin_social_e70c4e79f2.growth_experiments (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  program_id text NOT NULL REFERENCES plugin_social_e70c4e79f2.growth_programs(id) ON DELETE CASCADE,
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
  started_at timestamptz,
  measure_after timestamptz,
  measured_at timestamptz,
  verdict text,
  outcome jsonb,
  playbook_diff text,
  playbook_decision text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT growth_experiments_status CHECK (status IN ('proposed', 'running', 'measured', 'rejected', 'abandoned')),
  CONSTRAINT growth_experiments_verdict CHECK (verdict IS NULL OR verdict IN ('win', 'loss', 'no_change', 'inconclusive')),
  CONSTRAINT growth_experiments_decision CHECK (playbook_decision IS NULL OR playbook_decision IN ('kept', 'discarded', 'pending'))
);
CREATE INDEX growth_experiments_program ON plugin_social_e70c4e79f2.growth_experiments (program_id, status);

CREATE TABLE plugin_social_e70c4e79f2.growth_experiment_items (
  experiment_id text NOT NULL REFERENCES plugin_social_e70c4e79f2.growth_experiments(id) ON DELETE CASCADE,
  arm text NOT NULL,
  subject_kind text NOT NULL,
  subject_id text NOT NULL,
  value numeric,
  measured_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (experiment_id, subject_kind, subject_id)
);

-- Social additions to the kit tables: who approves, the approval issue of the week, decision notes.
ALTER TABLE plugin_social_e70c4e79f2.growth_programs
  ADD COLUMN IF NOT EXISTS owner_user_id text,
  ADD COLUMN IF NOT EXISTS approval_issue_id text,
  ADD COLUMN IF NOT EXISTS approval_week text,
  ADD CONSTRAINT growth_programs_client_kind CHECK (client_kind IS NULL OR client_kind IN ('company', 'contact'));

ALTER TABLE plugin_social_e70c4e79f2.growth_experiments
  ADD COLUMN IF NOT EXISTS approved_by text,
  ADD COLUMN IF NOT EXISTS decision_note text;

CREATE INDEX IF NOT EXISTS growth_experiments_company ON plugin_social_e70c4e79f2.growth_experiments (company_id, status);

-- Playbook changes: drafted from experiment verdicts or proposed by the agent; a person (or full autopilot) keeps or discards them.
CREATE TABLE plugin_social_e70c4e79f2.growth_playbook_changes (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  program_id text NOT NULL REFERENCES plugin_social_e70c4e79f2.growth_programs(id) ON DELETE CASCADE,
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
  approval_issue_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT growth_playbook_changes_op CHECK (op IN ('add', 'remove', 'replace')),
  CONSTRAINT growth_playbook_changes_status CHECK (status IN ('pending', 'kept', 'discarded'))
);
CREATE INDEX growth_playbook_changes_program ON plugin_social_e70c4e79f2.growth_playbook_changes (program_id, status);

-- Features of a published post (code: format, length, daypart; Jev: hook, CTA, topic, tone and the questions of the program).
CREATE TABLE plugin_social_e70c4e79f2.post_features (
  post_id text NOT NULL REFERENCES plugin_social_e70c4e79f2.posts(id) ON DELETE CASCADE,
  feature_key text NOT NULL,
  company_id text NOT NULL,
  program_id text,
  value text,
  confidence numeric NOT NULL,
  source text NOT NULL,
  decision_id text,
  model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, feature_key),
  CONSTRAINT post_features_source CHECK (source IN ('code', 'jev'))
);
CREATE INDEX post_features_program ON plugin_social_e70c4e79f2.post_features (company_id, program_id, feature_key);

-- Engagement rate per destination and window, against the trailing 30-day median of the account.
CREATE TABLE plugin_social_e70c4e79f2.post_scores (
  destination_id text NOT NULL REFERENCES plugin_social_e70c4e79f2.destinations(id) ON DELETE CASCADE,
  metric_window text NOT NULL,
  company_id text NOT NULL,
  post_id text NOT NULL REFERENCES plugin_social_e70c4e79f2.posts(id) ON DELETE CASCADE,
  account_id text,
  platform text,
  program_id text,
  client_kind text,
  client_ref text,
  engagement_rate numeric NOT NULL,
  basis text NOT NULL,
  baseline_median numeric,
  baseline_n integer NOT NULL DEFAULT 0,
  lift numeric,
  published_at timestamptz,
  scored_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (destination_id, metric_window),
  CONSTRAINT post_scores_basis CHECK (basis IN ('reach', 'impressions', 'views'))
);
CREATE INDEX post_scores_scope ON plugin_social_e70c4e79f2.post_scores (company_id, client_ref, client_kind, published_at);
CREATE INDEX post_scores_post ON plugin_social_e70c4e79f2.post_scores (post_id);

-- Experiment tags on posts (the arm a post tests).
ALTER TABLE plugin_social_e70c4e79f2.posts
  ADD COLUMN IF NOT EXISTS experiment_id text,
  ADD COLUMN IF NOT EXISTS experiment_arm text;
CREATE INDEX IF NOT EXISTS posts_experiment ON plugin_social_e70c4e79f2.posts (experiment_id) WHERE experiment_id IS NOT NULL;
