-- Count-only client mail: a client's website form we only count for the month-end report.
-- No Reply-needed task, no draft or send to the enquirer (PAR-11138).
ALTER TABLE plugin_mailbox_319145c88b.client_mail_maps
  ADD COLUMN count_only boolean NOT NULL DEFAULT false;

-- AHS Law handles its own website leads: mail from rs@ahslaw.co.za is count only.
INSERT INTO plugin_mailbox_319145c88b.client_mail_maps
  (id, company_id, match_type, pattern, client_kind, client_ref, client_name, note, created_by, count_only)
VALUES
  ('map_ahslaw_rs_count_only', 'b2b8f471-edba-4d05-abce-f15e99a94d9a', 'sender_address', 'rs@ahslaw.co.za', 'company',
   '71c61589-63d2-4f03-ae17-6dc60ba3be80', 'AHS Law', 'Count only: AHS Law answers its own website leads (PAR-11138).', 'migration:PAR-11138', true)
ON CONFLICT (company_id, match_type, pattern) DO UPDATE SET count_only = true;

-- Index for "did this address arrive as a count-only enquirer".
CREATE INDEX IF NOT EXISTS messages_company_map_id ON plugin_mailbox_319145c88b.messages (company_id, map_id) WHERE map_id IS NOT NULL;
