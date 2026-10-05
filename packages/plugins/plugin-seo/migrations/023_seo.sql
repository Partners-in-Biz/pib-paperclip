-- 0.26.0: client sign-off mode per sprint, and the approval email draft of a preview. Manual (every existing sprint) keeps what a
-- person does today: put the preview link on Needs you, press Apply approved changes after the client answered. Auto parks the
-- task on the client when the Reviewer passes a preview, drafts one approval email in Gmail, and lifts the write lock for a short
-- window when the client presses Approve.

ALTER TABLE plugin_seo_8099f8879a.sprints ADD COLUMN client_signoff text NOT NULL DEFAULT 'manual';

ALTER TABLE plugin_seo_8099f8879a.sprints ADD CONSTRAINT sprints_client_signoff_check CHECK (client_signoff IN ('manual', 'auto'));

ALTER TABLE plugin_seo_8099f8879a.previews ADD COLUMN draft_key text;

ALTER TABLE plugin_seo_8099f8879a.previews ADD COLUMN draft_status text;

ALTER TABLE plugin_seo_8099f8879a.previews ADD COLUMN draft_url text;

ALTER TABLE plugin_seo_8099f8879a.previews ADD COLUMN drafted_at timestamptz;

-- When the client answer of this preview was handed to the SEO agent (apply it, or revise it): once, never again.
ALTER TABLE plugin_seo_8099f8879a.previews ADD COLUMN handed_at timestamptz;

CREATE INDEX previews_draft_wait ON plugin_seo_8099f8879a.previews (company_id, sprint_id) WHERE review_status = 'passed' AND draft_key IS NULL;
