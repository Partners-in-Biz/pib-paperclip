-- Per-person access, stage A (PAR-12578 plan, 4.1 and 4.2). Setup is the one source of the access switch.
-- access_settings: one row per company. mode is off, report or enforce. rev goes up by one on every grant or
-- switch change. granted_user_ids lists the people with a grant (a job can not list plugin state).
-- access_sync: the newest rev each guarded plugin confirmed for a company.
-- access_refusals: what a guard refused or would have refused; Setup keeps the last 500 per company.
-- Keep quote characters out of these comments: the host migration check strips quoted text before comments.
-- Undo: DROP TABLE plugin_setup_48494712db.access_refusals, plugin_setup_48494712db.access_sync,
-- plugin_setup_48494712db.access_settings (the old code never reads them).
CREATE TABLE plugin_setup_48494712db.access_settings (
  company_id text PRIMARY KEY,
  mode text NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'report', 'enforce')),
  rev integer NOT NULL DEFAULT 0 CHECK (rev >= 0),
  granted_user_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

CREATE TABLE plugin_setup_48494712db.access_sync (
  company_id text NOT NULL,
  plugin_key text NOT NULL,
  rev integer NOT NULL CHECK (rev >= 0),
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, plugin_key)
);

CREATE TABLE plugin_setup_48494712db.access_refusals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL,
  plugin_key text NOT NULL,
  user_id text,
  key text NOT NULL,
  permission text,
  via_agent_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX access_refusals_company_created_idx ON plugin_setup_48494712db.access_refusals (company_id, created_at DESC);
