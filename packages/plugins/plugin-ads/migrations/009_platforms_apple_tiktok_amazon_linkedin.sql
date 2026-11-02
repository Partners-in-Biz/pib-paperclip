-- Rollback: none needed. The wider CHECKs only admit four more platforms, so the previous code runs on this schema unchanged and the CHECKs stay in place.
-- Apple, TikTok, Amazon and LinkedIn become valid platforms on connections and ad accounts. Additive: meta, google and mock stay valid.
ALTER TABLE plugin_ads_caac8387d2.connections
  DROP CONSTRAINT connections_platform,
  ADD CONSTRAINT connections_platform CHECK (platform IN ('meta', 'google', 'mock', 'apple', 'tiktok', 'amazon', 'linkedin'));

ALTER TABLE plugin_ads_caac8387d2.ad_accounts
  DROP CONSTRAINT ad_accounts_platform,
  ADD CONSTRAINT ad_accounts_platform CHECK (platform IN ('meta', 'google', 'mock', 'apple', 'tiktok', 'amazon', 'linkedin'));
