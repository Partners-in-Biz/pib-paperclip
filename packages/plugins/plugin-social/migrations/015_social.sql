-- 0.8.0: who approves a post, the client's own approval, review outcomes, connection requests.
-- - approval_policies: one row per scope (own work, or one client). No row = the owner approves (the behaviour before 0.8.0).
-- - client_approvals: a tokenised link for one post, the snapshot the client sees and the client's answer. The public
--   approval service (ops/approval-server) reads these rows and writes only the answer columns.
-- - review_outcomes: every Reviewer, owner and client verdict on a post, by post type: the inputs a later autonomy
--   ladder needs. Nothing here approves anything by itself.
-- - connect_requests: an agent asked a person to connect an account; the connect flow resolves it and wakes the issue.

CREATE TABLE plugin_social_e70c4e79f2.approval_policies (
  company_id text NOT NULL,
  scope_key text NOT NULL,
  client_kind text,
  client_ref text,
  client_name text,
  require_reviewer boolean NOT NULL DEFAULT false,
  require_owner boolean NOT NULL DEFAULT true,
  require_client boolean NOT NULL DEFAULT false,
  link_expiry_days integer NOT NULL DEFAULT 14,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, scope_key),
  CONSTRAINT approval_policies_someone CHECK (require_owner OR require_client),
  CONSTRAINT approval_policies_days CHECK (link_expiry_days BETWEEN 1 AND 60),
  CONSTRAINT approval_policies_client_kind CHECK (client_kind IS NULL OR client_kind IN ('company', 'contact')),
  CONSTRAINT approval_policies_client_scope CHECK (NOT require_client OR client_ref IS NOT NULL)
);

CREATE TABLE plugin_social_e70c4e79f2.client_approvals (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  post_id text NOT NULL REFERENCES plugin_social_e70c4e79f2.posts (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  client_kind text,
  client_ref text,
  client_name text,
  recipient_email text,
  content_hash text NOT NULL,
  snapshot jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  answered_by_name text,
  answer_note text,
  answered_at timestamptz,
  notified_at timestamptz,
  applied text,
  issue_id text,
  created_by text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_approvals_status CHECK (status IN ('pending', 'approved', 'changes_requested', 'superseded', 'expired')),
  CONSTRAINT client_approvals_kind CHECK (client_kind IS NULL OR client_kind IN ('company', 'contact'))
);
CREATE INDEX client_approvals_post ON plugin_social_e70c4e79f2.client_approvals (post_id, status);
CREATE INDEX client_approvals_answers ON plugin_social_e70c4e79f2.client_approvals (answered_at) WHERE answered_at IS NOT NULL AND notified_at IS NULL;
CREATE INDEX client_approvals_open ON plugin_social_e70c4e79f2.client_approvals (company_id, expires_at) WHERE status = 'pending';

CREATE TABLE plugin_social_e70c4e79f2.review_outcomes (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  post_id text NOT NULL,
  stage text NOT NULL,
  outcome text NOT NULL,
  round integer NOT NULL DEFAULT 1,
  content_hash text,
  post_type text NOT NULL,
  format text NOT NULL,
  source text,
  platforms jsonb NOT NULL DEFAULT '[]'::jsonb,
  client_kind text,
  client_ref text,
  via text NOT NULL DEFAULT 'tool',
  actor_user_id text,
  actor_agent_id text,
  actor_name text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT review_outcomes_stage CHECK (stage IN ('reviewer', 'owner', 'client')),
  CONSTRAINT review_outcomes_outcome CHECK (outcome IN ('approved', 'changes')),
  CONSTRAINT review_outcomes_kind CHECK (client_kind IS NULL OR client_kind IN ('company', 'contact'))
);
CREATE UNIQUE INDEX review_outcomes_round ON plugin_social_e70c4e79f2.review_outcomes (post_id, stage, round);
CREATE INDEX review_outcomes_type ON plugin_social_e70c4e79f2.review_outcomes (company_id, post_type, stage, created_at);
CREATE INDEX review_outcomes_scope ON plugin_social_e70c4e79f2.review_outcomes (company_id, client_ref, client_kind, created_at);

CREATE TABLE plugin_social_e70c4e79f2.connect_requests (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  platform text NOT NULL,
  client_kind text,
  client_ref text,
  client_name text,
  agent_id text,
  run_id text,
  issue_id text,
  status text NOT NULL DEFAULT 'open',
  account_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT connect_requests_status CHECK (status IN ('open', 'resolved', 'cancelled')),
  CONSTRAINT connect_requests_kind CHECK (client_kind IS NULL OR client_kind IN ('company', 'contact'))
);
CREATE UNIQUE INDEX connect_requests_open ON plugin_social_e70c4e79f2.connect_requests (company_id, platform, coalesce(client_kind, ''), coalesce(client_ref, ''), coalesce(issue_id, '')) WHERE status = 'open';
CREATE INDEX connect_requests_lookup ON plugin_social_e70c4e79f2.connect_requests (company_id, status, platform);
