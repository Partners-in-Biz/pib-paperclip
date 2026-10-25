-- 0.14.0: hosted usage roll-up. One row per hosted company per month, written by the daily
-- job in the owner company Cockpit. Counts and cost only: no titles, agent names or content.
-- Additive. Rollback: old code ignores the table.
CREATE TABLE IF NOT EXISTS plugin_cockpit_b8a99e8b16.hosted_usage (
  owner_company_id text NOT NULL,
  hosted_company_id text NOT NULL,
  company_name text NOT NULL DEFAULT '',
  month date NOT NULL,
  runs integer NOT NULL DEFAULT 0,
  notional_usd numeric NOT NULL DEFAULT 0,
  done_issues integer NOT NULL DEFAULT 0,
  agents integer NOT NULL DEFAULT 0,
  computed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hosted_usage_not_owner CHECK (owner_company_id <> hosted_company_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS hosted_usage_key ON plugin_cockpit_b8a99e8b16.hosted_usage (owner_company_id, hosted_company_id, month);
