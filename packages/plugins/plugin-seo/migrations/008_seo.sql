-- Per-sprint integrations (tokens sealed with the configured key) and OAuth state.
CREATE TABLE plugin_seo_8099f8879a.integrations (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  sprint_id text NOT NULL REFERENCES plugin_seo_8099f8879a.sprints (id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('gsc', 'bing', 'pagespeed')),
  status text NOT NULL DEFAULT 'disconnected' CHECK (status IN ('disconnected', 'connected', 'needs_reconnect', 'enabled', 'disabled', 'error')),
  property_url text,
  token_sealed text,
  expires_at timestamptz,
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  key_version integer,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_pull_at timestamptz,
  last_error text,
  alert_issue_id text,
  connected_by_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX integrations_sprint_provider ON plugin_seo_8099f8879a.integrations (sprint_id, provider);

CREATE TABLE plugin_seo_8099f8879a.oauth_sessions (
  state text PRIMARY KEY,
  company_id text NOT NULL,
  sprint_id text NOT NULL,
  provider text NOT NULL,
  created_by_user_id text,
  return_to text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX oauth_sessions_expiry ON plugin_seo_8099f8879a.oauth_sessions (expires_at);
