-- Ask defaults: fields for deadline_at, recommended answer, default_after_hours,
-- default_policy, and default_applied_at to support policy-driven auto-answers.
ALTER TABLE plugin_cockpit_b8a99e8b16.asks ADD COLUMN IF NOT EXISTS default_after_hours int NULL;
ALTER TABLE plugin_cockpit_b8a99e8b16.asks ADD COLUMN IF NOT EXISTS recommended text NULL;
ALTER TABLE plugin_cockpit_b8a99e8b16.asks ADD COLUMN IF NOT EXISTS default_applied_at timestamptz NULL;
ALTER TABLE plugin_cockpit_b8a99e8b16.asks ADD COLUMN IF NOT EXISTS default_policy text NULL;
ALTER TABLE plugin_cockpit_b8a99e8b16.asks ADD COLUMN IF NOT EXISTS deadline_at timestamptz NULL;
