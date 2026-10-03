-- CRM 0.13.0: client care. The monthly client report, support cases, client actions (what a client must
-- sign off or grant), the client health score, site monitoring, privacy (the approvals erasure and client
-- emails wait for, the data-processing register, client sensitivity).

-- What the other modules say about one client (SEO, Social, Campaigns, Billing, Mailbox), for the report and
-- the health score. One row per client, module and period (empty for the current state, YYYY-MM for a month).
CREATE TABLE plugin_crm_832258244c.client_signals (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  client_kind text NOT NULL,
  client_ref text NOT NULL,
  module text NOT NULL,
  period text NOT NULL DEFAULT '',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL DEFAULT 'event',
  recorded_by text,
  signal_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_signals_kind CHECK (client_kind IN ('company', 'contact')),
  CONSTRAINT client_signals_source CHECK (source IN ('event', 'agent'))
);

CREATE UNIQUE INDEX client_signals_key ON plugin_crm_832258244c.client_signals (company_id, client_kind, client_ref, module, period);

-- One monthly report per client and month: the data gathered, the document and where it got to.
CREATE TABLE plugin_crm_832258244c.client_reports (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  client_kind text NOT NULL,
  client_ref text NOT NULL,
  period text NOT NULL,
  status text NOT NULL DEFAULT 'built',
  narrative jsonb NOT NULL DEFAULT '{}'::jsonb,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  markdown text NOT NULL DEFAULT '',
  html text NOT NULL DEFAULT '',
  issue_id text,
  approval_id text,
  built_by text,
  built_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_reports_kind CHECK (client_kind IN ('company', 'contact')),
  CONSTRAINT client_reports_status CHECK (status IN ('built', 'awaiting_approval', 'sent', 'dry_run', 'skipped'))
);

CREATE UNIQUE INDEX client_reports_client ON plugin_crm_832258244c.client_reports (company_id, client_kind, client_ref, period);

-- Everything that waits for a person before it happens: an email to a client, an erasure. One per subject and attempt.
CREATE TABLE plugin_crm_832258244c.care_approvals (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  kind text NOT NULL,
  client_kind text,
  client_ref text,
  subject_id text NOT NULL,
  seq integer NOT NULL DEFAULT 1,
  issue_id text,
  status text NOT NULL DEFAULT 'open',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  send_key text,
  decided_by text,
  decided_at timestamptz,
  result jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT care_approvals_kind CHECK (kind IN ('client_action', 'client_reminder', 'client_report', 'feedback_request', 'erasure')),
  CONSTRAINT care_approvals_status CHECK (status IN ('open', 'approved', 'refused', 'sent', 'failed', 'dry_run', 'erased'))
);

CREATE UNIQUE INDEX care_approvals_subject ON plugin_crm_832258244c.care_approvals (company_id, kind, subject_id, seq);

CREATE INDEX care_approvals_issue ON plugin_crm_832258244c.care_approvals (issue_id) WHERE issue_id IS NOT NULL;

CREATE INDEX care_approvals_send ON plugin_crm_832258244c.care_approvals (send_key) WHERE send_key IS NOT NULL;

-- What a client must do (sign off, grant, approve) with the exact link, and the waiting-on-client state.
CREATE TABLE plugin_crm_832258244c.client_actions (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  client_kind text NOT NULL,
  client_ref text NOT NULL,
  kind text NOT NULL,
  title text NOT NULL,
  instructions text,
  link_url text,
  link_label text,
  contact_id text,
  to_email text,
  to_name text,
  status text NOT NULL DEFAULT 'draft',
  source_ref text,
  due_at timestamptz,
  remind_after_days integer NOT NULL DEFAULT 3,
  reminders integer NOT NULL DEFAULT 0,
  requested_at timestamptz,
  next_reminder_at timestamptz,
  last_reminder_at timestamptz,
  reply_at timestamptz,
  answered_at timestamptz,
  answer text,
  escalated_at timestamptz,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_actions_kind CHECK (client_kind IN ('company', 'contact')),
  CONSTRAINT client_actions_what CHECK (kind IN ('sign_off', 'grant', 'approval', 'info')),
  CONSTRAINT client_actions_status CHECK (status IN ('draft', 'waiting', 'replied', 'done', 'cancelled'))
);

CREATE INDEX client_actions_client ON plugin_crm_832258244c.client_actions (company_id, client_kind, client_ref, status);

CREATE INDEX client_actions_open ON plugin_crm_832258244c.client_actions (company_id, status);

-- Support cases: a request from a client with a severity and the two SLA targets. Mail cases wrap the Reply-needed issue of the Mailbox.
CREATE TABLE plugin_crm_832258244c.support_cases (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  client_kind text NOT NULL,
  client_ref text NOT NULL,
  title text NOT NULL,
  summary text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'manual',
  severity text NOT NULL DEFAULT 'normal',
  status text NOT NULL DEFAULT 'new',
  contact_id text,
  thread_id text,
  source_key text,
  reply_issue_id text,
  issue_id text,
  first_response_due_at timestamptz NOT NULL,
  resolution_due_at timestamptz NOT NULL,
  first_response_at timestamptz,
  resolved_at timestamptz,
  first_breached_at timestamptz,
  resolution_breached_at timestamptz,
  escalated_at timestamptz,
  paused_at timestamptz,
  resolution text,
  opened_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT support_cases_kind CHECK (client_kind IN ('company', 'contact')),
  CONSTRAINT support_cases_source CHECK (source IN ('mail', 'lead', 'portal', 'manual', 'uptime')),
  CONSTRAINT support_cases_severity CHECK (severity IN ('low', 'normal', 'high', 'urgent')),
  CONSTRAINT support_cases_status CHECK (status IN ('new', 'open', 'waiting_client', 'resolved', 'closed'))
);

