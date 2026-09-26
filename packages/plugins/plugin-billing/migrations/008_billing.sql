-- Billing 0.3: per-line VAT codes, EFT statuses, settle(), credit applications,
-- per-client numbering, outbox/inbox for Mailbox and Accounting, deliveries,
-- proof of payment and decision issues.

ALTER TABLE plugin_billing_287195dc99.invoices
  DROP CONSTRAINT invoices_status,
  ADD CONSTRAINT invoices_status CHECK (status IN ('draft', 'sent', 'viewed', 'payment_pending_verification', 'partially_paid', 'paid', 'overdue', 'cancelled', 'written_off'));

ALTER TABLE plugin_billing_287195dc99.invoices
  ADD COLUMN IF NOT EXISTS default_tax_code text,
  ADD COLUMN IF NOT EXISTS prices_include_vat boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS subtotal_minor bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vat_minor bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS fx_rate numeric,
  ADD COLUMN IF NOT EXISTS send_to jsonb,
  ADD COLUMN IF NOT EXISTS delivery_key text,
  ADD COLUMN IF NOT EXISTS delivery_status text,
  ADD COLUMN IF NOT EXISTS delivery_error text,
  ADD COLUMN IF NOT EXISTS mail_seq integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pdf_key text,
  ADD COLUMN IF NOT EXISTS pdf_at timestamptz,
  ADD COLUMN IF NOT EXISTS ledger_status text,
  ADD COLUMN IF NOT EXISTS ledger_error text,
  ADD COLUMN IF NOT EXISTS issue_journal text,
  ADD COLUMN IF NOT EXISTS recurring_id text,
  ADD COLUMN IF NOT EXISTS recurring_key text,
  ADD COLUMN IF NOT EXISTS subscription_id text,
  ADD COLUMN IF NOT EXISTS quote_id text,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS void_reason text;

CREATE UNIQUE INDEX IF NOT EXISTS invoices_recurring_key ON plugin_billing_287195dc99.invoices (recurring_key) WHERE recurring_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS invoices_open ON plugin_billing_287195dc99.invoices (company_id, status, due_at);

CREATE INDEX IF NOT EXISTS invoices_customer ON plugin_billing_287195dc99.invoices (company_id, customer_kind, customer_ref);

-- Legacy totals: subtotal is the sum of the lines, VAT the rest of the total.
UPDATE plugin_billing_287195dc99.invoices i
   SET subtotal_minor = COALESCE((SELECT sum(l.quantity * l.unit_amount_minor) FROM plugin_billing_287195dc99.invoice_lines l WHERE l.invoice_id = i.id), 0)
 WHERE i.subtotal_minor = 0;

UPDATE plugin_billing_287195dc99.invoices
   SET vat_minor = GREATEST(0, total_minor - subtotal_minor)
 WHERE vat_minor = 0 AND total_minor > subtotal_minor;

ALTER TABLE plugin_billing_287195dc99.invoice_lines
  ADD COLUMN IF NOT EXISTS tax_code text,
  ADD COLUMN IF NOT EXISTS net_minor bigint,
  ADD COLUMN IF NOT EXISTS vat_minor bigint,
  ADD COLUMN IF NOT EXISTS gross_minor bigint,
  ADD COLUMN IF NOT EXISTS time_entry_id text;

ALTER TABLE plugin_billing_287195dc99.quotes
  ADD COLUMN IF NOT EXISTS default_tax_code text,
  ADD COLUMN IF NOT EXISTS prices_include_vat boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS subtotal_minor bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vat_minor bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS send_to jsonb,
  ADD COLUMN IF NOT EXISTS approval_issue_id text,
  ADD COLUMN IF NOT EXISTS pending_action text,
  ADD COLUMN IF NOT EXISTS sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_key text,
  ADD COLUMN IF NOT EXISTS delivery_status text,
  ADD COLUMN IF NOT EXISTS delivery_error text,
  ADD COLUMN IF NOT EXISTS mail_seq integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pdf_key text;

UPDATE plugin_billing_287195dc99.quotes q
   SET subtotal_minor = COALESCE((SELECT sum(l.quantity * l.unit_amount_minor) FROM plugin_billing_287195dc99.quote_lines l WHERE l.quote_id = q.id), 0)
 WHERE q.subtotal_minor = 0;

UPDATE plugin_billing_287195dc99.quotes
   SET vat_minor = GREATEST(0, total_minor - subtotal_minor)
 WHERE vat_minor = 0 AND total_minor > subtotal_minor;

