-- Billing 0.4: deal links on quotes and invoices, payment checks asked for by agents,
-- standing work issues (drafts to send, overdue invoices, quote replies, won deals)
-- and hand-off events sent again for a day (quote accepted, invoice paid).

ALTER TABLE plugin_billing_287195dc99.quotes
  ADD COLUMN IF NOT EXISTS deal_id text,
  ADD COLUMN IF NOT EXISTS accepted_at timestamptz;

ALTER TABLE plugin_billing_287195dc99.invoices
  ADD COLUMN IF NOT EXISTS deal_id text;

CREATE INDEX IF NOT EXISTS quotes_deal ON plugin_billing_287195dc99.quotes (company_id, deal_id) WHERE deal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS invoices_deal ON plugin_billing_287195dc99.invoices (company_id, deal_id) WHERE deal_id IS NOT NULL;

ALTER TABLE plugin_billing_287195dc99.pops
  DROP CONSTRAINT pops_source,
  ADD CONSTRAINT pops_source CHECK (source IN ('email', 'upload', 'agent'));

ALTER TABLE plugin_billing_287195dc99.pops
  ADD COLUMN IF NOT EXISTS paid_on date;

-- One Paperclip issue per purpose, kept up to date instead of opening a new one each run.
CREATE TABLE plugin_billing_287195dc99.work_issues (
  key text PRIMARY KEY,
  company_id text NOT NULL,
  kind text NOT NULL,
  subject_id text,
  issue_id text NOT NULL,
  fingerprint text,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_issues_status CHECK (status IN ('open', 'closed'))
);

CREATE INDEX work_issues_company ON plugin_billing_287195dc99.work_issues (company_id, kind, status);

-- Hand-off events to other modules, sent once and repeated for a day with the same key.
CREATE TABLE plugin_billing_287195dc99.handoffs (
  key text PRIMARY KEY,
  company_id text NOT NULL,
  event text NOT NULL,
  payload jsonb NOT NULL,
  emits integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_emitted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX handoffs_recent ON plugin_billing_287195dc99.handoffs (created_at);
