-- Paid ads: scopes (own or one client) with caps and switches, platform connections, ad accounts, campaigns, daily rollups,
-- an append-only spend ledger, alerts, governed change proposals with their approvals, an audit trail, and the CRM projection.
-- Money is integer minor units in the currency of the scope. No secret is stored in the clear: tokens are sealed (token_enc).

CREATE TABLE plugin_ads_caac8387d2.scopes (
  company_id text NOT NULL,
  -- own (the company itself) or company:<crm id> or contact:<crm id> (one client)
  scope_key text NOT NULL,
  client_kind text,
  client_ref text,
  currency text NOT NULL DEFAULT 'ZAR',
  -- The monthly cap; null until a person sets one (the checklist asks for it)
  monthly_cap_minor bigint,
  alert_pct integer NOT NULL DEFAULT 90,
  target_cpa_minor bigint,
  -- Off by default. Only a person turns it on, and every change still needs an approval.
  allow_writes boolean NOT NULL DEFAULT false,
  allow_writes_by text,
  allow_writes_at timestamptz,
  -- Who must sign a change: owner, or owner_client (the client must say yes as well)
  signoffs text NOT NULL DEFAULT 'owner',
  banned_words jsonb NOT NULL DEFAULT '[]'::jsonb,
  brand_note text,
  brand_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, scope_key),
  CONSTRAINT scopes_signoffs CHECK (signoffs IN ('owner', 'owner_client')),
  CONSTRAINT scopes_alert_pct CHECK (alert_pct BETWEEN 50 AND 100),
  CONSTRAINT scopes_client CHECK ((scope_key = 'own' AND client_ref IS NULL) OR (scope_key <> 'own' AND client_ref IS NOT NULL))
);

-- A cap for one month that differs from the usual cap of the scope (a sale, a launch)
CREATE TABLE plugin_ads_caac8387d2.budget_overrides (
  company_id text NOT NULL,
  scope_key text NOT NULL,
  month text NOT NULL,
  cap_minor bigint NOT NULL,
  note text,
  set_by text NOT NULL,
  set_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, scope_key, month),
  CONSTRAINT budget_overrides_month CHECK (month ~ '^[0-9]{4}-[0-9]{2}$')
);

CREATE TABLE plugin_ads_caac8387d2.connections (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  platform text NOT NULL,
  label text NOT NULL,
  -- oauth (signed in; token sealed here) or token (a saved system-user token read from the settings, nothing sealed)
  mode text NOT NULL DEFAULT 'oauth',
  token_enc text,
  key_version integer,
  token_expires_at timestamptz,
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The permission allows changing ads (Meta ads_management). The switch on the scope row is separate.
  can_write boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'connected',
  status_detail text,
  external_user_id text,
  reconnect_issue_id text,
  last_ok_at timestamptz,
  created_by_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT connections_platform CHECK (platform IN ('meta', 'google', 'mock')),
  CONSTRAINT connections_mode CHECK (mode IN ('oauth', 'token')),
  CONSTRAINT connections_status CHECK (status IN ('connected', 'expiring', 'needs_reconnect', 'disabled'))
);

CREATE INDEX connections_company ON plugin_ads_caac8387d2.connections (company_id, platform);

CREATE TABLE plugin_ads_caac8387d2.ad_accounts (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  platform text NOT NULL,
  external_id text NOT NULL,
  name text NOT NULL,
  currency text NOT NULL,
  timezone text,
  scope_key text NOT NULL,
  connection_id text REFERENCES plugin_ads_caac8387d2.connections (id),
  status text NOT NULL DEFAULT 'active',
  -- Google: the manager account sent as login-customer-id
  login_customer_id text,
  -- Meta: which actions count as a result, in order of preference; empty = the default list
  conversion_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_sync_at timestamptz,
  last_sync_ok_at timestamptz,
  last_sync_error text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ad_accounts_platform CHECK (platform IN ('meta', 'google', 'mock')),
  CONSTRAINT ad_accounts_status CHECK (status IN ('active', 'paused', 'disabled'))
);

