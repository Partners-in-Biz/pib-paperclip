CREATE TABLE plugin_seo_8099f8879a.sprints (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  name text NOT NULL,
  site_url text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plugin_seo_8099f8879a.keywords (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  sprint_id text NOT NULL REFERENCES plugin_seo_8099f8879a.sprints (id),
  phrase text NOT NULL,
  rank integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plugin_seo_8099f8879a.pages (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  sprint_id text NOT NULL REFERENCES plugin_seo_8099f8879a.sprints (id),
  url text NOT NULL,
  title text NOT NULL DEFAULT ''
);

CREATE TABLE plugin_seo_8099f8879a.audits (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  sprint_id text NOT NULL REFERENCES plugin_seo_8099f8879a.sprints (id),
  finding text NOT NULL,
  severity text NOT NULL DEFAULT 'info',
  created_at timestamptz NOT NULL DEFAULT now()
);
