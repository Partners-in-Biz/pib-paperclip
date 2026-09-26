-- Which modules each company uses. No row = every module on.
CREATE TABLE plugin_setup_48494712db.module_choices (
  company_id text PRIMARY KEY,
  modules jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

-- Latest setup status each plugin pushed for a company (plugin.<key>.setup.status).
CREATE TABLE plugin_setup_48494712db.statuses (
  company_id text NOT NULL,
  plugin_key text NOT NULL,
  status jsonb NOT NULL,
  checked_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, plugin_key)
);

-- The open "Finish setup" issue per company.
CREATE TABLE plugin_setup_48494712db.finish_issues (
  company_id text PRIMARY KEY,
  issue_id text NOT NULL,
  fingerprint text NOT NULL DEFAULT '',
  missing_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
