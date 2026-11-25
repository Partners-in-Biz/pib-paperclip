-- 0.48.4 (PAR-10301): idempotent create-preview. request_key is the sha256 of everything that shapes a preview (company,
-- sprint, page, task, changes, allowReplace, label, client, rubric); an identical call within 30 minutes gets the stored
-- preview back (reused: true) instead of a second row, review issue and Drive copy. Older rows keep NULL and are never reused.
-- The preview server (ops/preview-server, role pib_preview) neither reads nor writes this column, so no GRANT is needed.
-- Rollback: revert the plugin (the old code never reads the column), then optionally
--   DROP INDEX plugin_seo_8099f8879a.previews_request_key;
--   ALTER TABLE plugin_seo_8099f8879a.previews DROP COLUMN request_key;
ALTER TABLE plugin_seo_8099f8879a.previews ADD COLUMN request_key text;
CREATE INDEX previews_request_key ON plugin_seo_8099f8879a.previews (company_id, request_key) WHERE request_key IS NOT NULL;
