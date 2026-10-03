-- 0.16.0: client preview links. A proposed page (the live page's HTML with the proposed copy swapped in) is saved
-- here and served by the public preview service (preview.partnersinbiz.online), which also records the client's answer.
CREATE TABLE plugin_seo_8099f8879a.previews (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  sprint_id text NOT NULL REFERENCES plugin_seo_8099f8879a.sprints (id) ON DELETE CASCADE,
  task_id text,
  issue_id text,
  page_url text NOT NULL,
  title text NOT NULL,
  html text NOT NULL,
  changes jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  decision_note text,
  decided_at timestamptz,
  notified_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT previews_status_check CHECK (status IN ('pending', 'approved', 'changes_requested'))
);

CREATE INDEX previews_sprint_idx ON plugin_seo_8099f8879a.previews (sprint_id, created_at DESC);
CREATE INDEX previews_undelivered_idx ON plugin_seo_8099f8879a.previews (company_id) WHERE decided_at IS NOT NULL AND notified_at IS NULL;