ALTER TABLE plugin_billing_287195dc99.quote_lines
  ADD COLUMN IF NOT EXISTS tax_code text,
  ADD COLUMN IF NOT EXISTS net_minor bigint,
  ADD COLUMN IF NOT EXISTS vat_minor bigint,
  ADD COLUMN IF NOT EXISTS gross_minor bigint;

ALTER TABLE plugin_billing_287195dc99.credit_notes
  ADD COLUMN IF NOT EXISTS number text,
  ADD COLUMN IF NOT EXISTS currency text,
  ADD COLUMN IF NOT EXISTS customer_kind text,
  ADD COLUMN IF NOT EXISTS customer_ref text,
  ADD COLUMN IF NOT EXISTS issued_on date,
  ADD COLUMN IF NOT EXISTS pdf_key text,
  ADD COLUMN IF NOT EXISTS delivery_key text,
  ADD COLUMN IF NOT EXISTS delivery_status text,
  ADD COLUMN IF NOT EXISTS delivery_error text,
  ADD COLUMN IF NOT EXISTS mail_seq integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ledger_status text,
  ADD COLUMN IF NOT EXISTS journal_number text,
  ADD COLUMN IF NOT EXISTS created_by text;

UPDATE plugin_billing_287195dc99.credit_notes n
   SET currency = i.currency, customer_kind = i.customer_kind, customer_ref = i.customer_ref
  FROM plugin_billing_287195dc99.invoices i
 WHERE i.id = n.invoice_id AND n.currency IS NULL;

ALTER TABLE plugin_billing_287195dc99.payments
  ADD COLUMN IF NOT EXISTS allocated_minor bigint,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS source_key text,
  ADD COLUMN IF NOT EXISTS bank_tx_id text,
  ADD COLUMN IF NOT EXISTS pop_id text,
  ADD COLUMN IF NOT EXISTS currency text,
  ADD COLUMN IF NOT EXISTS customer_kind text,
  ADD COLUMN IF NOT EXISTS customer_ref text,
  ADD COLUMN IF NOT EXISTS fx_rate numeric,
  ADD COLUMN IF NOT EXISTS ledger_status text,
  ADD COLUMN IF NOT EXISTS journal_number text,
  ADD COLUMN IF NOT EXISTS created_by text;

UPDATE plugin_billing_287195dc99.payments SET allocated_minor = amount_minor WHERE allocated_minor IS NULL;

UPDATE plugin_billing_287195dc99.payments SET source_key = 'legacy:' || id WHERE source_key IS NULL;

UPDATE plugin_billing_287195dc99.payments p
   SET currency = i.currency, customer_kind = i.customer_kind, customer_ref = i.customer_ref
  FROM plugin_billing_287195dc99.invoices i
 WHERE i.id = p.invoice_id AND p.currency IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS payments_source_key ON plugin_billing_287195dc99.payments (company_id, source_key);

CREATE INDEX IF NOT EXISTS payments_bank_tx ON plugin_billing_287195dc99.payments (company_id, bank_tx_id) WHERE bank_tx_id IS NOT NULL;

-- Credit applied to an invoice: a credit note, an overpayment by the customer, or a write-off.
CREATE TABLE plugin_billing_287195dc99.credit_applications (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  key text NOT NULL,
  invoice_id text NOT NULL REFERENCES plugin_billing_287195dc99.invoices (id),
  source_kind text NOT NULL,
  source_id text NOT NULL,
  amount_minor bigint NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_applications_kind CHECK (source_kind IN ('credit_note', 'payment', 'write_off')),
  CONSTRAINT credit_applications_amount CHECK (amount_minor > 0)
);

CREATE UNIQUE INDEX credit_applications_key ON plugin_billing_287195dc99.credit_applications (company_id, key);

CREATE INDEX credit_applications_invoice ON plugin_billing_287195dc99.credit_applications (invoice_id);

CREATE INDEX credit_applications_source ON plugin_billing_287195dc99.credit_applications (source_kind, source_id);

-- Credit notes issued before 0.3 counted against their invoice; keep that.
INSERT INTO plugin_billing_287195dc99.credit_applications (id, company_id, key, invoice_id, source_kind, source_id, amount_minor, created_by, created_at)
SELECT 'legacy-' || n.id, n.company_id, 'credit_note:' || n.id || ':' || n.invoice_id, n.invoice_id, 'credit_note', n.id, n.amount_minor, 'migration', n.created_at
  FROM plugin_billing_287195dc99.credit_notes n
 WHERE n.amount_minor > 0
