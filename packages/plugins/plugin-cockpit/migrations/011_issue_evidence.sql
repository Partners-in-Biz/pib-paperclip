-- 010: Issue evidence table for redacted screenshot and evidence attachment logging.
-- - issue_evidence: records of evidence (attachments, screenshots) associated with issues

CREATE TABLE IF NOT EXISTS plugin_cockpit_b8a99e8b16.issue_evidence (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  issue_id text NOT NULL,
  run_id text,
  agent_id text,
  step text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('shot', 'exempt')),
  attachment_id text,
  note text,
  inbox_posted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS issue_evidence_company_issue_idx ON plugin_cockpit_b8a99e8b16.issue_evidence (company_id, issue_id);
CREATE UNIQUE INDEX IF NOT EXISTS issue_evidence_unique_idx ON plugin_cockpit_b8a99e8b16.issue_evidence (company_id, issue_id, step, attachment_id) WHERE attachment_id IS NOT NULL;
