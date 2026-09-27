-- Accounting: a board user can say the business started on these books, so there are no opening balances to bring over.
-- Posting opening balances later clears both columns again.

ALTER TABLE plugin_accounting_03d0185a67.books ADD COLUMN IF NOT EXISTS cutover_skipped_at timestamptz;

ALTER TABLE plugin_accounting_03d0185a67.books ADD COLUMN IF NOT EXISTS cutover_skipped_by jsonb;
