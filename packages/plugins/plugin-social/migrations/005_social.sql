CREATE TABLE plugin_social_e70c4e79f2.rss_feeds (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  url text NOT NULL,
  account_id text REFERENCES plugin_social_e70c4e79f2.accounts (id),
  is_active boolean NOT NULL DEFAULT true,
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX rss_feeds_workspace ON plugin_social_e70c4e79f2.rss_feeds (company_id);
