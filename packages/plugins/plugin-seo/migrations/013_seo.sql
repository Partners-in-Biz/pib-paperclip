-- Learned playbook (0.7.0): one versioned markdown playbook per scope (one CRM client, or
-- Partners in Biz's own sites) shared by every sprint in that scope. The SEO agent reads it
-- before working tasks. Measured optimizations and the agent propose changes; a person keeps
-- or discards them (the agent only when the sprint's autopilot is full).
-- scope_key: 'own', 'company:<CRM id>' or 'contact:<CRM id>'.
CREATE TABLE plugin_seo_8099f8879a.playbooks (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  scope_key text NOT NULL,
  client_kind text,
  client_ref text,
  client_name text,
  playbook text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT playbooks_client_kind_check CHECK (
    (client_ref IS NULL AND client_kind IS NULL) OR (client_ref IS NOT NULL AND client_kind IN ('company', 'contact'))
  )
);

CREATE UNIQUE INDEX playbooks_scope ON plugin_seo_8099f8879a.playbooks (company_id, scope_key);

-- Every version of a playbook, with why it changed and what decided it.
CREATE TABLE plugin_seo_8099f8879a.playbook_versions (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  playbook_id text NOT NULL REFERENCES plugin_seo_8099f8879a.playbooks (id) ON DELETE CASCADE,
  version integer NOT NULL,
  playbook text NOT NULL,
  reason text NOT NULL,
  optimization_id text,
  change_id text,
  decided_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (playbook_id, version)
);

-- Proposed edits: add a line to a section, remove a line, or replace the whole playbook.
-- source: measured (drafted by the plugin from a measured optimization), agent or person.
CREATE TABLE plugin_seo_8099f8879a.playbook_changes (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  playbook_id text NOT NULL REFERENCES plugin_seo_8099f8879a.playbooks (id) ON DELETE CASCADE,
  sprint_id text REFERENCES plugin_seo_8099f8879a.sprints (id) ON DELETE SET NULL,
  optimization_id text,
  source text NOT NULL DEFAULT 'agent',
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
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT playbook_changes_source_check CHECK (source IN ('measured', 'agent', 'person')),
  CONSTRAINT playbook_changes_op_check CHECK (op IN ('add', 'remove', 'replace')),
  CONSTRAINT playbook_changes_status_check CHECK (status IN ('pending', 'kept', 'discarded'))
);

CREATE INDEX playbook_changes_playbook ON plugin_seo_8099f8879a.playbook_changes (playbook_id, status);

CREATE INDEX playbook_changes_sprint ON plugin_seo_8099f8879a.playbook_changes (sprint_id, status);

-- One drafted change per measured optimization.
CREATE UNIQUE INDEX playbook_changes_measured ON plugin_seo_8099f8879a.playbook_changes (optimization_id) WHERE source = 'measured';
