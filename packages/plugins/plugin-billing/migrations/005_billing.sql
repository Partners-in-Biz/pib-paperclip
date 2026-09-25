ALTER TABLE plugin_billing_287195dc99.invoices
  ADD COLUMN tax_rate numeric(5,2) NOT NULL DEFAULT 0;

ALTER TABLE plugin_billing_287195dc99.quotes
  ADD COLUMN tax_rate numeric(5,2) NOT NULL DEFAULT 0;
