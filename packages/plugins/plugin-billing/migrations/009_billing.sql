-- Billing 0.3: supplier bills (AP), expenses with receipts, time entries,
-- retainers, FX rates, reminders (dunning) and recurring schedule options.

CREATE TABLE plugin_billing_287195dc99.bills (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  supplier_kind text NOT NULL DEFAULT 'text',
  supplier_ref text,
  supplier_name text NOT NULL,
  supplier_email text,
  supplier_reference text,
  status text NOT NULL DEFAULT 'draft',
  currency text NOT NULL DEFAULT 'ZAR',
  prices_include_vat boolean NOT NULL DEFAULT false,
  default_tax_code text,
  category text NOT NULL DEFAULT 'other',
  subtotal_minor bigint NOT NULL DEFAULT 0,
  vat_minor bigint NOT NULL DEFAULT 0,
  total_minor bigint NOT NULL DEFAULT 0,
  issue_date date,
  due_date date,
  notes text,
  source text NOT NULL DEFAULT 'manual',
  mail_message_id text,
  mail_thread_id text,
  file_key text,
  file_name text,
  file_mime text,
  fx_rate numeric,
  approval_issue_id text,
  pending_action text,
  approved_at timestamptz,
  paid_at timestamptz,
  ledger_status text,
  ledger_error text,
  journal_number text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bills_status CHECK (status IN ('draft', 'approved', 'partially_paid', 'paid', 'cancelled')),
  CONSTRAINT bills_supplier_kind CHECK (supplier_kind IN ('company', 'contact', 'text'))
);

CREATE INDEX bills_company ON plugin_billing_287195dc99.bills (company_id, status, due_date);

CREATE UNIQUE INDEX bills_mail_message ON plugin_billing_287195dc99.bills (company_id, mail_message_id) WHERE mail_message_id IS NOT NULL;

