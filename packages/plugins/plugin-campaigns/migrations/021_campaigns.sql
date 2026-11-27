-- Campaigns Stage 3b (rework plan PAR-9192 revision 2): each campaign has a mode and remembers who paused it. Never edit this file once it may have run: add the next number.
-- autopilot_mode says what an agent may do on the campaign without a person: off, safe or full (shown as Auto). Every campaign, old and new, starts in safe.
-- paused_by is who paused it last: agent:<id>, user:<id> or auto. Empty for a campaign that was never paused by this version.
-- Two new columns with defaults: the previous version does not name them, so its inserts get safe and its updates leave them alone.
ALTER TABLE plugin_campaigns_d355219713.campaigns
  ADD COLUMN autopilot_mode text NOT NULL DEFAULT 'safe',
  ADD COLUMN paused_by text;

ALTER TABLE plugin_campaigns_d355219713.campaigns
  ADD CONSTRAINT campaigns_autopilot_mode CHECK (autopilot_mode IN ('off', 'safe', 'full'));
