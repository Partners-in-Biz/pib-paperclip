-- Campaigns 0.3.0: send through the Mailbox, capture replies, Jev reply classification.

-- Campaigns: deliver due steps as issues (default) or as email; who gets reply issues.
ALTER TABLE plugin_campaigns_d355219713.campaigns
  ADD COLUMN delivery text NOT NULL DEFAULT 'issue',
  ADD COLUMN owner_user_id text,
  ADD COLUMN owner_agent_id text;

ALTER TABLE plugin_campaigns_d355219713.campaigns
  ADD CONSTRAINT campaigns_delivery CHECK (delivery IN ('issue', 'email'));

-- Enrollments: the outbox key of the step email in flight, and the Gmail thread.
ALTER TABLE plugin_campaigns_d355219713.campaign_enrollments
  ADD COLUMN sending_key text,
  ADD COLUMN mail_thread_id text,
  ADD COLUMN mail_last_message_id text;

CREATE INDEX campaign_enrollments_sending ON plugin_campaigns_d355219713.campaign_enrollments (sending_key) WHERE sending_key IS NOT NULL;

-- Step events: sends and replies from the Mailbox, per variant, once per source.
ALTER TABLE plugin_campaigns_d355219713.campaign_step_events
  DROP CONSTRAINT step_events_type;

ALTER TABLE plugin_campaigns_d355219713.campaign_step_events
  ADD CONSTRAINT step_events_type CHECK (event_type IN ('open', 'click', 'sent', 'reply', 'bounce', 'unsubscribe'));

ALTER TABLE plugin_campaigns_d355219713.campaign_step_events
  ADD COLUMN variant text,
  ADD COLUMN source_key text,
  ADD COLUMN meta jsonb;

CREATE UNIQUE INDEX step_events_source_key ON plugin_campaigns_d355219713.campaign_step_events (source_key) WHERE source_key IS NOT NULL;

CREATE INDEX step_events_enrollment ON plugin_campaigns_d355219713.campaign_step_events (enrollment_id, event_type);

-- Addresses that unsubscribed or bounced: never emailed by a campaign again.
CREATE TABLE plugin_campaigns_d355219713.suppressions (
  company_id text NOT NULL,
  email text NOT NULL,
  reason text NOT NULL,
  contact_id text,
  campaign_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, email),
  CONSTRAINT suppressions_reason CHECK (reason IN ('unsubscribe', 'bounce'))
);

-- Kit decisionsMigration
CREATE TABLE plugin_campaigns_d355219713.decisions (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  purpose text NOT NULL,
  subject_kind text NOT NULL,
  subject_id text NOT NULL,
  question_key text NOT NULL,
  answer_type text NOT NULL,
  value_text text,
  value_num numeric,
  confidence numeric NOT NULL,
  probabilities jsonb,
  model text NOT NULL,
  acted boolean NOT NULL DEFAULT false,
  corrected_to text,
  corrected_by text,
  corrected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX decisions_subject ON plugin_campaigns_d355219713.decisions (company_id, subject_kind, subject_id);
CREATE INDEX decisions_purpose ON plugin_campaigns_d355219713.decisions (company_id, purpose, created_at);

-- Kit inboxMigration
CREATE TABLE plugin_campaigns_d355219713.inbox (
  key text PRIMARY KEY,
  company_id text NOT NULL,
  event text NOT NULL,
  result jsonb,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- Kit outboxMigration
CREATE TABLE plugin_campaigns_d355219713.outbox (
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
CREATE INDEX outbox_due ON plugin_campaigns_d355219713.outbox (status, next_attempt_at);
