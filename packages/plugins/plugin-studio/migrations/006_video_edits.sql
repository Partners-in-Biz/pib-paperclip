-- Studio video edits, their named versions, and render jobs (PAR-8285, program PAR-8276 Phase A). New tables only.
-- video_renders holds one row per render job. The partial unique index video_renders_one_active lets at most one job be
-- rendering or uploading at a time, so two workers can never both claim the render slot.
-- Rollback: reinstall the previous Studio build (the tables are then unused and harmless), then if wanted:
--   DROP TABLE plugin_studio_e414325bb6.video_renders, plugin_studio_e414325bb6.video_edit_versions, plugin_studio_e414325bb6.video_edits
CREATE TABLE plugin_studio_e414325bb6.video_edits (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  client_kind text,
  client_ref text,
  client_name text,
  project_id text,
  title text NOT NULL,
  doc jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  source_asset_id text,
  archived_at timestamptz,
  created_by_user_id text,
  created_by_agent_id text,
  updated_by_user_id text,
  updated_by_agent_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX video_edits_company ON plugin_studio_e414325bb6.video_edits (company_id, updated_at DESC);

CREATE TABLE plugin_studio_e414325bb6.video_edit_versions (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  edit_id text NOT NULL,
  name text NOT NULL,
  doc jsonb NOT NULL,
  revision integer NOT NULL,
  created_by_user_id text,
  created_by_agent_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX video_edit_versions_edit ON plugin_studio_e414325bb6.video_edit_versions (company_id, edit_id, created_at DESC);

CREATE TABLE plugin_studio_e414325bb6.video_renders (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  client_kind text,
  client_ref text,
  edit_id text NOT NULL,
  edit_revision integer NOT NULL,
  doc jsonb NOT NULL,
  preset text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'rendering', 'uploading', 'succeeded', 'failed', 'cancelled')),
  claim_token text,
  pid integer,
  workdir text,
  heartbeat_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  error_kind text CHECK (error_kind IS NULL OR error_kind IN ('deterministic', 'infra')),
  asset_id text,
  preview_r2_key text,
  error text,
  stderr_tail text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX video_renders_queue ON plugin_studio_e414325bb6.video_renders (status, created_at);

CREATE INDEX video_renders_edit ON plugin_studio_e414325bb6.video_renders (company_id, edit_id, created_at DESC);

CREATE UNIQUE INDEX video_renders_one_active ON plugin_studio_e414325bb6.video_renders ((true)) WHERE status IN ('rendering', 'uploading');
