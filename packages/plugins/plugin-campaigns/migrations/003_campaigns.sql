ALTER TABLE plugin_campaigns_d355219713.campaign_steps
  ADD COLUMN variant text NOT NULL DEFAULT 'a';

ALTER TABLE plugin_campaigns_d355219713.campaign_enrollments
  ADD COLUMN variant text NOT NULL DEFAULT 'a';
