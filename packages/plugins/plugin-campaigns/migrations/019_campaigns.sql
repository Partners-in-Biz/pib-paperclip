-- Campaigns Stage 4b (rework plan PAR-9192 revision 2): audience_mode may also be client_list, a list of the people the client owns. Never edit this file once it may have run: add the next number.
-- The check gains a fourth value and keeps the three it had, so every row and every insert of the previous version still passes. No code writes client_list yet.
ALTER TABLE plugin_campaigns_d355219713.campaigns
  DROP CONSTRAINT campaigns_audience_mode;

ALTER TABLE plugin_campaigns_d355219713.campaigns
  ADD CONSTRAINT campaigns_audience_mode CHECK (audience_mode IN ('tags', 'client_contacts', 'client_contact', 'client_list'));
