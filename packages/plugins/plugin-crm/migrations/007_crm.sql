-- CRM 0.6.0: client websites (several per client), the PiB Connector key for
-- WordPress sites, every change made through the Connector, and the Paperclip
-- projects that belong to a client.

CREATE TABLE plugin_crm_832258244c.client_sites (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  client_kind text NOT NULL,
  client_ref text NOT NULL,
  label text,
  url text NOT NULL,
  site_key text NOT NULL,
  platform text NOT NULL DEFAULT 'other',
  seo_plugin text,
  hosting text,
  access jsonb NOT NULL DEFAULT '[]'::jsonb,
  project_id text,
  web_root text,
  notes text,
  connector_key text,
  connector_status text NOT NULL DEFAULT 'none',
  connector_version text,
  connector_seen_at timestamptz,
  connector_error text,
  health jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_sites_kind CHECK (client_kind IN ('company', 'contact')),
  CONSTRAINT client_sites_platform CHECK (platform IN ('wordpress', 'nextjs', 'custom', 'shopify', 'wix', 'other')),
  CONSTRAINT client_sites_seo_plugin CHECK (seo_plugin IS NULL OR seo_plugin IN ('yoast', 'rankmath', 'none')),
  CONSTRAINT client_sites_connector_status CHECK (connector_status IN ('none', 'pending', 'connected', 'error'))
);

-- One record per site host in a company (www and https do not count as different sites).
CREATE UNIQUE INDEX client_sites_key ON plugin_crm_832258244c.client_sites (company_id, site_key);

CREATE INDEX client_sites_client ON plugin_crm_832258244c.client_sites (company_id, client_kind, client_ref);

-- Every call that changed a site through the Connector, as Paperclip saw it (the site keeps its own log too).
CREATE TABLE plugin_crm_832258244c.site_changes (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  site_id text NOT NULL,
  endpoint text NOT NULL,
  target text,
  reason text,
  change_ref text,
  ok boolean NOT NULL,
  error text,
  actor text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX site_changes_site ON plugin_crm_832258244c.site_changes (company_id, site_id, created_at);

-- Paperclip projects of a client (its code folders). A project belongs to one client.
CREATE TABLE plugin_crm_832258244c.client_projects (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  client_kind text NOT NULL,
  client_ref text NOT NULL,
  project_id text NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_projects_kind CHECK (client_kind IN ('company', 'contact'))
);

CREATE UNIQUE INDEX client_projects_project ON plugin_crm_832258244c.client_projects (company_id, project_id);

CREATE INDEX client_projects_client ON plugin_crm_832258244c.client_projects (company_id, client_kind, client_ref);
