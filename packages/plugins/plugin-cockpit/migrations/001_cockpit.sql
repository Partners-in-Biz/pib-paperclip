-- Latest report each PiB plugin pushed for a company:
--   kind 'cockpit' = plugin.<key>.cockpit.snapshot (kit CockpitSnapshot)
--   kind 'setup'   = plugin.<key>.setup.status (kit SetupStatus)
-- An older checked_at never replaces a newer one.
CREATE TABLE plugin_cockpit_b8a99e8b16.snapshots (
  company_id text NOT NULL,
  plugin_key text NOT NULL,
  kind text NOT NULL DEFAULT 'cockpit',
  payload jsonb NOT NULL,
  checked_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, plugin_key, kind)
);

-- Team roles per company (kit RolesPayload). A row = Cockpit settings were saved.
CREATE TABLE plugin_cockpit_b8a99e8b16.roles (
  company_id text PRIMARY KEY,
  operator_agent_id text,
  reviewer_agent_id text,
  owner_user_id text,
  review_outward boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

-- The one open "System health" issue per company.
CREATE TABLE plugin_cockpit_b8a99e8b16.health_issues (
  company_id text PRIMARY KEY,
  issue_id text NOT NULL,
  fingerprint text NOT NULL DEFAULT '',
  problem_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The pinned "Daily brief" issue per company and ISO week (e.g. 2026-W39).
CREATE TABLE plugin_cockpit_b8a99e8b16.brief_issues (
  company_id text NOT NULL,
  week_key text NOT NULL,
  issue_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, week_key)
);
