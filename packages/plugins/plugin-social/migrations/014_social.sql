-- 0.6.0: reliable lead hand-off and approved posts that keep their time.
-- - outbox (kit outboxMigration): lead.captured is stored and re-sent until the CRM answers lead.captured.result.
-- - posts.schedule_issue_id: the Social agent task that picks a time for an approved post without one.

CREATE TABLE plugin_social_e70c4e79f2.outbox (
  key text PRIMARY KEY,
  company_id text NOT NULL,
  event text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CONSTRAINT outbox_status CHECK (status IN ('pending', 'done', 'failed'))
);
CREATE INDEX outbox_due ON plugin_social_e70c4e79f2.outbox (status, next_attempt_at);

ALTER TABLE plugin_social_e70c4e79f2.posts ADD COLUMN IF NOT EXISTS schedule_issue_id text;
