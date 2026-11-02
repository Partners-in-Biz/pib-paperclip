-- Rollback: none needed. The column is additive with a default, so the previous code (which never names it) keeps inserting and reading `daily` unchanged.
-- Installs per campaign per day (app-install campaigns: Apple Ads, Google App, Meta app promotion, TikTok, LinkedIn). 0 for every row that has none.
ALTER TABLE plugin_ads_caac8387d2.daily
  ADD COLUMN installs bigint NOT NULL DEFAULT 0;
