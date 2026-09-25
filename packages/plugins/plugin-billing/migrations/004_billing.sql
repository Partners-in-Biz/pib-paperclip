CREATE TABLE plugin_billing_287195dc99.payments (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  invoice_id text NOT NULL REFERENCES plugin_billing_287195dc99.invoices (id),
  amount_minor bigint NOT NULL,
  method text NOT NULL DEFAULT 'bank',
  reference text,
  paid_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX payments_invoice ON plugin_billing_287195dc99.payments (invoice_id);
