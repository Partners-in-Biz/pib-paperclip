-- 0.9.20 (PAR-12249): crm_companies.billing (the billing email of a client is one way a recipient is shown to be a customer) and
-- the lookups of plugin drafts by request key and of open drafts by purpose key.
-- Backfill: this adds the column only. Existing rows hold no billing until the CRM sends its companies again: the nightly CRM
-- full share does it within a day; run the CRM action "Send clients to the other plugins" (crm.resync) right after the deploy to
-- do it at once. Until then the billing-email rule matches nothing (the contact and domain rules still hold).
-- Not CONCURRENTLY: the host runs the migrations of a plugin inside one transaction. Both indexes are partial (outbound drafts).
-- Rollback: revert the plugin, then optionally DROP INDEX messages_draft_request_key, messages_draft_purpose_key and the column.
ALTER TABLE plugin_mailbox_319145c88b.crm_companies ADD COLUMN IF NOT EXISTS billing jsonb;
CREATE INDEX IF NOT EXISTS messages_draft_request_key ON plugin_mailbox_319145c88b.messages (company_id, (draft ->> 'requestKey')) WHERE direction = 'outbound' AND draft IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_draft_purpose_key ON plugin_mailbox_319145c88b.messages (company_id, account_id, (draft ->> 'purposeKey')) WHERE direction = 'outbound' AND status = 'draft';
