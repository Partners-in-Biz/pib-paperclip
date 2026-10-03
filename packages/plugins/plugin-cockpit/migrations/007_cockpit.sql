-- 0.5.1: acceptance runs on the canary client (Q5-1), the plugin versions the
-- Cockpit has seen (the release trigger), and the golden-scenario results that
-- gate a skill change (Q5-3, Q2-11, Q10-5).

-- One acceptance run: a scripted customer journey worked through step by step
-- on the canary client. state holds the captured values and the result of each step
-- and evidence; the report and the failure issues are written when it ends.
-- status: running | passed | failed | aborted. trigger: nightly | release | on-demand.
CREATE TABLE plugin_cockpit_b8a99e8b16.acceptance_runs (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  journey_key text NOT NULL,
  journey_version integer NOT NULL,
  client_ref text NOT NULL,
  trigger text NOT NULL,
  trigger_ref text,
  status text NOT NULL DEFAULT 'running',
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_issue_id text,
  report_issue_id text,
  child_issue_ids jsonb NOT NULL DEFAULT '{}'::jsonb,
  agent_id text,
  summary text,
  report text,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT acceptance_runs_status CHECK (status IN ('running', 'passed', 'failed', 'aborted')),
  CONSTRAINT acceptance_runs_trigger CHECK (trigger IN ('nightly', 'release', 'on-demand'))
);
CREATE INDEX acceptance_runs_recent ON plugin_cockpit_b8a99e8b16.acceptance_runs (company_id, journey_key, started_at DESC);

-- A request for the Acceptance agent, one per (company, request key): a night
-- (`nightly:2026-10-04`), a release (`release:partnersinbiz.crm:0.12.0`) or a
-- a person asking. The key is claimed first, so an event and a sweep never open two.
CREATE TABLE plugin_cockpit_b8a99e8b16.acceptance_requests (
  company_id text NOT NULL,
  request_key text NOT NULL,
  trigger text NOT NULL,
  issue_id text,
  journeys jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, request_key)
);

-- The version each plugin last reported in its setup status, per company. A
-- different version than the one kept here is a release.
CREATE TABLE plugin_cockpit_b8a99e8b16.plugin_versions (
  company_id text NOT NULL,
  plugin_key text NOT NULL,
  version text NOT NULL,
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, plugin_key)
);

-- One graded run of a golden scenario: the harness issue it ran in, the skill
-- version (content hash) it ran against, and what the grader found. The
-- unique index on the harness issue means a run is graded once.
-- mode: live (the skill as deployed) | candidate (a changed skill installed as a test copy).
CREATE TABLE plugin_cockpit_b8a99e8b16.eval_results (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  skill_slug text NOT NULL,
  skill_hash text NOT NULL,
  scenario_id text NOT NULL,
  scenario_hash text NOT NULL,
  mode text NOT NULL,
  harness_issue_id text NOT NULL,
  harness_run_id text,
  agent_id text,
  passed boolean NOT NULL,
  checks jsonb NOT NULL DEFAULT '[]'::jsonb,
  plan_excerpt text,
  baseline boolean NOT NULL DEFAULT false,
  graded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT eval_results_mode CHECK (mode IN ('live', 'candidate'))
);
CREATE UNIQUE INDEX eval_results_issue ON plugin_cockpit_b8a99e8b16.eval_results (company_id, harness_issue_id);
CREATE INDEX eval_results_skill ON plugin_cockpit_b8a99e8b16.eval_results (company_id, skill_slug, skill_hash, scenario_id, graded_at DESC);
