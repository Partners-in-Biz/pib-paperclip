-- Mastodon app registrations, RSS dedupe, metric windows and inbox dedupe.
CREATE TABLE plugin_social_e70c4e79f2.mastodon_apps (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  instance_url text NOT NULL,
  client_id text NOT NULL,
  client_secret_enc text NOT NULL,
  redirect_uri text NOT NULL,
  key_version integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX mastodon_apps_instance ON plugin_social_e70c4e79f2.mastodon_apps (company_id, instance_url);

ALTER TABLE plugin_social_e70c4e79f2.rss_feeds
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS client_ref text,
  ADD COLUMN IF NOT EXISTS client_name text,
  ADD COLUMN IF NOT EXISTS account_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS last_item_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_by_user_id text;

CREATE TABLE plugin_social_e70c4e79f2.rss_seen_items (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  feed_id text NOT NULL REFERENCES plugin_social_e70c4e79f2.rss_feeds (id) ON DELETE CASCADE,
  item_key text NOT NULL,
  title text,
  link text,
  published_at timestamptz,
  post_id text,
  seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX rss_seen_items_key ON plugin_social_e70c4e79f2.rss_seen_items (feed_id, item_key);

ALTER TABLE plugin_social_e70c4e79f2.post_metrics
  ADD COLUMN IF NOT EXISTS destination_id text,
  ADD COLUMN IF NOT EXISTS account_id text,
  ADD COLUMN IF NOT EXISTS platform text,
  ADD COLUMN IF NOT EXISTS metric_window text,
  ADD COLUMN IF NOT EXISTS impressions integer,
  ADD COLUMN IF NOT EXISTS reach integer,
  ADD COLUMN IF NOT EXISTS saves integer,
  ADD COLUMN IF NOT EXISTS clicks integer,
  ADD COLUMN IF NOT EXISTS raw jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE UNIQUE INDEX post_metrics_window ON plugin_social_e70c4e79f2.post_metrics (destination_id, metric_window);

ALTER TABLE plugin_social_e70c4e79f2.inbox_items
  ADD COLUMN IF NOT EXISTS platform text,
  ADD COLUMN IF NOT EXISTS external_id text,
  ADD COLUMN IF NOT EXISTS parent_external_id text,
  ADD COLUMN IF NOT EXISTS permalink text,
  ADD COLUMN IF NOT EXISTS destination_id text,
  ADD COLUMN IF NOT EXISTS post_id text,
  ADD COLUMN IF NOT EXISTS reply_draft text,
  ADD COLUMN IF NOT EXISTS reply_body text,
  ADD COLUMN IF NOT EXISTS reply_external_id text,
  ADD COLUMN IF NOT EXISTS replied_at timestamptz,
  ADD COLUMN IF NOT EXISTS received_at timestamptz,
  ADD COLUMN IF NOT EXISTS client_ref text;
CREATE UNIQUE INDEX inbox_items_external ON plugin_social_e70c4e79f2.inbox_items (account_id, external_id);