ON CONFLICT DO NOTHING;

-- Per-client prefixes (LUM) and counters per document kind and prefix.
CREATE TABLE plugin_billing_287195dc99.client_prefixes (
  company_id text NOT NULL,
  customer_kind text NOT NULL,
  customer_ref text NOT NULL,
  prefix text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, customer_kind, customer_ref)
);

CREATE UNIQUE INDEX client_prefixes_prefix ON plugin_billing_287195dc99.client_prefixes (company_id, prefix);

CREATE TABLE plugin_billing_287195dc99.numbering_counters (
  company_id text NOT NULL,
  kind text NOT NULL,
  prefix text NOT NULL,
  n bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, kind, prefix)
);

CREATE TABLE plugin_billing_287195dc99.number_claims (
  company_id text NOT NULL,
  kind text NOT NULL,
  number text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, kind, number)
);

-- Reliable cross-plugin delivery (kit outbox.ts / receiveOnce).
CREATE TABLE plugin_billing_287195dc99.outbox (
  key text PRIMARY KEY,
  company_id text NOT NULL,
  event text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CONSTRAINT outbox_status CHECK (status IN ('pending', 'done', 'failed'))
);

CREATE INDEX outbox_due ON plugin_billing_287195dc99.outbox (status, next_attempt_at);

CREATE TABLE plugin_billing_287195dc99.inbox (
  key text PRIMARY KEY,
  company_id text NOT NULL,
  event text NOT NULL,
  result jsonb,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- Jev decisions (kit decisions.ts).
CREATE TABLE plugin_billing_287195dc99.decisions (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  purpose text NOT NULL,
  subject_kind text NOT NULL,
  subject_id text NOT NULL,
  question_key text NOT NULL,
  answer_type text NOT NULL,
  value_text text,
  value_num numeric,
  confidence numeric NOT NULL,
  probabilities jsonb,
  model text NOT NULL,
  acted boolean NOT NULL DEFAULT false,
  corrected_to text,
  corrected_by text,
  corrected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX decisions_subject ON plugin_billing_287195dc99.decisions (company_id, subject_kind, subject_id);

CREATE INDEX decisions_purpose ON plugin_billing_287195dc99.decisions (company_id, purpose, created_at);

-- One row per email Billing asked the Mailbox to send.
CREATE TABLE plugin_billing_287195dc99.deliveries (
  key text PRIMARY KEY,
  company_id text NOT NULL,
  doc_kind text NOT NULL,
  doc_id text NOT NULL,
  seq integer NOT NULL DEFAULT 1,
  recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
  subject text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  error text,
  message_id text,
  thread_id text,
  sent_at timestamptz,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deliveries_status CHECK (status IN ('queued', 'sent', 'failed'))
);

CREATE INDEX deliveries_doc ON plugin_billing_287195dc99.deliveries (company_id, doc_kind, doc_id);

-- Paperclip issues that wait on a person: POP checks and bank matches.
CREATE TABLE plugin_billing_287195dc99.decision_issues (
  issue_id text PRIMARY KEY,
  company_id text NOT NULL,
  kind text NOT NULL,
  subject_kind text NOT NULL,
  subject_id text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'open',
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX decision_issues_subject ON plugin_billing_287195dc99.decision_issues (company_id, subject_kind, subject_id);

-- Proof of payment: from an email (Mailbox) or an upload.
CREATE TABLE plugin_billing_287195dc99.pops (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  invoice_id text REFERENCES plugin_billing_287195dc99.invoices (id),
  source text NOT NULL,
  match_basis text,
  status text NOT NULL DEFAULT 'pending',
  amount_minor bigint,
  reference text,
  from_email text,
  from_name text,
  subject text,
  snippet text,
  mail_message_id text,
  mail_thread_id text,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  file_key text,
  file_name text,
  file_mime text,
  issue_id text,
  payment_id text,
  reviewed_by text,
  reviewed_at timestamptz,
  reject_reason text,
  received_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pops_source CHECK (source IN ('email', 'upload')),
  CONSTRAINT pops_status CHECK (status IN ('pending', 'confirmed', 'rejected'))
);

CREATE UNIQUE INDEX pops_mail_message ON plugin_billing_287195dc99.pops (company_id, mail_message_id) WHERE mail_message_id IS NOT NULL;

CREATE INDEX pops_invoice ON plugin_billing_287195dc99.pops (invoice_id, status);

CREATE INDEX pops_queue ON plugin_billing_287195dc99.pops (company_id, status, received_at);
