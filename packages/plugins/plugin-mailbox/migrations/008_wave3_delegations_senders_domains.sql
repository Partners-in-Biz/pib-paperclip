-- Mailbox 0.5.0: delegations that stay removed once a person removes them, a mailbox that belongs to one client,
-- do-not-email rows per sender (and erased markers that keep no address), client mail mappings, sender domain
-- checks, and the Reply-To of inbound mail. Never edit this file once it may have run: add the next number.

-- Where a delegation came from (manual, a default for a role, an answered ask) and who it was granted by.
ALTER TABLE plugin_mailbox_319145c88b.delegations
  ADD COLUMN source text NOT NULL DEFAULT 'manual',
  ADD COLUMN granted_by text;

-- A delegation a person removed. The automatic defaults never create it again; only an explicit grant does.
CREATE TABLE plugin_mailbox_319145c88b.delegation_removals (
  account_id text NOT NULL,
  agent_id text NOT NULL,
  company_id text NOT NULL,
  removed_at timestamptz NOT NULL DEFAULT now(),
  removed_by text,
  PRIMARY KEY (account_id, agent_id)
);

-- A mailbox can belong to one client: then it sends only that client mail, its opt-outs are that client list,
-- and it is never the default sender.
ALTER TABLE plugin_mailbox_319145c88b.accounts
  ADD COLUMN client_kind text,
  ADD COLUMN client_ref text,
  ADD COLUMN from_name text,
  ADD CONSTRAINT accounts_client_kind CHECK (client_kind IS NULL OR client_kind IN ('company', 'contact'));

-- Do-not-email rows per sender. An empty sender_key is a row from before this change: it blocks every sender.
ALTER TABLE plugin_mailbox_319145c88b.suppressions
  ADD COLUMN sender_key text NOT NULL DEFAULT '',
  ADD COLUMN email_hash text,
  ADD COLUMN erased_at timestamptz;

ALTER TABLE plugin_mailbox_319145c88b.suppressions DROP CONSTRAINT suppressions_pkey;

ALTER TABLE plugin_mailbox_319145c88b.suppressions ADD PRIMARY KEY (company_id, email, sender_key);

CREATE INDEX suppressions_hash ON plugin_mailbox_319145c88b.suppressions (company_id, email_hash);

-- The Reply-To header of inbound mail (a form relay puts the visitor there) and whether a client mapping filed it.
ALTER TABLE plugin_mailbox_319145c88b.messages
  ADD COLUMN reply_to_addr jsonb,
  ADD COLUMN map_state text,
  ADD COLUMN map_id text;

CREATE INDEX messages_company_map ON plugin_mailbox_319145c88b.messages (company_id, map_state);

-- Which client forwarded or relayed mail belongs to: by sender or recipient, an address or a whole domain.
CREATE TABLE plugin_mailbox_319145c88b.client_mail_maps (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  match_type text NOT NULL,
  pattern text NOT NULL,
  client_kind text NOT NULL,
  client_ref text NOT NULL,
  client_name text,
  note text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_mail_maps_type CHECK (match_type IN ('sender_domain', 'sender_address', 'recipient_domain', 'recipient_address')),
  CONSTRAINT client_mail_maps_kind CHECK (client_kind IN ('company', 'contact'))
);

CREATE UNIQUE INDEX client_mail_maps_rule ON plugin_mailbox_319145c88b.client_mail_maps (company_id, match_type, pattern);

-- The last SPF, DKIM, DMARC and MX check of each sending domain, and when it first looked the way it does now.
CREATE TABLE plugin_mailbox_319145c88b.domain_checks (
  company_id text NOT NULL,
  domain text NOT NULL,
  status text NOT NULL,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL DEFAULT 'account',
  client_kind text,
  client_ref text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  first_checked_at timestamptz NOT NULL DEFAULT now(),
  status_since timestamptz NOT NULL DEFAULT now(),
  dmarc_none_since timestamptz,
  PRIMARY KEY (company_id, domain),
  CONSTRAINT domain_checks_status CHECK (status IN ('healthy', 'warn', 'bad', 'unknown')),
  CONSTRAINT domain_checks_source CHECK (source IN ('account', 'manual'))
);
