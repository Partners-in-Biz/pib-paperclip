CREATE TABLE plugin_seo_8099f8879a.crm_sites (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  client_kind text NOT NULL,
  client_ref text NOT NULL,
  label text,
  url text NOT NULL,
  platform text NOT NULL,
  seo_plugin text,
  hosting text,
  access text[] NOT NULL DEFAULT '{}',
  project_id text,
  connector_status text NOT NULL DEFAULT 'none',
  connector_version text,
  connector_seen_at timestamptz,
  updated_at timestamptz NOT NULL,
  deleted boolean NOT NULL DEFAULT false
);
CREATE INDEX crm_sites_client ON plugin_seo_8099f8879a.crm_sites (company_id, client_kind, client_ref);

-- 0.10.0: a fourth site access mode, wordpress. The sprint picks one of its CRM client's
-- websites (crm_sites above, projected from the CRM's site.upserted / site.deleted events)
-- and every SEO change goes through the CRM's PiB Connector tools with that site id.
ALTER TABLE plugin_seo_8099f8879a.sprints ADD COLUMN site_id text;

ALTER TABLE plugin_seo_8099f8879a.sprints DROP CONSTRAINT sprints_site_access_check;

ALTER TABLE plugin_seo_8099f8879a.sprints ADD CONSTRAINT sprints_site_access_check CHECK (site_access IN ('unlinked', 'repo', 'none', 'wordpress'));
