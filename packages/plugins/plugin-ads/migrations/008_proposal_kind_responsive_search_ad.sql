-- Rollback: none needed. The wider CHECK only admits one more kind, so the previous code runs on this schema unchanged.
-- Responsive search ads are a proposal kind of their own. Additive: all prior kinds stay valid.
ALTER TABLE plugin_ads_caac8387d2.proposals
  DROP CONSTRAINT proposals_kind,
  ADD CONSTRAINT proposals_kind CHECK (kind IN ('create_campaign', 'change_budget', 'pause_campaign', 'resume_campaign', 'create_ad_set', 'create_ad_creative', 'create_ad', 'creative_check', 'create_ad_group', 'add_keywords', 'create_responsive_search_ad'));