CREATE UNIQUE INDEX ad_accounts_external ON plugin_ads_caac8387d2.ad_accounts (company_id, platform, external_id);
CREATE INDEX ad_accounts_scope ON plugin_ads_caac8387d2.ad_accounts (company_id, scope_key);

CREATE TABLE plugin_ads_caac8387d2.campaigns (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  account_id text NOT NULL REFERENCES plugin_ads_caac8387d2.ad_accounts (id),
  external_id text NOT NULL,
  name text NOT NULL,
  status text NOT NULL,
  raw_status text,
  objective text,
  channel text,
  daily_budget_minor bigint,
  lifetime_budget_minor bigint,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaigns_status CHECK (status IN ('active', 'paused', 'archived', 'other'))
);

CREATE UNIQUE INDEX campaigns_external ON plugin_ads_caac8387d2.campaigns (account_id, external_id);
CREATE INDEX campaigns_company ON plugin_ads_caac8387d2.campaigns (company_id, status);

-- One row per campaign per day (the platform restates recent days, so a sync rewrites them)
CREATE TABLE plugin_ads_caac8387d2.daily (
  company_id text NOT NULL,
  account_id text NOT NULL REFERENCES plugin_ads_caac8387d2.ad_accounts (id),
  campaign_external_id text NOT NULL,
  day date NOT NULL,
  spend_minor bigint NOT NULL DEFAULT 0,
  impressions bigint NOT NULL DEFAULT 0,
  clicks bigint NOT NULL DEFAULT 0,
  conversions numeric(14, 2) NOT NULL DEFAULT 0,
  conversion_value_minor bigint NOT NULL DEFAULT 0,
  currency text NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, campaign_external_id, day)
);

CREATE INDEX daily_company_day ON plugin_ads_caac8387d2.daily (company_id, day);

-- Append-only: every change to the spend of a day is one entry, so the total of a month and every restatement can be explained
CREATE TABLE plugin_ads_caac8387d2.spend_ledger (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  account_id text NOT NULL REFERENCES plugin_ads_caac8387d2.ad_accounts (id),
  scope_key text NOT NULL,
  campaign_external_id text NOT NULL,
  day date NOT NULL,
  seq integer NOT NULL,
  delta_minor bigint NOT NULL,
  total_minor bigint NOT NULL,
  currency text NOT NULL,
  kind text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT spend_ledger_kind CHECK (kind IN ('first', 'restatement'))
);

CREATE UNIQUE INDEX spend_ledger_entry ON plugin_ads_caac8387d2.spend_ledger (account_id, campaign_external_id, day, seq);
CREATE INDEX spend_ledger_company ON plugin_ads_caac8387d2.spend_ledger (company_id, day);

CREATE TABLE plugin_ads_caac8387d2.alerts (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  scope_key text NOT NULL,
  account_id text,
  campaign_external_id text,
  kind text NOT NULL,
  severity text NOT NULL,
  dedupe_key text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'open',
  issue_id text,
  note text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT alerts_severity CHECK (severity IN ('info', 'warn', 'bad')),
  CONSTRAINT alerts_status CHECK (status IN ('open', 'acknowledged', 'resolved'))
);

CREATE UNIQUE INDEX alerts_dedupe ON plugin_ads_caac8387d2.alerts (company_id, dedupe_key);
CREATE INDEX alerts_open ON plugin_ads_caac8387d2.alerts (company_id, status);

