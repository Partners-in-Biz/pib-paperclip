-- Campaigns 0.7.0: what the email provider reports after it took a campaign email (the Mailbox announces it as mail.delivery), and finding the
-- campaign a reply belongs to by the address it was sent to. Never edit this file once it may have run: add the next number.

-- Step events: a complaint (the recipient marked the mail as spam) and a soft bounce (the address may work next time) are kinds of their own, apart
-- from a hard bounce. Delivered, open, click and failed are already allowed.
ALTER TABLE plugin_campaigns_d355219713.campaign_step_events
  DROP CONSTRAINT step_events_type;

ALTER TABLE plugin_campaigns_d355219713.campaign_step_events
  ADD CONSTRAINT step_events_type CHECK (event_type IN ('open', 'click', 'sent', 'reply', 'bounce', 'unsubscribe', 'skipped', 'delivered', 'failed', 'soft_bounce', 'complaint'));

-- A reply to a provider send is matched to its campaign step by the address the email went to (a send event keeps it in its meta), so that lookup is
-- indexed. Only the sent events are in it.
CREATE INDEX step_events_sent_to ON plugin_campaigns_d355219713.campaign_step_events (company_id, (lower(meta ->> 'to')), occurred_at DESC) WHERE event_type = 'sent';
