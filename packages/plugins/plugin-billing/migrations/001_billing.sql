CREATE TABLE plugin_billing_287195dc99.invoices (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  number text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  currency text NOT NULL,
  customer_kind text NOT NULL,
  customer_ref text NOT NULL,
  sender jsonb NOT NULL DEFAULT '{}'::jsonb,
  customer jsonb NOT NULL DEFAULT '{}'::jsonb,
  sender_snapshot jsonb,
  customer_snapshot jsonb,
  total_minor bigint NOT NULL DEFAULT 0,
  due_at timestamptz,
  approval_issue_id text,
  pending_action text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoices_status CHECK (status IN ('draft', 'sent', 'viewed', 'paid', 'overdue', 'cancelled')),
  CONSTRAINT invoices_customer_kind CHECK (customer_kind IN ('company', 'contact')),
  CONSTRAINT invoices_pending CHECK (pending_action IS NULL OR pending_action IN ('send', 'pay'))
);

CREATE INDEX invoices_workspace ON plugin_billing_287195dc99.invoices (company_id);

CREATE TABLE plugin_billing_287195dc99.invoice_lines (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  invoice_id text NOT NULL REFERENCES plugin_billing_287195dc99.invoices (id),
  description text NOT NULL,
  quantity integer NOT NULL,
  unit_amount_minor bigint NOT NULL
);

CREATE TABLE plugin_billing_287195dc99.invoice_grants (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  invoice_id text NOT NULL REFERENCES plugin_billing_287195dc99.invoices (id),
  grantee_company_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX invoice_grants_pair ON plugin_billing_287195dc99.invoice_grants (invoice_id, grantee_company_id);
