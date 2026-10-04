-- CRM 0.14.0: e-sign acceptance, source-to-revenue attribution and minimal site events.
-- Audit findings Q1b-11, Q10-14 (documents a client signs), Q10-8, Q1a-14 (attribution and on-site events), Q10-3 (numbers for goals).

-- ---------------------------------------------------------------------------
-- Signable documents. The text that was sent is frozen: content never changes once the document leaves draft.
-- A signature is a typed name with explicit consent (a basic electronic signature). Nothing here claims more.
-- ---------------------------------------------------------------------------
CREATE TABLE plugin_crm_832258244c.sign_documents (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  client_kind text NOT NULL,
  client_ref text NOT NULL,
  deal_id text,
  quote_id text,
  quote_number text,
  kind text NOT NULL,
  title text NOT NULL,
  template_key text,
  template_version text,
  template_reviewed boolean NOT NULL DEFAULT false,
  content text NOT NULL,
  content_sha256 text NOT NULL,
  consent_text text NOT NULL,
  consent_sha256 text NOT NULL,
  value_minor bigint,
  currency text,
  brand jsonb NOT NULL DEFAULT '{}'::jsonb,
  page_id text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  recipient_contact_id text,
  recipient_name text,
  recipient_email text,
  valid_days integer NOT NULL DEFAULT 14,
  expires_at timestamptz,
  issue_id text,
  sent_at timestamptz,
  viewed_at timestamptz,
  last_viewed_at timestamptz,
  view_count integer NOT NULL DEFAULT 0,
  reminders integer NOT NULL DEFAULT 0,
  last_reminder_at timestamptz,
  next_reminder_at timestamptz,
  escalated_at timestamptz,
  signed_at timestamptz,
  signer_name text,
  signer_ip_hash text,
  signer_user_agent text,
  name_matches boolean,
  declined_at timestamptz,
  decline_reason text,
  expired_at timestamptz,
  voided_at timestamptz,
  void_reason text,
  signed_copy_md text,
  signed_copy_html text,
  signed_copy_sha256 text,
  audit_head text,
  effects_done_at timestamptz,
  canary_token text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sign_documents_client CHECK (client_kind IN ('company', 'contact')),
  CONSTRAINT sign_documents_kind CHECK (kind IN ('proposal', 'quote', 'contract')),
  CONSTRAINT sign_documents_status CHECK (status IN ('draft', 'awaiting_approval', 'sent', 'viewed', 'signed', 'declined', 'expired', 'void'))
);

CREATE UNIQUE INDEX sign_documents_page ON plugin_crm_832258244c.sign_documents (page_id);

CREATE INDEX sign_documents_client ON plugin_crm_832258244c.sign_documents (company_id, client_kind, client_ref, created_at);

CREATE INDEX sign_documents_status ON plugin_crm_832258244c.sign_documents (company_id, status);

CREATE INDEX sign_documents_issue ON plugin_crm_832258244c.sign_documents (issue_id) WHERE issue_id IS NOT NULL;

