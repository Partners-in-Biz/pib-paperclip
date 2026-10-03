-- CRM 0.12.0: the client brand kit and proposal fields on the client profile, the services
-- vocabulary (what does not map to a service is kept as text), and the onboarding step each service opens.

ALTER TABLE plugin_crm_832258244c.client_profiles
  ADD COLUMN logo_key text,
  ADD COLUMN primary_color text,
  ADD COLUMN secondary_color text,
  ADD COLUMN accent_color text,
  ADD COLUMN fonts jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN tone_examples jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN scope_template_ref text,
  ADD COLUMN terms_ref text,
  ADD COLUMN services_other jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN services_normalized_at timestamptz;

-- One onboarding step per client and service. open: the step is out; started: its closer logged the proof;
-- covered: the first-win onboarding already handles it; dropped: the step was cancelled or the service removed.
CREATE TABLE plugin_crm_832258244c.service_onboarding (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  client_kind text NOT NULL,
  client_ref text NOT NULL,
  service text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  issue_id text,
  note text,
  opened_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_onboarding_kind CHECK (client_kind IN ('company', 'contact')),
  CONSTRAINT service_onboarding_status CHECK (status IN ('open', 'started', 'covered', 'dropped'))
);

CREATE UNIQUE INDEX service_onboarding_client ON plugin_crm_832258244c.service_onboarding (company_id, client_kind, client_ref, service);

CREATE INDEX service_onboarding_status ON plugin_crm_832258244c.service_onboarding (company_id, status);
