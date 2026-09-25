CREATE TABLE plugin_mailbox_319145c88b.accounts (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  provider text NOT NULL,
  address text NOT NULL,
  secret_ref text,
  owner_user_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plugin_mailbox_319145c88b.messages (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  account_id text NOT NULL REFERENCES plugin_mailbox_319145c88b.accounts (id),
  subject text NOT NULL,
  body text NOT NULL DEFAULT '',
  direction text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messages_direction CHECK (direction IN ('inbound', 'outbound')),
  CONSTRAINT messages_status CHECK (status IN ('synced', 'draft', 'queued', 'sent'))
);

CREATE TABLE plugin_mailbox_319145c88b.delegations (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  account_id text NOT NULL REFERENCES plugin_mailbox_319145c88b.accounts (id),
  agent_id text NOT NULL,
  can_read boolean NOT NULL DEFAULT true,
  can_draft boolean NOT NULL DEFAULT true,
  can_send boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX delegations_account_agent ON plugin_mailbox_319145c88b.delegations (account_id, agent_id);
