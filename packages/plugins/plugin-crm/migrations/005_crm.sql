-- Mailbox replies, Jev lead scores and email sequences (CRM 0.3.0).

-- Contacts: email suppression and the Jev lead score (levels 0-3).
ALTER TABLE plugin_crm_832258244c.contacts
  ADD COLUMN email_status text NOT NULL DEFAULT 'ok',
  ADD COLUMN lead_fit numeric,
  ADD COLUMN lead_intent numeric,
  ADD COLUMN lead_urgency numeric,
  ADD COLUMN lead_confidence numeric,
  ADD COLUMN lead_scored_at timestamptz;

ALTER TABLE plugin_crm_832258244c.contacts
  ADD CONSTRAINT contacts_email_status CHECK (email_status IN ('ok', 'bounced', 'unsubscribed'));

-- Activities: Gmail ids and an idempotency key for events that may arrive twice.
ALTER TABLE plugin_crm_832258244c.activities
  ADD COLUMN meta jsonb,
  ADD COLUMN source_key text;

CREATE UNIQUE INDEX activities_source_key ON plugin_crm_832258244c.activities (source_key) WHERE source_key IS NOT NULL;

-- Sequences: deliver steps as issues (default) or as email through the Mailbox after a board user approves.
ALTER TABLE plugin_crm_832258244c.sequences
  ADD COLUMN delivery text NOT NULL DEFAULT 'issue',
  ADD COLUMN email_approval_issue_id text,
  ADD COLUMN email_approved_at timestamptz,
  ADD COLUMN email_approved_by text;

ALTER TABLE plugin_crm_832258244c.sequences
  ADD CONSTRAINT sequences_delivery CHECK (delivery IN ('issue', 'email'));

-- Enrollments: the outbox key of the email in flight, and the Gmail thread to reply in.
ALTER TABLE plugin_crm_832258244c.enrollments
  ADD COLUMN sending_key text,
  ADD COLUMN mail_thread_id text,
  ADD COLUMN mail_last_message_id text;

CREATE INDEX enrollments_sending ON plugin_crm_832258244c.enrollments (sending_key) WHERE sending_key IS NOT NULL;

-- Kit decisionsMigration
CREATE TABLE plugin_crm_832258244c.decisions (
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
CREATE INDEX decisions_subject ON plugin_crm_832258244c.decisions (company_id, subject_kind, subject_id);
CREATE INDEX decisions_purpose ON plugin_crm_832258244c.decisions (company_id, purpose, created_at);

-- Kit inboxMigration
CREATE TABLE plugin_crm_832258244c.inbox (
  key text PRIMARY KEY,
  company_id text NOT NULL,
  event text NOT NULL,
  result jsonb,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- Kit outboxMigration
CREATE TABLE plugin_crm_832258244c.outbox (
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
CREATE INDEX outbox_due ON plugin_crm_832258244c.outbox (status, next_attempt_at);
