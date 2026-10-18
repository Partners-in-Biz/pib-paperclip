-- Creatives and ads are proposal kinds. Additive: old code runs on this schema. Rollback: restore the 002 constraint.
ALTER TABLE plugin_ads_caac8387d2.proposals
  DROP CONSTRAINT proposals_kind,
  ADD CONSTRAINT proposals_kind CHECK (kind IN ('create_campaign', 'change_budget', 'pause_campaign', 'resume_campaign', 'creative_check', 'create_ad_set', 'create_ad_creative', 'create_ad'));
