-- Campaigns Stage 1 (rework plan PAR-9192 revision 2): the client yes and the approved audience.
-- client_yes_ref, client_yes_by and client_yes_at record where and by whom the client said yes to this copy; an edit that cancels the approval clears them.
-- approval_audience_count and approval_audience_hash record who would be enrolled when approval was asked for (a hash of the sorted contact ids).
-- Nullable columns only: the previous version names its own columns in every insert and update, so it keeps working. Never edit this file once it may have run.

ALTER TABLE plugin_campaigns_d355219713.campaigns
  ADD COLUMN client_yes_ref text,
  ADD COLUMN client_yes_by text,
  ADD COLUMN client_yes_at timestamptz,
  ADD COLUMN approval_audience_count integer,
  ADD COLUMN approval_audience_hash text;
