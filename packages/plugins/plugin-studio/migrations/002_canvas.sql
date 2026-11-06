-- Studio canvas boards (PAR-7753 Slice 1). Rollback: reinstall 0.1.4; this table is then unused and harmless.
CREATE TABLE plugin_studio_e414325bb6.canvases (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  client_kind text,
  client_ref text,
  client_name text,
  project_id text,
  title text NOT NULL,
  doc jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  archived_at timestamptz,
  created_by_user_id text,
  created_by_agent_id text,
  updated_by_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX canvases_company ON plugin_studio_e414325bb6.canvases (company_id, updated_at DESC);
