-- Add company_id and dead_issue_id tracking to tel_recordings for recording intake queue.

ALTER TABLE plugin_crm_telephony_40e33d0807.tel_recordings ADD COLUMN company_id uuid;
ALTER TABLE plugin_crm_telephony_40e33d0807.tel_recordings ADD COLUMN dead_issue_id uuid;

CREATE INDEX IF NOT EXISTS tel_recordings_dead_no_issue ON plugin_crm_telephony_40e33d0807.tel_recordings (updated_at) WHERE state = 'dead' AND dead_issue_id IS NULL;
