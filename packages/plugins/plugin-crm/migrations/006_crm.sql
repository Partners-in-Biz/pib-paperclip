-- CRM 0.4.0: client profiles, leads from client channels, held leads,
-- hand-off events other modules rely on, and when a deal was won.

-- How to talk for a client: filled in by the Account Manager during onboarding, editable on the client page.
CREATE TABLE plugin_crm_832258244c.client_profiles (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  client_kind text NOT NULL,
  client_ref text NOT NULL,
  brand_voice text,
  audience text,
  services jsonb NOT NULL DEFAULT '[]'::jsonb,
  website text,
  booking_link text,
  banned_words jsonb NOT NULL DEFAULT '[]'::jsonb,
  tone_notes text,
  human_owned jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_profiles_kind CHECK (client_kind IN ('company', 'contact'))
);

CREATE UNIQUE INDEX client_profiles_client ON plugin_crm_832258244c.client_profiles (company_id, client_kind, client_ref);

-- Leads that came in on a client channel (their social account or mailbox). They belong to the client, never to our contacts.
CREATE TABLE plugin_crm_832258244c.client_leads (
  id text PRIMARY KEY,
  key text NOT NULL,
  company_id text NOT NULL,
  client_kind text NOT NULL,
  client_ref text NOT NULL,
  source text NOT NULL,
  platform text,
  name text,
  handle text,
  email text,
  message text NOT NULL DEFAULT '',
  url text,
  item_id text,
  confidence numeric,
  captured_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_leads_kind CHECK (client_kind IN ('company', 'contact'))
);

CREATE UNIQUE INDEX client_leads_key ON plugin_crm_832258244c.client_leads (company_id, key);

CREATE INDEX client_leads_client ON plugin_crm_832258244c.client_leads (company_id, client_kind, client_ref, captured_at);

-- Our own leads that arrived while the CRM was off or its settings were unsaved. A job adds them once the CRM is ready.
CREATE TABLE plugin_crm_832258244c.held_leads (
  id text PRIMARY KEY,
  key text NOT NULL,
  company_id text NOT NULL,
  event text NOT NULL,
  payload jsonb NOT NULL,
  reason text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  held_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE UNIQUE INDEX held_leads_key ON plugin_crm_832258244c.held_leads (company_id, key);

CREATE INDEX held_leads_pending ON plugin_crm_832258244c.held_leads (company_id, held_at) WHERE processed_at IS NULL;

-- Hand-off events without a result event (deal.won, contact.suppressed, company.deleted), re-sent for a day because delivery is at most once.
CREATE TABLE plugin_crm_832258244c.handoffs (
  id text PRIMARY KEY,
  key text NOT NULL,
  company_id text NOT NULL,
  event text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX handoffs_key ON plugin_crm_832258244c.handoffs (company_id, key);

CREATE INDEX handoffs_recent ON plugin_crm_832258244c.handoffs (company_id, created_at);

-- When a deal last moved to a won stage.
ALTER TABLE plugin_crm_832258244c.deals
  ADD COLUMN won_at timestamptz;
