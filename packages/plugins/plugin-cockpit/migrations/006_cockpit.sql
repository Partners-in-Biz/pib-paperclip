-- 0.5.0: the credentials register (critic: no credential and expiry register).
-- Names and places only: never a value. A row says what a credential is, who
-- owns it, when it expires, how to rotate it and when it was last checked.
-- verify_with names one of the credential check secrets in the Cockpit settings
-- (github, cloudflare, resend); the daily job calls the provider once with it
-- and never stores or logs what it reads.
-- status: active | retired | burned (published or leaked: rotate, treat as exposed)
-- last_verify_status: ok | invalid | unreachable | unsupported | not_configured
CREATE TABLE plugin_cockpit_b8a99e8b16.credentials (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  seed_key text,
  name text NOT NULL,
  system text NOT NULL,
  lives_in text,
  owner text,
  expires_at timestamptz,
  expiry_note text,
  rotate_how text,
  rotate_href text,
  verify_with text,
  last_verified_at timestamptz,
  last_verify_status text,
  last_verify_detail text,
  status text NOT NULL DEFAULT 'active',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credentials_status CHECK (status IN ('active', 'retired', 'burned'))
);
CREATE INDEX credentials_company ON plugin_cockpit_b8a99e8b16.credentials (company_id, status, expires_at);
CREATE UNIQUE INDEX credentials_seed ON plugin_cockpit_b8a99e8b16.credentials (company_id, seed_key) WHERE seed_key IS NOT NULL;
