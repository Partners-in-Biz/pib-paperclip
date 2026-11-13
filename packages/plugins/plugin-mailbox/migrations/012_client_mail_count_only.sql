-- Count-only client mail: a client website form we only count for the month-end report.
-- No Reply-needed task, no draft or send to the enquirer (PAR-11138).
ALTER TABLE plugin_mailbox_319145c88b.client_mail_maps
  ADD COLUMN count_only boolean NOT NULL DEFAULT false;

-- AHS Law handles its own website leads: mail from rs@ahslaw.co.za is count only.
-- company_id b2b8f471-... is the PiB company the plugin runs under; 71c61589-... is the AHS Law CRM company.
INSERT INTO plugin_mailbox_319145c88b.client_mail_maps
  (id, company_id, match_type, pattern, client_kind, client_ref, client_name, note, created_by, count_only)
VALUES
  ('map_ahslaw_rs_count_only', 'b2b8f471-edba-4d05-abce-f15e99a94d9a', 'sender_address', 'rs@ahslaw.co.za', 'company',
   '71c61589-63d2-4f03-ae17-6dc60ba3be80', 'AHS Law', 'Count only: AHS Law answers its own website leads (PAR-11138).', 'migration:PAR-11138', true)
ON CONFLICT (company_id, match_type, pattern) DO UPDATE SET count_only = true;

-- Index for "did this address arrive as a count-only enquirer".
CREATE INDEX IF NOT EXISTS messages_company_map_id ON plugin_mailbox_319145c88b.messages (company_id, map_id) WHERE map_id IS NOT NULL;

-- Backfill: mail already filed under a count-only mapping gets the flag and needs_reply 0,
-- so no Reply-needed task opens or reopens for it after deploy.
UPDATE plugin_mailbox_319145c88b.messages m
SET needs_reply = 0,
    triage = jsonb_set(jsonb_set(COALESCE(m.triage, '{}'::jsonb), '{countOnly}', 'true'::jsonb), '{needsReply}', '0'::jsonb)
FROM plugin_mailbox_319145c88b.client_mail_maps c
WHERE m.company_id = c.company_id AND m.map_id = c.id AND c.count_only = true;
