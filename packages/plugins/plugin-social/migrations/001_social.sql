CREATE TABLE plugin_social_e70c4e79f2.accounts (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  platform text NOT NULL,
  scope text NOT NULL,
  owner_user_id text,
  status text NOT NULL DEFAULT 'connected',
  secret_ref text,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounts_scope CHECK (scope IN ('org', 'personal'))
);

CREATE INDEX accounts_workspace ON plugin_social_e70c4e79f2.accounts (company_id);

CREATE TABLE plugin_social_e70c4e79f2.posts (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  body text NOT NULL,
  overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  media jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'draft',
  scheduled_at timestamptz,
  scope text NOT NULL DEFAULT 'org',
  owner_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT posts_status CHECK (status IN ('draft', 'review', 'approved', 'scheduled', 'publishing', 'published', 'failed')),
  CONSTRAINT posts_scope CHECK (scope IN ('org', 'personal'))
);

CREATE INDEX posts_due ON plugin_social_e70c4e79f2.posts (scheduled_at) WHERE status = 'scheduled';

CREATE TABLE plugin_social_e70c4e79f2.destinations (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  post_id text NOT NULL REFERENCES plugin_social_e70c4e79f2.posts (id),
  account_id text NOT NULL REFERENCES plugin_social_e70c4e79f2.accounts (id),
  status text NOT NULL DEFAULT 'pending',
  result jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX destinations_post_account ON plugin_social_e70c4e79f2.destinations (post_id, account_id);
