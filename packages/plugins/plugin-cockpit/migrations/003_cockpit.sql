-- CRM clients (kit crm-projection, from the CRM plugin company and contact
-- events). Company memory uses them to know every client by name and domain,
-- including a new client that has no facts yet.
CREATE TABLE plugin_cockpit_b8a99e8b16.crm_companies (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  name text NOT NULL,
  domain text,
  lifecycle text,
  updated_at timestamptz NOT NULL,
  deleted boolean NOT NULL DEFAULT false
);
CREATE INDEX crm_companies_company ON plugin_cockpit_b8a99e8b16.crm_companies (company_id, name);

CREATE TABLE plugin_cockpit_b8a99e8b16.crm_contacts (
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
CREATE INDEX crm_contacts_company ON plugin_cockpit_b8a99e8b16.crm_contacts (company_id, name);

-- Questions agents ask the owner with the ask-owner tool. One open ask per
-- issue; asking again updates it. The issue goes to the owner (in review)
-- and comes back to return_agent_id when the owner replies.
-- status: open, answered, resolved (closed as done or handed back without a
-- reply), cancelled (the issue was cancelled).
CREATE TABLE plugin_cockpit_b8a99e8b16.asks (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  issue_id text NOT NULL,
  issue_identifier text,
  issue_title text,
  agent_id text,
  return_agent_id text,
  run_id text,
  question text NOT NULL,
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  why text,
  kind text NOT NULL DEFAULT 'decision',
  links jsonb NOT NULL DEFAULT '[]'::jsonb,
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  client_ref text,
  due_by text,
  owner_user_id text,
  status text NOT NULL DEFAULT 'open',
  comment_id text,
  answer text,
  answer_comment_id text,
  answered_by_user_id text,
  asked_count integer NOT NULL DEFAULT 1,
  asked_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CONSTRAINT asks_status CHECK (status IN ('open', 'answered', 'resolved', 'cancelled')),
  CONSTRAINT asks_kind CHECK (kind IN ('decision', 'grant', 'money', 'legal', 'info'))
);
CREATE UNIQUE INDEX asks_open_issue ON plugin_cockpit_b8a99e8b16.asks (company_id, issue_id) WHERE status = 'open';
CREATE INDEX asks_company_status ON plugin_cockpit_b8a99e8b16.asks (company_id, status, asked_at);

-- Things the Cockpit records itself for What the agents did: hand-offs such
-- as a paid invoice or a won deal, onboarding opened, questions answered.
-- The key makes each line idempotent.
CREATE TABLE plugin_cockpit_b8a99e8b16.activity (
  company_id text NOT NULL,
  key text NOT NULL,
  kind text NOT NULL,
  at timestamptz NOT NULL,
  text text NOT NULL,
  href text,
  agent_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, key)
);
CREATE INDEX activity_recent ON plugin_cockpit_b8a99e8b16.activity (company_id, at DESC);

-- One onboarding issue per client, opened on its first won deal.
CREATE TABLE plugin_cockpit_b8a99e8b16.onboarding (
  company_id text NOT NULL,
  client_ref text NOT NULL,
  deal_key text NOT NULL,
  deal_id text,
  client_name text,
  issue_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, client_ref)
);

-- When each warning check was first seen, so a warning that lasts more than
-- a day reaches the System health issue.
CREATE TABLE plugin_cockpit_b8a99e8b16.health_warnings (
  company_id text NOT NULL,
  key text NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  PRIMARY KEY (company_id, key)
);

-- The company profile: who we are, what we sell, sender and brand voice.
-- Owners edit it on the Cockpit; agents may only fill empty fields.
-- filled_by records, per field, who set it last.
CREATE TABLE plugin_cockpit_b8a99e8b16.company_profile (
  company_id text PRIMARY KEY,
  profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  filled_by jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
