-- 008: repairs table tracks system actions taken to fix issues detected by the
-- Cockpit checks. Each repair records what was wrong (kind), what was fixed (target_kind,
-- target_id), the action taken, the outcome, and details if needed.
CREATE TABLE IF NOT EXISTS plugin_cockpit_b8a99e8b16.repairs (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  kind text NOT NULL,
  target_kind text NOT NULL,
  target_id text NOT NULL,
  action text NOT NULL,
  outcome text NOT NULL,
  detail text NOT NULL DEFAULT '',
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS repairs_company_created_idx ON plugin_cockpit_b8a99e8b16.repairs (company_id, created_at DESC);
