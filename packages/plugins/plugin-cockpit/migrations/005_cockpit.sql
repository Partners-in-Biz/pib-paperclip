-- 0.5.0: the improvements ledger (Q2-3, Q2-12) and company goals (Q10-3).

-- An improvement is a change to how the system or an agent works, written down
-- with the number it should move: where it started, where it should get to,
-- who owns it and when to look again. At the re-check date the Cockpit
-- measures the metric again and records improved / no_change / worse.
-- kind: skill | instruction | routine | plugin | agent | system
-- metric_key: see metrics.ts (company:<metric>, agent:<id>:<metric>, kpi:<plugin>:<key>, manual)
-- direction: lower | higher (which way is better)
CREATE TABLE plugin_cockpit_b8a99e8b16.improvements (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  title text NOT NULL,
  kind text NOT NULL DEFAULT 'system',
  target_ref text,
  summary text,
  owner_agent_id text,
  owner_user_id text,
  metric_key text NOT NULL,
  metric_label text,
  direction text NOT NULL DEFAULT 'lower',
  baseline_value double precision,
  baseline_at timestamptz,
  target_value double precision,
  recheck_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open',
  outcome text,
  result_value double precision,
  measured_at timestamptz,
  result_note text,
  source_ref text,
  source_issue_id text,
  created_by_agent_id text,
  created_by_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT improvements_kind CHECK (kind IN ('skill', 'instruction', 'routine', 'plugin', 'agent', 'system')),
  CONSTRAINT improvements_direction CHECK (direction IN ('lower', 'higher')),
  CONSTRAINT improvements_status CHECK (status IN ('open', 'resolved', 'dropped')),
  CONSTRAINT improvements_outcome CHECK (outcome IS NULL OR outcome IN ('improved', 'no_change', 'worse', 'inconclusive'))
);
CREATE INDEX improvements_open ON plugin_cockpit_b8a99e8b16.improvements (company_id, status, recheck_at);
CREATE UNIQUE INDEX improvements_open_source ON plugin_cockpit_b8a99e8b16.improvements (company_id, source_ref) WHERE source_ref IS NOT NULL AND status = 'open';

-- Business goals: a metric, a number to reach, a window. Targets live here
-- (the host goals have no target fields); host_goal_id links the host goal
-- when the plugin could create one. status: proposed (an agent suggested it,
-- the owner has not confirmed) | active | achieved | missed | dropped.
-- metric_key: kpi:<plugin>:<kpi key> (a number a module reports), company:<metric>, or manual.
CREATE TABLE plugin_cockpit_b8a99e8b16.goals (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  title text NOT NULL,
  description text,
  metric_key text NOT NULL,
  metric_label text,
  unit text,
  direction text NOT NULL DEFAULT 'higher',
  target_value double precision NOT NULL,
  baseline_value double precision,
  period text NOT NULL DEFAULT 'week',
  due_on text,
  status text NOT NULL DEFAULT 'proposed',
  host_goal_id text,
  owner_agent_id text,
  last_value double precision,
  last_value_at timestamptz,
  proposed_by_agent_id text,
  confirmed_by_user_id text,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT goals_direction CHECK (direction IN ('lower', 'higher')),
  CONSTRAINT goals_period CHECK (period IN ('week', 'month', 'quarter', 'year')),
  CONSTRAINT goals_status CHECK (status IN ('proposed', 'active', 'achieved', 'missed', 'dropped'))
);
CREATE INDEX goals_company_status ON plugin_cockpit_b8a99e8b16.goals (company_id, status);

-- One value per goal and ISO week (the history the weekly review reads).
CREATE TABLE plugin_cockpit_b8a99e8b16.goal_values (
  company_id text NOT NULL,
  goal_id text NOT NULL,
  week_key text NOT NULL,
  value double precision,
  at timestamptz NOT NULL,
  source text,
  PRIMARY KEY (goal_id, week_key)
);

-- The weekly business review issue, one per company and ISO week.
CREATE TABLE plugin_cockpit_b8a99e8b16.business_reviews (
  company_id text NOT NULL,
  week_key text NOT NULL,
  issue_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, week_key)
);
