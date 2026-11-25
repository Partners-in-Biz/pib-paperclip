-- CRM: an hourly cap on the confirmation mails of a newsletter source (PAR-11288). confirm_hourly_cap: the most confirmation mails
-- the source sends in one hour, 1 to 300; null (every existing source) means no hourly cap, only the daily one. Newsletter sources only.
-- Rollback: revert the code. The column and the CHECK can stay: old code never names the column, and its inserts leave it null, which the CHECK allows.

ALTER TABLE plugin_crm_832258244c.lead_sources ADD COLUMN IF NOT EXISTS confirm_hourly_cap integer;

ALTER TABLE plugin_crm_832258244c.lead_sources DROP CONSTRAINT IF EXISTS lead_sources_newsletter;

-- As in 023, plus: a newsletter source has no hourly cap or one from 1 to 300; any other source has none.
ALTER TABLE plugin_crm_832258244c.lead_sources ADD CONSTRAINT lead_sources_newsletter CHECK (
  CASE WHEN intake = 'newsletter'
    THEN jsonb_typeof(apply_tags) = 'array' AND apply_tags <> '[]'::jsonb
      AND confirm_url IS NOT NULL AND confirm_from IS NOT NULL AND confirm_secret IS NOT NULL
      AND consent_text IS NOT NULL
      AND (confirm_hourly_cap IS NULL OR confirm_hourly_cap BETWEEN 1 AND 300)
    ELSE apply_tags = '[]'::jsonb AND confirm_url IS NULL AND confirm_from IS NULL AND confirm_secret IS NULL
      AND confirm_hourly_cap IS NULL
  END
);
