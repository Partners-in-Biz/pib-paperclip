-- Call note outbox for durable delivery to plugin-crm. Rollback: leave columns, old code ignores them.

ALTER TABLE plugin_crm_telephony_40e33d0807.tel_transcripts
  ADD COLUMN note_status text NOT NULL DEFAULT 'pending' CHECK (note_status IN ('pending', 'emitted', 'acked')),
  ADD COLUMN note_emitted_at timestamptz,
  ADD COLUMN note_emits int NOT NULL DEFAULT 0;

CREATE INDEX tel_transcripts_note_sweep ON plugin_crm_telephony_40e33d0807.tel_transcripts (note_status, note_emitted_at) WHERE note_status <> 'acked';
