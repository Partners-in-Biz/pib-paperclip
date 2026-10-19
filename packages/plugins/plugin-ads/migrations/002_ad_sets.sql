-- Ad sets are a proposal kind of their own. Additive: the old kinds stay valid, so the previous code runs on this schema.
ALTER TABLE plugin_ads_caac8387d2.proposals
  DROP CONSTRAINT proposals_kind,
  ADD CONSTRAINT proposals_kind CHECK (kind IN ('create_campaign', 'change_budget', 'pause_campaign', 'resume_campaign', 'creative_check', 'create_ad_set'));
