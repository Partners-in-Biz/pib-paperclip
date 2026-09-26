-- Audit snapshots (day 0/30/60/90, then monthly), findings, and the optimization log.
CREATE TABLE plugin_seo_8099f8879a.audit_snapshots (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  sprint_id text NOT NULL REFERENCES plugin_seo_8099f8879a.sprints (id) ON DELETE CASCADE,
  day integer NOT NULL,
  kind text NOT NULL DEFAULT 'manual' CHECK (kind IN ('scheduled', 'manual')),
  captured_on date NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  traffic jsonb NOT NULL DEFAULT '{}'::jsonb,
  rankings jsonb NOT NULL DEFAULT '{}'::jsonb,
  authority jsonb NOT NULL DEFAULT '{}'::jsonb,
  content jsonb NOT NULL DEFAULT '{}'::jsonb,
  cwv jsonb NOT NULL DEFAULT '{}'::jsonb,
  tasks jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL DEFAULT 'none',
  notes text
);

CREATE UNIQUE INDEX audit_snapshots_scheduled ON plugin_seo_8099f8879a.audit_snapshots (sprint_id, day) WHERE kind = 'scheduled';

CREATE INDEX audit_snapshots_sprint ON plugin_seo_8099f8879a.audit_snapshots (sprint_id, day);

-- The old audits table becomes the findings list.
ALTER TABLE plugin_seo_8099f8879a.audits
  ADD COLUMN snapshot_id text,
  ADD COLUMN category text,
  ADD COLUMN url text,
  ADD COLUMN source text,
  ADD COLUMN status text NOT NULL DEFAULT 'open',
  ADD COLUMN resolved_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

UPDATE plugin_seo_8099f8879a.audits SET category = 'general' WHERE category IS NULL;

CREATE UNIQUE INDEX audits_open_finding ON plugin_seo_8099f8879a.audits (sprint_id, category, url, finding) WHERE status = 'open' AND source IS NOT NULL;

CREATE INDEX audits_sprint_status ON plugin_seo_8099f8879a.audits (sprint_id, status);

CREATE TABLE plugin_seo_8099f8879a.optimizations (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  sprint_id text NOT NULL REFERENCES plugin_seo_8099f8879a.sprints (id) ON DELETE CASCADE,
  signal_type text NOT NULL,
  severity text NOT NULL DEFAULT 'medium',
  subject text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  hypothesis text NOT NULL,
  hypothesis_type text NOT NULL,
  proposed_action text NOT NULL,
  proposed_tasks jsonb NOT NULL DEFAULT '[]'::jsonb,
  target_keyword_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  target_url text,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected', 'measured')),
  approval_issue_id text,
  detected_on date NOT NULL,
  approved_at timestamptz,
  approved_by text,
  rejected_at timestamptz,
  rejected_reason text,
  generated_task_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  baseline jsonb,
  measure_on date,
  measured_at timestamptz,
  outcome jsonb,
  result text CHECK (result IS NULL OR result IN ('win', 'loss', 'no_change', 'inconclusive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX optimizations_open_subject ON plugin_seo_8099f8879a.optimizations (sprint_id, signal_type, subject) WHERE status IN ('proposed', 'approved');

CREATE INDEX optimizations_sprint ON plugin_seo_8099f8879a.optimizations (sprint_id, status);

CREATE INDEX optimizations_measure ON plugin_seo_8099f8879a.optimizations (status, measure_on);