CREATE UNIQUE INDEX support_cases_source_key ON plugin_crm_832258244c.support_cases (company_id, source_key) WHERE source_key IS NOT NULL;

CREATE INDEX support_cases_client ON plugin_crm_832258244c.support_cases (company_id, client_kind, client_ref, status);

CREATE INDEX support_cases_open ON plugin_crm_832258244c.support_cases (company_id, status);

CREATE INDEX support_cases_thread ON plugin_crm_832258244c.support_cases (company_id, thread_id) WHERE thread_id IS NOT NULL;

-- NPS and CSAT asks and answers.
CREATE TABLE plugin_crm_832258244c.client_feedback (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  client_kind text NOT NULL,
  client_ref text NOT NULL,
  kind text NOT NULL,
  case_id text,
  contact_id text,
  to_email text,
  status text NOT NULL DEFAULT 'draft',
  score integer,
  comment text,
  requested_at timestamptz,
  answered_at timestamptz,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_feedback_client CHECK (client_kind IN ('company', 'contact')),
  CONSTRAINT client_feedback_kind CHECK (kind IN ('nps', 'csat')),
  CONSTRAINT client_feedback_status CHECK (status IN ('draft', 'requested', 'answered', 'declined'))
);

CREATE INDEX client_feedback_client ON plugin_crm_832258244c.client_feedback (company_id, client_kind, client_ref);

-- The health score per client, with what it is made of and when it dropped into the risk band.
CREATE TABLE plugin_crm_832258244c.client_health (
  company_id text NOT NULL,
  client_kind text NOT NULL,
  client_ref text NOT NULL,
  score integer NOT NULL,
  band text NOT NULL,
  components jsonb NOT NULL DEFAULT '[]'::jsonb,
  missing jsonb NOT NULL DEFAULT '[]'::jsonb,
  computed_at timestamptz NOT NULL DEFAULT now(),
  previous_score integer,
  previous_band text,
  at_risk_since timestamptz,
  alerted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, client_kind, client_ref),
  CONSTRAINT client_health_kind CHECK (client_kind IN ('company', 'contact')),
  CONSTRAINT client_health_band CHECK (band IN ('healthy', 'watch', 'at_risk'))
);

-- Uptime, certificate and domain checks of the websites of a client (the latest state of each).
CREATE TABLE plugin_crm_832258244c.site_monitor (
  site_id text PRIMARY KEY,
  company_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'unknown',
  http_status integer,
  response_ms integer,
  last_error text,
  last_checked_at timestamptz,
  last_ok_at timestamptz,
  down_since timestamptz,
  failures integer NOT NULL DEFAULT 0,
  tls_expires_at timestamptz,
  tls_error text,
  tls_checked_at timestamptz,
  domain text,
  domain_expires_at timestamptz,
  domain_checked_at timestamptz,
  domain_error text,
  domain_manual boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_monitor_status CHECK (status IN ('unknown', 'up', 'down'))
);

CREATE INDEX site_monitor_company ON plugin_crm_832258244c.site_monitor (company_id, status);

-- Checks per site and day, for the monthly uptime figure. Rows older than 120 days are removed by the monitor job.
CREATE TABLE plugin_crm_832258244c.site_uptime_days (
  id text PRIMARY KEY,
  site_id text NOT NULL,
  company_id text NOT NULL,
  day text NOT NULL,
  checks integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  slowest_ms integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX site_uptime_days_site ON plugin_crm_832258244c.site_uptime_days (company_id, site_id, day);

-- How sensitive the data of a client is. The Cockpit and Jev routing read it (and the client.sensitivity event) to keep a sensitive client off a processor that is not cleared for it.
CREATE TABLE plugin_crm_832258244c.client_sensitivity (
  company_id text NOT NULL,
  client_kind text NOT NULL,
  client_ref text NOT NULL,
  level text NOT NULL DEFAULT 'standard',
  reason text,
  set_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, client_kind, client_ref),
  CONSTRAINT client_sensitivity_kind CHECK (client_kind IN ('company', 'contact')),
  CONSTRAINT client_sensitivity_level CHECK (level IN ('standard', 'sensitive'))
);

-- The data-processing register: the systems that hold personal data, seeded from docs/data-processing-register.md.
-- Read-only: nothing in the plugin edits a row; a change to the docs file is shipped and re-seeded.
CREATE TABLE plugin_crm_832258244c.processing_register (
  company_id text NOT NULL,
  system_id text NOT NULL,
  name text NOT NULL,
  role text NOT NULL,
  purpose text NOT NULL,
  data_classes jsonb NOT NULL DEFAULT '[]'::jsonb,
  region text NOT NULL,
  retention text NOT NULL,
  agreement text NOT NULL,
  safeguards text NOT NULL,
  sensitive_clients text NOT NULL,
  owner_action text,
  doc_version text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, system_id)
);
