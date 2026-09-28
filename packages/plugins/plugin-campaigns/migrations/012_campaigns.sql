-- Campaigns 0.5.0: when a draft last changed (a refused campaign must change before it is asked
-- again), and what agents did about replies (answered, or no answer needed) for the done checks.

ALTER TABLE plugin_campaigns_d355219713.campaigns
  ADD COLUMN edited_at timestamptz;

CREATE TABLE plugin_campaigns_d355219713.reply_log (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  message_id text NOT NULL,
  campaign_id text,
  enrollment_id text,
  outcome text NOT NULL,
  note text NOT NULL DEFAULT '',
  mail_draft_id text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reply_log_outcome CHECK (outcome IN ('answered', 'no-reply-needed'))
);

CREATE INDEX reply_log_message ON plugin_campaigns_d355219713.reply_log (company_id, message_id);
