-- Cancelled previews (0.33.0, PAR-8972 T1a): a duplicate or superseded preview can be taken out of the client's sight without
-- being deleted. `cancelled_prev_status` keeps the exact prior status so a rollback can put the row back as it was.
-- The CHECK is replaced NOT VALID first (brief lock, no table scan), then validated (scan under a lighter lock).
-- Rollback, option A: bring the duplicates back exactly as they were (run BEFORE re-adding the old CHECK, and before rolling the plugin back):
--   UPDATE plugin_seo_8099f8879a.previews SET status = cancelled_prev_status WHERE status = 'cancelled';
--   ALTER TABLE plugin_seo_8099f8879a.previews DROP CONSTRAINT previews_status_check;
--   ALTER TABLE plugin_seo_8099f8879a.previews ADD CONSTRAINT previews_status_check CHECK (status IN ('pending', 'approved', 'changes_requested'));
-- Rollback, option B: keep the duplicates hidden under the old code (expired), then re-add the old CHECK as above:
--   UPDATE plugin_seo_8099f8879a.previews SET status = COALESCE(cancelled_prev_status, 'pending'), expires_at = LEAST(expires_at, now()) WHERE status = 'cancelled' AND COALESCE(cancelled_prev_status, 'pending') = 'pending';
--   UPDATE plugin_seo_8099f8879a.previews SET status = cancelled_prev_status WHERE status = 'cancelled';
ALTER TABLE plugin_seo_8099f8879a.previews ADD COLUMN cancelled_at timestamptz;
ALTER TABLE plugin_seo_8099f8879a.previews ADD COLUMN cancelled_by text;
ALTER TABLE plugin_seo_8099f8879a.previews ADD COLUMN cancel_reason text;
ALTER TABLE plugin_seo_8099f8879a.previews ADD COLUMN cancelled_prev_status text;
ALTER TABLE plugin_seo_8099f8879a.previews DROP CONSTRAINT previews_status_check;
ALTER TABLE plugin_seo_8099f8879a.previews ADD CONSTRAINT previews_status_check CHECK (status IN ('pending', 'approved', 'changes_requested', 'cancelled')) NOT VALID;
ALTER TABLE plugin_seo_8099f8879a.previews VALIDATE CONSTRAINT previews_status_check;
