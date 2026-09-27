-- Mailbox 0.3.0: a do-not-email list checked on every send, and the outbox that hands leads to the CRM until it answers.

CREATE TABLE plugin_mailbox_319145c88b.suppressions (
  company_id text NOT NULL,
  email text NOT NULL,
  scope text NOT NULL,
  reason text NOT NULL,
  source text NOT NULL,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, email),
  CONSTRAINT suppressions_scope CHECK (scope IN ('marketing', 'all')),
  CONSTRAINT suppressions_reason CHECK (reason IN ('unsubscribed', 'bounced', 'complained', 'manual'))
);

CREATE INDEX suppressions_source_created ON plugin_mailbox_319145c88b.suppressions (source, created_at);

-- Recipients a send left out because they were on the list.
ALTER TABLE plugin_mailbox_319145c88b.send_requests
  ADD COLUMN skipped jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Kit outboxMigration
CREATE TABLE plugin_mailbox_319145c88b.outbox (
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
CREATE INDEX outbox_due ON plugin_mailbox_319145c88b.outbox (status, next_attempt_at);
