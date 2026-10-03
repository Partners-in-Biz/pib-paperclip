-- 0.18.0: previews are held from the client until the Reviewer has compared them with the live page.
-- review_key opens the staff and reviewer view (side-by-side screenshots and text figures) without the client link.
ALTER TABLE plugin_seo_8099f8879a.previews ADD COLUMN review_status text NOT NULL DEFAULT 'pending';
ALTER TABLE plugin_seo_8099f8879a.previews ADD COLUMN review_note text;
ALTER TABLE plugin_seo_8099f8879a.previews ADD COLUMN reviewed_by text;
ALTER TABLE plugin_seo_8099f8879a.previews ADD COLUMN reviewed_at timestamptz;
ALTER TABLE plugin_seo_8099f8879a.previews ADD COLUMN review_issue_id text;
ALTER TABLE plugin_seo_8099f8879a.previews ADD COLUMN review_key text;
ALTER TABLE plugin_seo_8099f8879a.previews ADD COLUMN stats jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE plugin_seo_8099f8879a.previews ADD CONSTRAINT previews_review_status_check CHECK (review_status IN ('pending', 'passed', 'changes_needed'));
