CREATE TABLE plugin_billing_287195dc99.quotes (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  number text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  currency text NOT NULL,
  customer_kind text NOT NULL,
  customer_ref text NOT NULL,
  sender jsonb NOT NULL DEFAULT '{}'::jsonb,
  customer jsonb NOT NULL DEFAULT '{}'::jsonb,
  total_minor bigint NOT NULL DEFAULT 0,
  valid_until timestamptz,
  converted_invoice_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quotes_status CHECK (status IN ('draft', 'sent', 'accepted', 'declined', 'converted', 'expired')),
  CONSTRAINT quotes_customer_kind CHECK (customer_kind IN ('company', 'contact'))
);

CREATE INDEX quotes_workspace ON plugin_billing_287195dc99.quotes (company_id);

CREATE TABLE plugin_billing_287195dc99.quote_lines (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  quote_id text NOT NULL REFERENCES plugin_billing_287195dc99.quotes (id),
  description text NOT NULL,
  quantity integer NOT NULL,
  unit_amount_minor bigint NOT NULL
);

CREATE TABLE plugin_billing_287195dc99.expenses (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  description text NOT NULL,
  amount_minor bigint NOT NULL,
  currency text NOT NULL DEFAULT 'ZAR',
  category text NOT NULL DEFAULT 'other',
  incurred_on timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX expenses_workspace ON plugin_billing_287195dc99.expenses (company_id);