-- A change somebody wants made to ads, with the numbers. Nothing here moves money; execution is a separate, guarded step.
CREATE TABLE plugin_ads_caac8387d2.proposals (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  scope_key text NOT NULL,
  account_id text,
  kind text NOT NULL,
  status text NOT NULL,
  title text NOT NULL,
  summary text NOT NULL DEFAULT '',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Cap and pacing numbers at the time of the request (what the approver is shown)
  impact jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Hash of kind, scope, account and payload: an approval is for exactly these numbers
  content_hash text NOT NULL,
  precheck jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- not_required, pending, pass, changes or waived
  review_state text NOT NULL DEFAULT 'not_required',
  review_notes text,
  review_by text,
  review_at timestamptz,
  review_hash text,
  requires_signoffs jsonb NOT NULL DEFAULT '["owner"]'::jsonb,
  cap_state text NOT NULL DEFAULT 'no_cap',
  origin text NOT NULL DEFAULT 'agent',
  origin_ref text,
  approval_issue_id text,
  client_ask_issue_id text,
  client_action_ref text,
  expires_at timestamptz,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  executed_at timestamptz,
  execution jsonb,
  error text,
  CONSTRAINT proposals_kind CHECK (kind IN ('create_campaign', 'change_budget', 'pause_campaign', 'resume_campaign', 'creative_check')),
  CONSTRAINT proposals_status CHECK (status IN ('needs_changes', 'in_review', 'approved', 'executing', 'executed', 'cleared', 'failed', 'rejected', 'cancelled', 'expired')),
  CONSTRAINT proposals_review CHECK (review_state IN ('not_required', 'pending', 'pass', 'changes', 'waived')),
  CONSTRAINT proposals_cap_state CHECK (cap_state IN ('no_cap', 'within', 'exceeds'))
);

CREATE INDEX proposals_company ON plugin_ads_caac8387d2.proposals (company_id, status);
CREATE INDEX proposals_issue ON plugin_ads_caac8387d2.proposals (company_id, approval_issue_id);

-- The yes (or no) of a person on one proposal. Only a person can write one; the hash ties it to exact numbers; a used one never runs twice.
CREATE TABLE plugin_ads_caac8387d2.approvals (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  proposal_id text NOT NULL REFERENCES plugin_ads_caac8387d2.proposals (id),
  role text NOT NULL,
  decision text NOT NULL,
  decided_by text NOT NULL,
  content_hash text NOT NULL,
  -- The approver saw that the change goes over the months cap and said yes anyway
  over_cap_ack boolean NOT NULL DEFAULT false,
  note text,
  -- For a clients yes: where it is recorded (the CRM client action and what the client wrote)
  evidence_ref text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approvals_role CHECK (role IN ('owner', 'client')),
  CONSTRAINT approvals_decision CHECK (decision IN ('approved', 'rejected')),
  CONSTRAINT approvals_person CHECK (decided_by LIKE 'user:%')
);

CREATE INDEX approvals_proposal ON plugin_ads_caac8387d2.approvals (company_id, proposal_id);

-- Who changed what: switches, caps, approvals, every write call (no secret ever goes in)
CREATE TABLE plugin_ads_caac8387d2.audit (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  action text NOT NULL,
  scope_key text,
  subject text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX audit_company ON plugin_ads_caac8387d2.audit (company_id, at);

CREATE TABLE plugin_ads_caac8387d2.oauth_sessions (
  state text PRIMARY KEY,
  company_id text NOT NULL,
  platform text NOT NULL,
  created_by_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed boolean NOT NULL DEFAULT false
);

-- The clients of the CRM, kept as a local copy through events (a plugin may not read the tables of another plugin)
CREATE TABLE plugin_ads_caac8387d2.crm_companies (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  name text NOT NULL,
  domain text,
  lifecycle text,
  updated_at timestamptz NOT NULL,
  deleted boolean NOT NULL DEFAULT false
);

CREATE INDEX crm_companies_company ON plugin_ads_caac8387d2.crm_companies (company_id, name);

CREATE TABLE plugin_ads_caac8387d2.crm_contacts (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  name text NOT NULL,
  emails text[] NOT NULL DEFAULT '{}',
  phones text[] NOT NULL DEFAULT '{}',
  lifecycle text,
  tags text[] NOT NULL DEFAULT '{}',
  account_ids text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL,
  deleted boolean NOT NULL DEFAULT false
);

CREATE INDEX crm_contacts_company ON plugin_ads_caac8387d2.crm_contacts (company_id, name);
