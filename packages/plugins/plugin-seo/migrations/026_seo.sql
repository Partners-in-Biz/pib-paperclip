-- Recorded preview decisions (0.37.0, PAR-9131 T1a, PAR-9139): a preview can be declined, and every answer records who gave it and from where.
-- decision_source is cockpit, email or api. confirmed_by and confirmed_at hold a person confirming an email approval. apply_until,
-- applied_at, handover_done_at and handover_attempts belong to the hand-over (T1b). The CHECK is replaced NOT VALID first (brief lock,
-- no table scan), then validated (scan under a lighter lock). Answers from before this migration were all given on the email link.
-- Rollback (run BEFORE re-adding the old CHECK, and before rolling the plugin back): declined becomes changes_requested, which means
-- not approved, revise. The agent was already told so, and pending would put the preview back in front of the client.
--   UPDATE plugin_seo_8099f8879a.previews SET status = 'changes_requested' WHERE status = 'declined';
--   ALTER TABLE plugin_seo_8099f8879a.previews DROP CONSTRAINT previews_status_check;
--   ALTER TABLE plugin_seo_8099f8879a.previews ADD CONSTRAINT previews_status_check CHECK (status IN ('pending', 'approved', 'changes_requested', 'cancelled'));
-- The new columns stay: the old code ignores them.
ALTER TABLE plugin_seo_8099f8879a.previews ADD COLUMN decided_by text;
ALTER TABLE plugin_seo_8099f8879a.previews ADD COLUMN decision_source text;
ALTER TABLE plugin_seo_8099f8879a.previews ADD CONSTRAINT previews_decision_source_check CHECK (decision_source IN ('cockpit', 'email', 'api'));
ALTER TABLE plugin_seo_8099f8879a.previews ADD COLUMN confirmed_by text;
ALTER TABLE plugin_seo_8099f8879a.previews ADD COLUMN confirmed_at timestamptz;
ALTER TABLE plugin_seo_8099f8879a.previews ADD COLUMN apply_until timestamptz;
ALTER TABLE plugin_seo_8099f8879a.previews ADD COLUMN applied_at timestamptz;
ALTER TABLE plugin_seo_8099f8879a.previews ADD COLUMN handover_done_at timestamptz;
ALTER TABLE plugin_seo_8099f8879a.previews ADD COLUMN handover_attempts int NOT NULL DEFAULT 0;
ALTER TABLE plugin_seo_8099f8879a.previews DROP CONSTRAINT previews_status_check;
ALTER TABLE plugin_seo_8099f8879a.previews ADD CONSTRAINT previews_status_check CHECK (status IN ('pending', 'approved', 'changes_requested', 'cancelled', 'declined')) NOT VALID;
ALTER TABLE plugin_seo_8099f8879a.previews VALIDATE CONSTRAINT previews_status_check;
UPDATE plugin_seo_8099f8879a.previews SET decision_source = 'email', decided_by = 'client:email-link' WHERE decided_at IS NOT NULL AND status IN ('approved', 'changes_requested') AND decision_source IS NULL;
UPDATE plugin_seo_8099f8879a.previews SET handover_done_at = handed_at WHERE handed_at IS NOT NULL AND handover_done_at IS NULL;
