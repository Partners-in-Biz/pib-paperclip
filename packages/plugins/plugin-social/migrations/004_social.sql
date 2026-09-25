CREATE TABLE plugin_social_e70c4e79f2.media_assets (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  name text NOT NULL,
  url text NOT NULL,
  kind text NOT NULL DEFAULT 'image',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX media_assets_workspace ON plugin_social_e70c4e79f2.media_assets (company_id);
