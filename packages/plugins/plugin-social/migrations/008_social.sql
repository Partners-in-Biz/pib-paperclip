-- Phase 1: accounts carry a client, status and platform meta; posts carry
-- media, overrides and a first comment; destinations carry retry state and
-- the platform result. Junk rows (no token, no secret) are removed at runtime.

ALTER TABLE plugin_social_e70c4e79f2.accounts
  ADD COLUMN IF NOT EXISTS client_ref text,
  ADD COLUMN IF NOT EXISTS client_name text,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS key_version integer,
  ADD COLUMN IF NOT EXISTS created_by_user_id text,
  ADD COLUMN IF NOT EXISTS reconnect_issue_id text,
  ADD COLUMN IF NOT EXISTS refresh_lock_until timestamptz,
  ADD COLUMN IF NOT EXISTS last_refreshed_at timestamptz;

UPDATE plugin_social_e70c4e79f2.accounts
   SET status = 'connected'
 WHERE status NOT IN ('connected', 'expiring', 'needs_reconnect', 'disabled');

ALTER TABLE plugin_social_e70c4e79f2.accounts
  ADD CONSTRAINT accounts_status CHECK (status IN ('connected', 'expiring', 'needs_reconnect', 'disabled'));

CREATE INDEX IF NOT EXISTS accounts_platform_external ON plugin_social_e70c4e79f2.accounts (company_id, platform, external_id);

CREATE INDEX IF NOT EXISTS accounts_expiry ON plugin_social_e70c4e79f2.accounts (token_expires_at);

ALTER TABLE plugin_social_e70c4e79f2.posts
  ADD COLUMN IF NOT EXISTS client_ref text,
  ADD COLUMN IF NOT EXISTS client_name text,
  ADD COLUMN IF NOT EXISTS first_comment text,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS source_ref text,
  ADD COLUMN IF NOT EXISTS failure_issue_id text,
  ADD COLUMN IF NOT EXISTS published_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_by_agent_id text;

UPDATE plugin_social_e70c4e79f2.posts SET media = '[]'::jsonb WHERE jsonb_typeof(media) <> 'array';

UPDATE plugin_social_e70c4e79f2.posts SET overrides = '{}'::jsonb WHERE jsonb_typeof(overrides) <> 'object';

ALTER TABLE plugin_social_e70c4e79f2.posts DROP CONSTRAINT IF EXISTS posts_status;

ALTER TABLE plugin_social_e70c4e79f2.posts
  ADD CONSTRAINT posts_status CHECK (status IN ('draft', 'review', 'approved', 'scheduled', 'publishing', 'published', 'partially_published', 'failed'));

CREATE INDEX IF NOT EXISTS posts_client ON plugin_social_e70c4e79f2.posts (company_id, client_ref);

ALTER TABLE plugin_social_e70c4e79f2.destinations
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS external_id text,
  ADD COLUMN IF NOT EXISTS external_url text,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS published_at timestamptz,
  ADD COLUMN IF NOT EXISTS issue_id text,
  ADD COLUMN IF NOT EXISTS claim_token text,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS metric_windows text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE plugin_social_e70c4e79f2.destinations
   SET external_id = result->>'externalId', external_url = result->>'url'
 WHERE status = 'published' AND external_id IS NULL;

UPDATE plugin_social_e70c4e79f2.destinations
   SET status = 'failed'
 WHERE status NOT IN ('pending', 'publishing', 'retrying', 'published', 'failed');

ALTER TABLE plugin_social_e70c4e79f2.destinations
  ADD CONSTRAINT destinations_status CHECK (status IN ('pending', 'publishing', 'retrying', 'published', 'failed'));

CREATE INDEX IF NOT EXISTS destinations_due ON plugin_social_e70c4e79f2.destinations (status, next_attempt_at);

CREATE INDEX IF NOT EXISTS destinations_claim ON plugin_social_e70c4e79f2.destinations (claim_token);

CREATE INDEX IF NOT EXISTS destinations_account ON plugin_social_e70c4e79f2.destinations (account_id);

ALTER TABLE plugin_social_e70c4e79f2.destinations DROP CONSTRAINT IF EXISTS destinations_post_id_fkey;

ALTER TABLE plugin_social_e70c4e79f2.destinations
  ADD CONSTRAINT destinations_post_id_fkey FOREIGN KEY (post_id) REFERENCES plugin_social_e70c4e79f2.posts (id) ON DELETE CASCADE;

ALTER TABLE plugin_social_e70c4e79f2.destinations DROP CONSTRAINT IF EXISTS destinations_account_id_fkey;

ALTER TABLE plugin_social_e70c4e79f2.destinations
  ADD CONSTRAINT destinations_account_id_fkey FOREIGN KEY (account_id) REFERENCES plugin_social_e70c4e79f2.accounts (id) ON DELETE CASCADE;

ALTER TABLE plugin_social_e70c4e79f2.post_metrics DROP CONSTRAINT IF EXISTS post_metrics_post_id_fkey;

ALTER TABLE plugin_social_e70c4e79f2.post_metrics
  ADD CONSTRAINT post_metrics_post_id_fkey FOREIGN KEY (post_id) REFERENCES plugin_social_e70c4e79f2.posts (id) ON DELETE CASCADE;

ALTER TABLE plugin_social_e70c4e79f2.rss_feeds DROP CONSTRAINT IF EXISTS rss_feeds_account_id_fkey;

ALTER TABLE plugin_social_e70c4e79f2.rss_feeds
  ADD CONSTRAINT rss_feeds_account_id_fkey FOREIGN KEY (account_id) REFERENCES plugin_social_e70c4e79f2.accounts (id) ON DELETE SET NULL;

ALTER TABLE plugin_social_e70c4e79f2.inbox_items DROP CONSTRAINT IF EXISTS inbox_items_account_id_fkey;

ALTER TABLE plugin_social_e70c4e79f2.inbox_items
  ADD CONSTRAINT inbox_items_account_id_fkey FOREIGN KEY (account_id) REFERENCES plugin_social_e70c4e79f2.accounts (id) ON DELETE SET NULL;

ALTER TABLE plugin_social_e70c4e79f2.media_assets
  ADD COLUMN IF NOT EXISTS r2_key text,
  ADD COLUMN IF NOT EXISTS mime text,
  ADD COLUMN IF NOT EXISTS bytes bigint,
  ADD COLUMN IF NOT EXISTS width integer,
  ADD COLUMN IF NOT EXISTS height integer,
  ADD COLUMN IF NOT EXISTS duration_s numeric,
  ADD COLUMN IF NOT EXISTS alt_text text,
  ADD COLUMN IF NOT EXISTS client_ref text,
  ADD COLUMN IF NOT EXISTS client_name text,
  ADD COLUMN IF NOT EXISTS source_url text;

ALTER TABLE plugin_social_e70c4e79f2.oauth_sessions
  ADD COLUMN IF NOT EXISTS pending_options text,
  ADD COLUMN IF NOT EXISTS created_by_user_id text,
  ADD COLUMN IF NOT EXISTS picker_id text,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'started';

CREATE UNIQUE INDEX IF NOT EXISTS oauth_sessions_picker ON plugin_social_e70c4e79f2.oauth_sessions (picker_id);
