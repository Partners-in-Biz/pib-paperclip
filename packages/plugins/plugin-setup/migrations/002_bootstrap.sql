-- Setup -> New company: where each company bootstrap stands (one row per company).
-- status: created (the company exists, nothing run), running, partial or complete.
-- steps: one entry per step id with status, detail, at and items. grants: the one batched list of what only a person can do.
CREATE TABLE plugin_setup_48494712db.bootstrap_runs (
  company_id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'created',
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  steps jsonb NOT NULL DEFAULT '{}'::jsonb,
  grants jsonb NOT NULL DEFAULT '[]'::jsonb,
  source text NOT NULL DEFAULT 'company.created',
  started_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

-- The hire task Setup opened for each agent of the team template pack (one per company and template).
CREATE TABLE plugin_setup_48494712db.template_hires (
  company_id text NOT NULL,
  template_key text NOT NULL,
  pack_version integer NOT NULL,
  issue_id text NOT NULL,
  assignee_agent_id text,
  assignee_user_id text,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, template_key)
);

-- The owner approval of a memory starter pack version (by its content hash). No row means not approved, so it is never seeded.
CREATE TABLE plugin_setup_48494712db.starter_pack_approvals (
  pack_version integer NOT NULL,
  content_hash text NOT NULL,
  approved_by text NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pack_version, content_hash)
);

-- What was imported into which company (so a repeat is visible, and a changed pack needs a new approval).
CREATE TABLE plugin_setup_48494712db.starter_pack_imports (
  company_id text NOT NULL,
  pack_version integer NOT NULL,
  content_hash text NOT NULL,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  imported_by text,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, pack_version, content_hash)
);