-- One row per link that was made. Only the SHA-256 of the token is stored, so reading the table never gives a link.
CREATE TABLE plugin_crm_832258244c.sign_tokens (
  token_hash text PRIMARY KEY,
  company_id text NOT NULL,
  doc_id text NOT NULL,
  approval_id text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sign_tokens_doc ON plugin_crm_832258244c.sign_tokens (doc_id);

CREATE INDEX sign_tokens_approval ON plugin_crm_832258244c.sign_tokens (approval_id) WHERE approval_id IS NOT NULL;

-- The audit trail: append only, one chain per document. Each row carries the hash of the row before it, so a changed or
-- removed row breaks every hash after it. The time is kept as text so the hash is over exactly what was written.
CREATE TABLE plugin_crm_832258244c.sign_events (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  doc_id text NOT NULL,
  seq integer NOT NULL,
  kind text NOT NULL,
  actor text NOT NULL,
  ip_hash text,
  user_agent text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash text NOT NULL,
  hash text NOT NULL,
  at text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX sign_events_seq ON plugin_crm_832258244c.sign_events (doc_id, seq);

CREATE INDEX sign_events_company ON plugin_crm_832258244c.sign_events (company_id, doc_id);

-- E-sign is off for every client except the canary until a person turns it on for that client.
CREATE TABLE plugin_crm_832258244c.esign_clients (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  client_kind text NOT NULL,
  client_ref text NOT NULL,
  enabled_by text NOT NULL,
  enabled_at timestamptz NOT NULL DEFAULT now(),
  templates_reviewed boolean NOT NULL DEFAULT false,
  note text,
  CONSTRAINT esign_clients_kind CHECK (client_kind IN ('company', 'contact'))
);

CREATE UNIQUE INDEX esign_clients_client ON plugin_crm_832258244c.esign_clients (company_id, client_kind, client_ref);

-- Every request a public endpoint (signing page, site events) answered, for rate limits. Rows older than two days are removed by the hourly job.
CREATE TABLE plugin_crm_832258244c.public_hits (
  id text PRIMARY KEY,
  scope text NOT NULL,
  subject text NOT NULL,
  ip_hash text,
  outcome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX public_hits_subject ON plugin_crm_832258244c.public_hits (scope, subject, created_at);

CREATE INDEX public_hits_ip ON plugin_crm_832258244c.public_hits (scope, ip_hash, created_at);

CREATE INDEX public_hits_age ON plugin_crm_832258244c.public_hits (created_at);

-- The signing emails go through the same approval as every other email to a client.
ALTER TABLE plugin_crm_832258244c.care_approvals DROP CONSTRAINT care_approvals_kind;

ALTER TABLE plugin_crm_832258244c.care_approvals ADD CONSTRAINT care_approvals_kind CHECK (kind IN ('client_action', 'client_reminder', 'client_report', 'feedback_request', 'erasure', 'esign_request', 'esign_reminder', 'esign_copy'));

-- ---------------------------------------------------------------------------
-- Site events: a write key per site, and a compact daily rollup. No raw event is stored.
-- ---------------------------------------------------------------------------
CREATE TABLE plugin_crm_832258244c.event_keys (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  client_kind text,
  client_ref text,
  label text NOT NULL,
  site_id text,
  site_url text,
  hosts jsonb NOT NULL DEFAULT '[]'::jsonb,
  write_key text NOT NULL,
  previous_key text,
  previous_key_until timestamptz,
  status text NOT NULL DEFAULT 'active',
  canary boolean NOT NULL DEFAULT false,
  consent_mode text NOT NULL DEFAULT 'anonymous',
  rate_limit_per_hour integer NOT NULL DEFAULT 3000,
  accepted_count bigint NOT NULL DEFAULT 0,
  rejected_count bigint NOT NULL DEFAULT 0,
  last_event_at timestamptz,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_keys_scope CHECK ((client_kind IS NULL AND client_ref IS NULL) OR (client_kind IN ('company', 'contact') AND client_ref IS NOT NULL)),
  CONSTRAINT event_keys_status CHECK (status IN ('active', 'paused', 'revoked')),
  CONSTRAINT event_keys_consent CHECK (consent_mode IN ('anonymous', 'required'))
);

CREATE UNIQUE INDEX event_keys_write_key ON plugin_crm_832258244c.event_keys (write_key);

CREATE INDEX event_keys_previous_key ON plugin_crm_832258244c.event_keys (previous_key) WHERE previous_key IS NOT NULL;

CREATE INDEX event_keys_company ON plugin_crm_832258244c.event_keys (company_id, status);

-- One row per site, day, kind, name and channel. kind is entrance (a visit started), pageview (name is the first path segment),
-- outbound (name is the host clicked) or conversion (name is the event). first_channel is filled only when the visitor allowed remembering earlier visits.
CREATE TABLE plugin_crm_832258244c.site_event_daily (
  company_id text NOT NULL,
  key_id text NOT NULL,
  day text NOT NULL,
  kind text NOT NULL,
  name text NOT NULL DEFAULT '',
  channel text NOT NULL DEFAULT '',
  first_channel text NOT NULL DEFAULT '',
  n integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, key_id, day, kind, name, channel, first_channel),
  CONSTRAINT site_event_daily_kind CHECK (kind IN ('entrance', 'pageview', 'outbound', 'conversion'))
);

CREATE INDEX site_event_daily_range ON plugin_crm_832258244c.site_event_daily (company_id, key_id, day);

-- ---------------------------------------------------------------------------
-- Attribution: what was paid (from Billing invoice.paid), what a channel cost, and what a client reported about its own leads.
-- ---------------------------------------------------------------------------
CREATE TABLE plugin_crm_832258244c.revenue_events (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  key text NOT NULL,
  invoice_id text,
  number text,
  deal_id text,
  client_kind text,
  client_ref text,
  total_minor bigint NOT NULL,
  currency text NOT NULL,
  paid_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX revenue_events_key ON plugin_crm_832258244c.revenue_events (company_id, key);

CREATE INDEX revenue_events_paid ON plugin_crm_832258244c.revenue_events (company_id, paid_at);

-- A cost a person or agent recorded for a channel and month. scope is own, company:id or contact:id.
CREATE TABLE plugin_crm_832258244c.channel_costs (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  scope text NOT NULL,
  channel text NOT NULL,
  period text NOT NULL,
  amount_minor bigint NOT NULL,
  currency text NOT NULL,
  note text,
  recorded_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_costs_amount CHECK (amount_minor >= 0)
);

CREATE UNIQUE INDEX channel_costs_row ON plugin_crm_832258244c.channel_costs (company_id, scope, channel, period);

-- What became of a lead on a client form: the client tells us, so the client report can show which channel brought work.
ALTER TABLE plugin_crm_832258244c.client_leads
  ADD COLUMN outcome text NOT NULL DEFAULT 'new',
  ADD COLUMN value_minor bigint,
  ADD COLUMN value_currency text,
  ADD COLUMN outcome_at timestamptz;

ALTER TABLE plugin_crm_832258244c.client_leads ADD CONSTRAINT client_leads_outcome CHECK (outcome IN ('new', 'contacted', 'qualified', 'won', 'lost'));
