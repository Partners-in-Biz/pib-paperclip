-- Variant tracking: store variant labels and compute winner and fatigue flags.
-- Ad-level daily insights for winner/fatigue computation: spend, impressions, clicks, conversions, frequency.
-- Additive: old code runs on this schema. Forward-only host: down code runs on newer schema.
CREATE TABLE plugin_ads_caac8387d2.ad_daily (
  company_id text NOT NULL,
  account_id text NOT NULL REFERENCES plugin_ads_caac8387d2.ad_accounts (id),
  campaign_external_id text NOT NULL,
  ad_external_id text NOT NULL,
  day date NOT NULL,
  spend_minor bigint NOT NULL DEFAULT 0,
  impressions bigint NOT NULL DEFAULT 0,
  clicks bigint NOT NULL DEFAULT 0,
  conversions numeric(14, 2) NOT NULL DEFAULT 0,
  frequency numeric(8, 3) NOT NULL DEFAULT 0,
  currency text NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, ad_external_id, day)
);

CREATE INDEX ad_daily_campaign ON plugin_ads_caac8387d2.ad_daily (account_id, campaign_external_id);

CREATE TABLE plugin_ads_caac8387d2.variants (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  account_id text NOT NULL REFERENCES plugin_ads_caac8387d2.ad_accounts (id),
  campaign_external_id text NOT NULL,
  ad_external_id text NOT NULL,
  label text NOT NULL,
  axis_values jsonb NOT NULL DEFAULT '{}',
  creative_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT variants_unique UNIQUE (account_id, ad_external_id, label)
);

CREATE INDEX variants_campaign ON plugin_ads_caac8387d2.variants (account_id, campaign_external_id);
