-- Mailbox 0.6.0: an email provider (Resend) beside Gmail. A send-only account kind, the sending domains registered at the provider
-- with the DNS records somebody adds, a count of what each domain sends and what came back (warm-up cap and bounce and complaint
-- rates), the webhook deliveries already seen, and the addresses that soft bounced. Never edit this file once it may have run:
-- add the next number.

-- A send-only account waits as pending until its domain is verified at the provider. It has a default Reply-To, because nobody
-- reads the inbox of a send-only address.
ALTER TABLE plugin_mailbox_319145c88b.accounts DROP CONSTRAINT accounts_status;

ALTER TABLE plugin_mailbox_319145c88b.accounts
  ADD CONSTRAINT accounts_status CHECK (status IN ('manual', 'connected', 'needs_reconnect', 'disconnected', 'pending')),
  ADD COLUMN reply_to text;

-- A send-only address is one account per company: two add-sending-domain calls for the same domain running at the same moment cannot
-- both create it. (Addresses are stored in lower case.) Gmail accounts are not covered by the rule.
CREATE UNIQUE INDEX accounts_resend_address ON plugin_mailbox_319145c88b.accounts (company_id, address) WHERE provider = 'resend';

-- What the provider answered for a send and what happened to the message afterwards. A row from Gmail leaves provider empty.
ALTER TABLE plugin_mailbox_319145c88b.send_requests
  ADD COLUMN provider text,
  ADD COLUMN provider_message_id text,
  ADD COLUMN delivery_status text,
  ADD COLUMN delivery jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX send_requests_provider_message ON plugin_mailbox_319145c88b.send_requests (company_id, provider_message_id);

-- A sending domain registered at the provider. first_sent_at is day one of the warm-up.
CREATE TABLE plugin_mailbox_319145c88b.esp_domains (
  company_id text NOT NULL,
  domain text NOT NULL,
  provider text NOT NULL DEFAULT 'resend',
  provider_domain_id text NOT NULL,
  region text,
  status text NOT NULL DEFAULT 'not_started',
  records jsonb NOT NULL DEFAULT '[]'::jsonb,
  return_path_host text,
  dkim_selector text,
  spf_include text,
  client_kind text,
  client_ref text,
  account_id text,
  created_by text,
  verified_at timestamptz,
  checked_at timestamptz,
  verify_asked_at timestamptz,
  first_sent_at timestamptz,
  last_sent_at timestamptz,
  warmup_exempt boolean NOT NULL DEFAULT false,
  daily_cap_override integer,
  reputation jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, domain),
  CONSTRAINT esp_domains_status CHECK (status IN ('not_started', 'pending', 'verified', 'failed', 'temporary_failure', 'unknown')),
  CONSTRAINT esp_domains_client_kind CHECK (client_kind IS NULL OR client_kind IN ('company', 'contact')),
  CONSTRAINT esp_domains_cap CHECK (daily_cap_override IS NULL OR daily_cap_override > 0)
);

CREATE UNIQUE INDEX esp_domains_provider_id ON plugin_mailbox_319145c88b.esp_domains (company_id, provider_domain_id);

-- One UTC day of a domain: recipients handed to the provider and what came back. day is text, year-month-day in UTC.
CREATE TABLE plugin_mailbox_319145c88b.esp_domain_days (
  company_id text NOT NULL,
  domain text NOT NULL,
  day text NOT NULL,
  sent integer NOT NULL DEFAULT 0,
  delivered integer NOT NULL DEFAULT 0,
  hard_bounces integer NOT NULL DEFAULT 0,
  soft_bounces integer NOT NULL DEFAULT 0,
  complaints integer NOT NULL DEFAULT 0,
  opened integer NOT NULL DEFAULT 0,
  clicked integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, domain, day)
);

-- Webhook deliveries already applied. event_id is the delivery id, so a replay is recognised; dedupe_key makes a message and an
-- event kind count once even when the provider sends it twice under two delivery ids. recipient is empty when the message had
-- several recipients.
CREATE TABLE plugin_mailbox_319145c88b.esp_events (
  company_id text NOT NULL,
  event_id text NOT NULL,
  dedupe_key text NOT NULL,
  provider text NOT NULL,
  event_type text NOT NULL,
  email_id text,
  recipient text NOT NULL DEFAULT '',
  domain text,
  send_key text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, event_id)
);

CREATE UNIQUE INDEX esp_events_dedupe ON plugin_mailbox_319145c88b.esp_events (company_id, dedupe_key);

CREATE INDEX esp_events_received ON plugin_mailbox_319145c88b.esp_events (received_at);

CREATE INDEX esp_events_recipient ON plugin_mailbox_319145c88b.esp_events (company_id, recipient);

-- Addresses whose mail soft bounced lately: marketing to them waits until backoff_until.
CREATE TABLE plugin_mailbox_319145c88b.esp_recipient_health (
  company_id text NOT NULL,
  email text NOT NULL,
  soft_bounces integer NOT NULL DEFAULT 0,
  first_soft_at timestamptz NOT NULL DEFAULT now(),
  last_soft_at timestamptz NOT NULL DEFAULT now(),
  backoff_until timestamptz,
  PRIMARY KEY (company_id, email)
);
