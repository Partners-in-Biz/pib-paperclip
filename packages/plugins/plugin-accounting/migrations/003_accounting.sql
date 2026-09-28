-- Accounting: bank statement emails from the Mailbox and what became of each one.
-- received = waiting to be imported; imported = its lines are in the books; duplicate = it was imported before; not_statement = the email holds no statement;
-- closed = a person closed its issue without an import linked to the email.

CREATE TABLE plugin_accounting_03d0185a67.statement_emails (
  company_id text NOT NULL,
  message_id text NOT NULL,
  subject text NOT NULL DEFAULT '',
  sender text NOT NULL DEFAULT '',
  received_at timestamptz,
  issue_id text,
  status text NOT NULL DEFAULT 'received',
  statement_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  note text,
  resolved_by jsonb,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, message_id),
  CONSTRAINT statement_emails_status CHECK (status IN ('received', 'imported', 'duplicate', 'not_statement', 'closed'))
);

CREATE INDEX statement_emails_open ON plugin_accounting_03d0185a67.statement_emails (company_id, status);

-- Accounting: month-end steps recorded as not needed, with the reason (step is vat201 or reconciliation:BANK_ACCOUNT_ID).

CREATE TABLE plugin_accounting_03d0185a67.close_skips (
  company_id text NOT NULL,
  month text NOT NULL,
  step text NOT NULL,
  reason text NOT NULL,
  recorded_by jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, month, step)
);
