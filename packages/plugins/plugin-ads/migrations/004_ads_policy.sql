-- Ad policy status tracking: the ads table holds status and feedback for each ad.
-- Additive: old code runs on this schema. Rollback: remove table ads.
CREATE TABLE plugin_ads_caac8387d2.ads (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  account_id text NOT NULL REFERENCES plugin_ads_caac8387d2.ad_accounts (id),
  external_id text NOT NULL,
  name text NOT NULL,
  ad_set_external_id text,
  creative_external_id text,
  raw_status text,
  policy_status text NOT NULL,
  policy_feedback text,
  policy_changed_at timestamptz NOT NULL DEFAULT now(),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ads_policy_status CHECK (policy_status IN ('PENDING_REVIEW', 'DISAPPROVED', 'ACTIVE', 'OTHER')),
  CONSTRAINT ads_unique UNIQUE (account_id, external_id)
);

CREATE INDEX ads_company_policy ON plugin_ads_caac8387d2.ads (company_id, policy_status);