CREATE TABLE plugin_billing_287195dc99.bill_lines (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  bill_id text NOT NULL REFERENCES plugin_billing_287195dc99.bills (id),
  description text NOT NULL,
  quantity integer NOT NULL DEFAULT 1,
  unit_amount_minor bigint NOT NULL,
  tax_code text,
  category text,
  net_minor bigint,
  vat_minor bigint,
  gross_minor bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX bill_lines_bill ON plugin_billing_287195dc99.bill_lines (bill_id);

CREATE TABLE plugin_billing_287195dc99.bill_payments (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  bill_id text NOT NULL REFERENCES plugin_billing_287195dc99.bills (id),
  amount_minor bigint NOT NULL,
  allocated_minor bigint NOT NULL,
  method text NOT NULL DEFAULT 'eft',
  reference text,
  paid_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'manual',
  source_key text NOT NULL,
  bank_tx_id text,
  currency text,
  fx_rate numeric,
  ledger_status text,
  journal_number text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX bill_payments_source_key ON plugin_billing_287195dc99.bill_payments (company_id, source_key);

CREATE INDEX bill_payments_bill ON plugin_billing_287195dc99.bill_payments (bill_id);

ALTER TABLE plugin_billing_287195dc99.expenses
  ADD COLUMN IF NOT EXISTS vendor text,
  ADD COLUMN IF NOT EXISTS supplier_kind text,
  ADD COLUMN IF NOT EXISTS supplier_ref text,
  ADD COLUMN IF NOT EXISTS tax_code text,
  ADD COLUMN IF NOT EXISTS vat_minor bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vat_claimable boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS paid_from text NOT NULL DEFAULT 'bank',
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'recorded',
  ADD COLUMN IF NOT EXISTS receipt_key text,
  ADD COLUMN IF NOT EXISTS receipt_name text,
  ADD COLUMN IF NOT EXISTS receipt_mime text,
  ADD COLUMN IF NOT EXISTS extraction jsonb,
  ADD COLUMN IF NOT EXISTS needs_review boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS billable boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS customer_kind text,
  ADD COLUMN IF NOT EXISTS customer_ref text,
  ADD COLUMN IF NOT EXISTS invoice_id text,
  ADD COLUMN IF NOT EXISTS fx_rate numeric,
  ADD COLUMN IF NOT EXISTS ledger_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ledger_status text,
  ADD COLUMN IF NOT EXISTS journal_number text,
  ADD COLUMN IF NOT EXISTS created_by text;

CREATE TABLE plugin_billing_287195dc99.time_entries (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  owner text NOT NULL,
  description text NOT NULL,
  customer_kind text,
  customer_ref text,
  customer_name text,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  minutes integer NOT NULL DEFAULT 0,
  rate_minor bigint NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'ZAR',
  billable boolean NOT NULL DEFAULT true,
  invoice_id text,
  bill_token text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX time_entries_company ON plugin_billing_287195dc99.time_entries (company_id, started_at);

CREATE UNIQUE INDEX time_entries_running ON plugin_billing_287195dc99.time_entries (company_id, owner) WHERE ended_at IS NULL;

CREATE TABLE plugin_billing_287195dc99.retainer_plans (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  name text NOT NULL,
  description text,
  price_minor bigint NOT NULL,
  currency text NOT NULL DEFAULT 'ZAR',
  period text NOT NULL DEFAULT 'monthly',
  tax_code text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT retainer_plans_interval CHECK (period IN ('monthly', 'quarterly', 'yearly'))
);

CREATE TABLE plugin_billing_287195dc99.subscriptions (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  plan_id text REFERENCES plugin_billing_287195dc99.retainer_plans (id),
  customer_kind text NOT NULL,
  customer_ref text NOT NULL,
  customer_name text,
  description text NOT NULL,
  price_minor bigint NOT NULL,
  currency text NOT NULL DEFAULT 'ZAR',
  period text NOT NULL DEFAULT 'monthly',
  tax_code text,
  status text NOT NULL DEFAULT 'active',
  auto_send boolean NOT NULL DEFAULT false,
  started_at timestamptz NOT NULL DEFAULT now(),
  next_invoice_at timestamptz NOT NULL,
  cancelled_at timestamptz,
  last_invoice_id text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_status CHECK (status IN ('active', 'paused', 'cancelled')),
  CONSTRAINT subscriptions_interval CHECK (period IN ('monthly', 'quarterly', 'yearly'))
);

CREATE INDEX subscriptions_due ON plugin_billing_287195dc99.subscriptions (next_invoice_at) WHERE status = 'active';

CREATE INDEX subscriptions_company ON plugin_billing_287195dc99.subscriptions (company_id, status);

ALTER TABLE plugin_billing_287195dc99.recurring_invoices
  ADD COLUMN IF NOT EXISTS auto_send boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_invoice_id text;

-- Daily FX rates: rates[X] = units of X per 1 unit of base.
CREATE TABLE plugin_billing_287195dc99.fx_rates (
  day date NOT NULL,
  base text NOT NULL,
  rates jsonb NOT NULL,
  source text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, base)
);

-- Payment reminders: one per stage per invoice.
CREATE TABLE plugin_billing_287195dc99.reminders (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  invoice_id text NOT NULL REFERENCES plugin_billing_287195dc99.invoices (id),
  stage integer NOT NULL,
  days_overdue integer NOT NULL,
  delivery_key text,
  status text NOT NULL DEFAULT 'queued',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reminders_status CHECK (status IN ('queued', 'sent', 'failed', 'skipped'))
);

CREATE UNIQUE INDEX reminders_stage ON plugin_billing_287195dc99.reminders (invoice_id, stage);

CREATE TABLE plugin_billing_287195dc99.dunning_optouts (
  company_id text NOT NULL,
  customer_kind text NOT NULL,
  customer_ref text NOT NULL,
  reason text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, customer_kind, customer_ref)
);
