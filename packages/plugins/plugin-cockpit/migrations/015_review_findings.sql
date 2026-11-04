-- 0.19.0: reviewer findings (W1c H1). One row per finding per company, keyed by a hash of the finding,
-- so the same finding raised again is the same row with a higher seen_count. The author side of the work
-- (or the owner) sets the outcome later. The noise share is the part of rows with outcome wrong or
-- did_not_matter, computed in SQL by the Reflection Coach. Additive. Rollback: old code ignores the table.
CREATE TABLE IF NOT EXISTS plugin_cockpit_b8a99e8b16.review_findings (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  finding_hash text NOT NULL,
  issue_id text NOT NULL,
  issue_identifier text,
  pr_ref text,
  reviewer_agent_id text NOT NULL,
  author_agent_id text NOT NULL,
  tag text,
  file_path text,
  summary text NOT NULL,
  outcome text,
  outcome_note text,
  outcome_by_agent_id text,
  outcome_by_user_id text,
  outcome_at timestamptz,
  seen_count integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT review_findings_outcome CHECK (outcome IS NULL OR outcome IN ('fixed', 'wrong', 'intentional', 'did_not_matter'))
);
CREATE UNIQUE INDEX IF NOT EXISTS review_findings_hash ON plugin_cockpit_b8a99e8b16.review_findings (company_id, finding_hash);
CREATE INDEX IF NOT EXISTS review_findings_issue ON plugin_cockpit_b8a99e8b16.review_findings (company_id, issue_id);
