-- CRM 0.18.0: Drive tables. Additive, nothing dropped. Rollback: old code ignores the tables.

-- Keyed by project so it also holds own products and books (no client link).
CREATE TABLE IF NOT EXISTS plugin_crm_832258244c.project_drive_kind (
  company_id text NOT NULL,
  project_id text NOT NULL,
  kind text NOT NULL,
  scope_ref text,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, project_id)
);

CREATE TABLE IF NOT EXISTS plugin_crm_832258244c.drive_files (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  project_id text,
  kind text NOT NULL,
  folder_id text NOT NULL,
  name text NOT NULL,
  sha256 text NOT NULL,
  drive_file_id text NOT NULL,
  web_url text NOT NULL,
  source_plugin text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT drive_files_folder_name_sha UNIQUE (company_id, folder_id, name, sha256)
);

CREATE INDEX IF NOT EXISTS drive_files_company_project ON plugin_crm_832258244c.drive_files (company_id, project_id, created_at DESC);
