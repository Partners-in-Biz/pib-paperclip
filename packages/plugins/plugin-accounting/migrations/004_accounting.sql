-- Accounting 0.4: the Reviewer pass on a ledger approval (manual journal, bank reconciliation, VAT201).
-- One row per approval request. state: not_required (no Reviewer was routed), pending (with the Reviewer),
-- passed (the Reviewer checked it and handed it to the approver), changes_needed (sent back to the Bookkeeper),
-- waived (a person approved without a recorded pass: flagged, never silent).

CREATE TABLE plugin_accounting_03d0185a67.approval_reviews (
  company_id text NOT NULL,
  kind text NOT NULL,
  subject_id text NOT NULL,
  issue_id text,
  state text NOT NULL DEFAULT 'not_required',
  prepared_by jsonb,
  reviewer jsonb,
  findings text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  waived_by text,
  PRIMARY KEY (company_id, kind, subject_id),
  CONSTRAINT approval_reviews_kind CHECK (kind IN ('draft', 'reconciliation', 'vat')),
  CONSTRAINT approval_reviews_state CHECK (state IN ('not_required', 'pending', 'passed', 'changes_needed', 'waived'))
);

CREATE INDEX approval_reviews_issue ON plugin_accounting_03d0185a67.approval_reviews (company_id, issue_id);

CREATE INDEX approval_reviews_open ON plugin_accounting_03d0185a67.approval_reviews (company_id, state);
