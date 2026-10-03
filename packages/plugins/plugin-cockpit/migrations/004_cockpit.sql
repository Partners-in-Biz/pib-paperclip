-- 0.5.0: asks that do something when answered (RC5), memory feedback that can
-- say that it helped (Q2-7), owner confirmations (credentials, sign-up, custody),
-- paid invoices per client (Q1b-14) and close-out reviews (Q2-1).

-- An ask can carry an effect (kit ask-effects): what the system does once the
-- owner says yes. source is agent for ask-owner, cockpit for a question
-- the Cockpit asks itself (a grant, goals to adopt). The effect is announced to
-- the plugin that handles it and the agent is woken only when a result is in.
-- effect_status: pending | applied | already_applied | declined | unclear | failed | refused | timeout
ALTER TABLE plugin_cockpit_b8a99e8b16.asks ADD COLUMN source text NOT NULL DEFAULT 'agent';
ALTER TABLE plugin_cockpit_b8a99e8b16.asks ADD COLUMN effect jsonb;
ALTER TABLE plugin_cockpit_b8a99e8b16.asks ADD COLUMN effect_key text;
ALTER TABLE plugin_cockpit_b8a99e8b16.asks ADD COLUMN effect_status text;
ALTER TABLE plugin_cockpit_b8a99e8b16.asks ADD COLUMN effect_detail text;
ALTER TABLE plugin_cockpit_b8a99e8b16.asks ADD COLUMN effect_announced_at timestamptz;
ALTER TABLE plugin_cockpit_b8a99e8b16.asks ADD COLUMN effect_announced_count integer NOT NULL DEFAULT 0;
ALTER TABLE plugin_cockpit_b8a99e8b16.asks ADD COLUMN effect_result_at timestamptz;
ALTER TABLE plugin_cockpit_b8a99e8b16.asks ADD COLUMN handed_back_at timestamptz;
ALTER TABLE plugin_cockpit_b8a99e8b16.asks ADD CONSTRAINT asks_source CHECK (source IN ('agent', 'cockpit'));
ALTER TABLE plugin_cockpit_b8a99e8b16.asks ADD CONSTRAINT asks_effect_status CHECK (effect_status IS NULL OR effect_status IN ('pending', 'applied', 'already_applied', 'declined', 'unclear', 'failed', 'refused', 'timeout'));
CREATE INDEX asks_effect_pending ON plugin_cockpit_b8a99e8b16.asks (company_id, effect_status);

-- A brief that fully helped now leaves a trace too: without it, no feedback
-- could not be told apart from everything being fine (Q2-7).
ALTER TABLE plugin_cockpit_b8a99e8b16.memory_feedback DROP CONSTRAINT memory_feedback_kind;
ALTER TABLE plugin_cockpit_b8a99e8b16.memory_feedback ADD CONSTRAINT memory_feedback_kind CHECK (kind IN ('missing', 'noise', 'wrong', 'helpful'));

-- Things only the owner can confirm (nothing in the Paperclip API shows them):
-- board sign-up closed, backup key custody, a second break-glass admin.
-- Each confirmation lapses after expires_at and is asked for again.
CREATE TABLE plugin_cockpit_b8a99e8b16.attestations (
  company_id text NOT NULL,
  key text NOT NULL,
  confirmed_by text,
  confirmed_at timestamptz,
  note text,
  expires_at timestamptz,
  PRIMARY KEY (company_id, key)
);

-- Paid invoices per client, from the Billing invoice.paid event (one row per
-- event key), so effort can be set against what each client paid.
CREATE TABLE plugin_cockpit_b8a99e8b16.client_revenue (
  company_id text NOT NULL,
  key text NOT NULL,
  client_ref text,
  invoice_number text,
  total_minor bigint NOT NULL,
  currency text NOT NULL,
  paid_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, key)
);
CREATE INDEX client_revenue_client ON plugin_cockpit_b8a99e8b16.client_revenue (company_id, client_ref, paid_at DESC);

-- Close-out reviews opened for the Operator: one per project (or issue tree)
-- and period, so a finished project or a milestone is reviewed once.
-- scope_kind: project | tree. kind: final | milestone | tree.
CREATE TABLE plugin_cockpit_b8a99e8b16.closeout_reviews (
  company_id text NOT NULL,
  scope_kind text NOT NULL,
  scope_id text NOT NULL,
  period_key text NOT NULL,
  kind text NOT NULL,
  issue_id text,
  scope_name text,
  closed_count integer NOT NULL DEFAULT 0,
  opened_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, scope_kind, scope_id, period_key),
  CONSTRAINT closeout_scope_kind CHECK (scope_kind IN ('project', 'tree')),
  CONSTRAINT closeout_kind CHECK (kind IN ('final', 'milestone', 'tree'))
);
CREATE INDEX closeout_recent ON plugin_cockpit_b8a99e8b16.closeout_reviews (company_id, scope_kind, scope_id, opened_at DESC);
