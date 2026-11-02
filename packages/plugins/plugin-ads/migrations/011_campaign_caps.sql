-- Rollback: none needed. A new table nothing else reads or references: the previous code ignores it, and dropping it is safe once no newer code runs.
-- The hard cap of one campaign, in minor units of the account currency. One row per campaign. created_at is when the spend window starts. No enforcement reads it yet.
CREATE TABLE plugin_ads_caac8387d2.campaign_caps (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  platform text NOT NULL,
  external_campaign_id text NOT NULL,
  cap_minor bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  set_by text NOT NULL,
  proposal_id text,
  CONSTRAINT campaign_caps_platform CHECK (platform IN ('meta', 'google', 'mock', 'apple', 'tiktok', 'amazon', 'linkedin')),
  CONSTRAINT campaign_caps_positive CHECK (cap_minor > 0),
  CONSTRAINT campaign_caps_set_by CHECK (set_by LIKE 'user:%')
);

CREATE UNIQUE INDEX campaign_caps_campaign ON plugin_ads_caac8387d2.campaign_caps (company_id, platform, external_campaign_id);
