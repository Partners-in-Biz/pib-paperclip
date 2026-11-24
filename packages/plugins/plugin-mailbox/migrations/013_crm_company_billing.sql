ALTER TABLE plugin_mailbox_319145c88b.crm_companies ADD COLUMN IF NOT EXISTS billing jsonb;
CREATE INDEX IF NOT EXISTS messages_draft_request_key ON plugin_mailbox_319145c88b.messages (company_id, (draft ->> 'requestKey')) WHERE direction = 'outbound' AND draft IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_draft_purpose_key ON plugin_mailbox_319145c88b.messages (company_id, account_id, (draft ->> 'purposeKey')) WHERE direction = 'outbound' AND status = 'draft';
