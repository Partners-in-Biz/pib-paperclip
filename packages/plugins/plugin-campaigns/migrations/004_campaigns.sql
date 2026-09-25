CREATE TABLE plugin_campaigns_d355219713.campaign_step_events (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  campaign_id text NOT NULL REFERENCES plugin_campaigns_d355219713.campaigns (id),
  enrollment_id text NOT NULL REFERENCES plugin_campaigns_d355219713.campaign_enrollments (id),
  step_position integer NOT NULL,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT step_events_type CHECK (event_type IN ('open', 'click'))
);

CREATE INDEX step_events_campaign ON plugin_campaigns_d355219713.campaign_step_events (campaign_id, step_position);
