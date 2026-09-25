-- OAuth account connections + publish outcomes (real platform API publishing)
ALTER TABLE plugin_social_e70c4e79f2.accounts
  ADD COLUMN external_id text,
  ADD COLUMN handle text,
  ADD COLUMN avatar_url text,
  ADD COLUMN token_enc text,
  ADD COLUMN refresh_token_enc text,
  ADD COLUMN token_expires_at timestamptz,
  ADD COLUMN scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE plugin_social_e70c4e79f2.posts
  ADD COLUMN external_id text,
  ADD COLUMN error text;

CREATE TABLE plugin_social_e70c4e79f2.oauth_sessions (
  state text PRIMARY KEY,
  company_id text NOT NULL,
  platform text NOT NULL,
  account_label text,
  extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX oauth_sessions_exp ON plugin_social_e70c4e79f2.oauth_sessions (expires_at);
