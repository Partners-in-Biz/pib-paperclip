-- 0.31.4: the ladder checks "already recorded?" per (target, action) for every issue in a tick
-- (latestRepairTimes). Before, it checked only the newest 500 rows and wrote ~35,000 duplicates a day.
-- Additive. Rollback: old code ignores the index.
CREATE INDEX IF NOT EXISTS repairs_company_kind_target_idx ON plugin_cockpit_b8a99e8b16.repairs (company_id, kind, target_id, action);
