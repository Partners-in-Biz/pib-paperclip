-- 0.7.0: sign-off lock for client websites. The SEO plugin marks a site "sign-off required" (change policy pr_only):
-- agents cannot write to it through the Connector tools unless a person has approved applying changes
-- (approved_until). People are never blocked. Both facts arrive as plugin events from the SEO plugin.
CREATE TABLE plugin_crm_832258244c.site_signoff (
  site_id text PRIMARY KEY,
  company_id text NOT NULL,
  required boolean NOT NULL DEFAULT true,
  approved_until timestamptz,
  approved_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
