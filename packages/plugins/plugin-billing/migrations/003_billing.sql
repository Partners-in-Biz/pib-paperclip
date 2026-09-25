CREATE TABLE plugin_billing_287195dc99.recurring_invoices (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  template_invoice_id text NOT NULL REFERENCES plugin_billing_287195dc99.invoices (id),
  frequency text NOT NULL,
  next_run_at timestamptz NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recurring_frequency CHECK (frequency IN ('monthly', 'quarterly', 'yearly'))
);

CREATE INDEX recurring_due ON plugin_billing_287195dc99.recurring_invoices (next_run_at) WHERE is_active = true;
