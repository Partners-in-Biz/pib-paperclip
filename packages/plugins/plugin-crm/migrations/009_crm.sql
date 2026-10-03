-- CRM 0.12.0: public lead capture. A lead source is one form on one site, with its own key.
-- A source belongs to our own company (client columns empty) or to a client (company or contact).
-- A lead that arrives through a client source is that clients lead, never ours.

CREATE TABLE plugin_crm_832258244c.lead_sources (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  client_kind text,
  client_ref text,
  label text NOT NULL,
  site_id text,
  site_url text,
  public_key text NOT NULL,
  previous_key text,
  previous_key_until timestamptz,
  signing_secret text,
  status text NOT NULL DEFAULT 'active',
  canary boolean NOT NULL DEFAULT false,
  consent_text text,
  privacy_url text,
  success_message text,
  turnstile_site_key text,
  rate_limit_per_hour integer NOT NULL DEFAULT 120,
  accepted_count integer NOT NULL DEFAULT 0,
  rejected_count integer NOT NULL DEFAULT 0,
  last_submission_at timestamptz,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_sources_scope CHECK ((client_kind IS NULL AND client_ref IS NULL) OR (client_kind IN ('company', 'contact') AND client_ref IS NOT NULL)),
  CONSTRAINT lead_sources_status CHECK (status IN ('active', 'paused', 'revoked'))
);

CREATE UNIQUE INDEX lead_sources_public_key ON plugin_crm_832258244c.lead_sources (public_key);

CREATE INDEX lead_sources_previous_key ON plugin_crm_832258244c.lead_sources (previous_key) WHERE previous_key IS NOT NULL;

CREATE INDEX lead_sources_company ON plugin_crm_832258244c.lead_sources (company_id, status);

-- Every request the public endpoint answered, for rate limits. Rows older than two days are removed by the hourly job.
CREATE TABLE plugin_crm_832258244c.lead_hits (
  id text PRIMARY KEY,
  source_id text NOT NULL,
  ip_hash text,
  outcome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX lead_hits_source ON plugin_crm_832258244c.lead_hits (source_id, created_at);

CREATE INDEX lead_hits_ip ON plugin_crm_832258244c.lead_hits (source_id, ip_hash, created_at);

-- One row per accepted submission: where it came from and what the person agreed to. No name, email or message here.
CREATE TABLE plugin_crm_832258244c.lead_captures (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  source_id text NOT NULL,
  key text NOT NULL,
  outcome text NOT NULL DEFAULT 'stored',
  contact_id text,
  client_kind text,
  client_ref text,
  attribution jsonb NOT NULL DEFAULT '{}'::jsonb,
  consent boolean NOT NULL DEFAULT false,
  ip_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX lead_captures_key ON plugin_crm_832258244c.lead_captures (company_id, key);

CREATE INDEX lead_captures_source ON plugin_crm_832258244c.lead_captures (company_id, source_id, created_at);

-- Leads of a client carry the phone, where they came from and the Paperclip issue opened for them.
ALTER TABLE plugin_crm_832258244c.client_leads
  ADD COLUMN phone text,
  ADD COLUMN meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN issue_id text;

-- Consent a person gave on a form, per sender (our own list or one clients list), per purpose. Newest wins.
CREATE TABLE plugin_crm_832258244c.consent_records (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  sender_key text NOT NULL,
  subject_key text NOT NULL,
  email text,
  contact_id text,
  purpose text NOT NULL,
  basis text NOT NULL,
  granted boolean NOT NULL,
  source text NOT NULL,
  wording text,
  form_id text,
  url text,
  policy_version text,
  ip_hash text,
  recorded_at timestamptz NOT NULL,
  expires_at timestamptz,
  recorded_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX consent_records_subject ON plugin_crm_832258244c.consent_records (company_id, sender_key, subject_key, purpose);

CREATE INDEX consent_records_contact ON plugin_crm_832258244c.consent_records (company_id, contact_id);
