-- Billing 0.19.0 (#460): a draft invoice may have no number until it is approved, and the send approval records who it asked and what was sent.
-- Additive: the previous code always writes a number and ignores the three new columns. Rollback: the previous release runs on this schema unchanged.
-- To undo by hand (only while no row has a null number): ALTER TABLE ... ALTER COLUMN number SET NOT NULL; and drop the three columns.
ALTER TABLE plugin_billing_287195dc99.invoices ALTER COLUMN number DROP NOT NULL;
ALTER TABLE plugin_billing_287195dc99.invoices ADD COLUMN IF NOT EXISTS approval_recipients jsonb;
ALTER TABLE plugin_billing_287195dc99.invoices ADD COLUMN IF NOT EXISTS sent_to jsonb;
ALTER TABLE plugin_billing_287195dc99.invoices ADD COLUMN IF NOT EXISTS sent_message_id text;
