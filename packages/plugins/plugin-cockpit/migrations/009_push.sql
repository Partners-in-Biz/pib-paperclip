-- 009: Push notification store tables for the web push spike.
-- - push_keys: single VAPID key pair (id 'vapid')
-- - push_subscriptions: browser device subscriptions per user
-- - push_log: notification delivery log for audit and rate limiting
-- - push_rate: sliding-window rate limiting per key
-- - push_seen_assignee: track which assignee a user has seen for an issue

CREATE TABLE IF NOT EXISTS plugin_cockpit_b8a99e8b16.push_keys (
  id text PRIMARY KEY,
  public_key text NOT NULL,
  private_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plugin_cockpit_b8a99e8b16.push_subscriptions (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  user_id text NOT NULL,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  device_label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_ok_at timestamptz,
  last_error text,
  state text NOT NULL DEFAULT 'ok' CHECK (state IN ('ok', 'muted', 'needs_resubscribe'))
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON plugin_cockpit_b8a99e8b16.push_subscriptions (company_id, user_id);

CREATE TABLE IF NOT EXISTS plugin_cockpit_b8a99e8b16.push_log (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  class text NOT NULL,
  issue_ref text,
  title text,
  status text NOT NULL CHECK (status IN ('sent', 'collapsed', 'deferred', 'dropped', 'capped')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_log_company_status_idx ON plugin_cockpit_b8a99e8b16.push_log (company_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS plugin_cockpit_b8a99e8b16.push_rate (
  key text NOT NULL,
  window_start timestamptz NOT NULL,
  n integer NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

CREATE TABLE IF NOT EXISTS plugin_cockpit_b8a99e8b16.push_seen_assignee (
  company_id text NOT NULL,
  issue_id text NOT NULL,
  assignee_user_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, issue_id)
);
