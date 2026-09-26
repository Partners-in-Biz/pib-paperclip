-- Gmail connection, sync cursor, triage and the send queue for every PiB plugin.

ALTER TABLE plugin_mailbox_319145c88b.accounts
  ADD COLUMN status text NOT NULL DEFAULT 'manual',
  ADD COLUMN token_sealed text,
  ADD COLUMN token_expires_at timestamptz,
  ADD COLUMN scopes text,
  ADD COLUMN key_version integer,
  ADD COLUMN history_id text,
  ADD COLUMN last_sync_at timestamptz,
  ADD COLUMN last_error text,
  ADD COLUMN sync_stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN sync_lock_until timestamptz,
  ADD COLUMN connected_by_user_id text,
  ADD COLUMN connected_at timestamptz,
  ADD COLUMN alert_issue_id text,
  ADD COLUMN is_default boolean NOT NULL DEFAULT false,
  ADD COLUMN label_ids jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT accounts_status CHECK (status IN ('manual', 'connected', 'needs_reconnect', 'disconnected'));

CREATE INDEX accounts_company_status ON plugin_mailbox_319145c88b.accounts (company_id, status);

ALTER TABLE plugin_mailbox_319145c88b.messages
  ADD COLUMN gmail_message_id text,
  ADD COLUMN gmail_thread_id text,
  ADD COLUMN rfc_message_id text,
  ADD COLUMN in_reply_to text,
  ADD COLUMN refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN from_addr jsonb,
  ADD COLUMN to_addrs jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN cc_addrs jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN bcc_addrs jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN snippet text,
  ADD COLUMN labels jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN bulk boolean NOT NULL DEFAULT false,
  ADD COLUMN received_at timestamptz,
  ADD COLUMN triage jsonb,
  ADD COLUMN triaged_at timestamptz,
  ADD COLUMN category text,
  ADD COLUMN urgency numeric,
  ADD COLUMN needs_reply numeric,
  ADD COLUMN phishing numeric,
  ADD COLUMN client_kind text,
  ADD COLUMN client_ref text,
  ADD COLUMN reply_to jsonb,
  ADD COLUMN sent_context jsonb,
  ADD COLUMN send_key text,
  ADD COLUMN draft jsonb,
  ADD COLUMN send_error text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX messages_account_gmail ON plugin_mailbox_319145c88b.messages (account_id, gmail_message_id);
CREATE INDEX messages_company_thread ON plugin_mailbox_319145c88b.messages (company_id, gmail_thread_id);
CREATE INDEX messages_company_rfc ON plugin_mailbox_319145c88b.messages (company_id, rfc_message_id);
CREATE INDEX messages_company_received ON plugin_mailbox_319145c88b.messages (company_id, received_at DESC);
CREATE INDEX messages_account_created ON plugin_mailbox_319145c88b.messages (account_id, created_at);

CREATE TABLE plugin_mailbox_319145c88b.send_requests (
  key text PRIMARY KEY,
  company_id text NOT NULL,
  source_plugin text NOT NULL,
  account_id text,
  from_address text,
  to_addrs jsonb NOT NULL DEFAULT '[]'::jsonb,
  subject text NOT NULL DEFAULT '',
  status text NOT NULL,
  permanent boolean NOT NULL DEFAULT false,
  attempts integer NOT NULL DEFAULT 0,
  gmail_message_id text,
  gmail_thread_id text,
  rfc_message_id text,
  error text,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  request jsonb NOT NULL,
  claimed_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT send_requests_status CHECK (status IN ('sending', 'sent', 'failed', 'retrying'))
);

CREATE INDEX send_requests_company_created ON plugin_mailbox_319145c88b.send_requests (company_id, created_at DESC);
CREATE INDEX send_requests_thread ON plugin_mailbox_319145c88b.send_requests (company_id, gmail_thread_id);
CREATE INDEX send_requests_rfc ON plugin_mailbox_319145c88b.send_requests (company_id, rfc_message_id);
CREATE INDEX send_requests_account_claimed ON plugin_mailbox_319145c88b.send_requests (account_id, claimed_at);

CREATE TABLE plugin_mailbox_319145c88b.oauth_sessions (
  state text PRIMARY KEY,
  company_id text NOT NULL,
  created_by_user_id text,
  return_to text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX oauth_sessions_expiry ON plugin_mailbox_319145c88b.oauth_sessions (expires_at);

CREATE TABLE plugin_mailbox_319145c88b.thread_issues (
  account_id text NOT NULL,
  gmail_thread_id text NOT NULL,
  company_id text NOT NULL,
  issue_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, gmail_thread_id)
);
