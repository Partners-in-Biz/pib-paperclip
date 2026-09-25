CREATE TABLE plugin_billing_287195dc99.credit_notes (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  invoice_id text NOT NULL REFERENCES plugin_billing_287195dc99.invoices (id),
  amount_minor bigint NOT NULL,
  reason text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'issued',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_notes_status CHECK (status IN ('issued', 'applied'))
);

CREATE INDEX credit_notes_invoice ON plugin_billing_287195dc99.credit_notes (invoice_id);
