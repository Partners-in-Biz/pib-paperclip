-- CRM: newsletter intake for lead sources (PAR-10850, plan PAR-10817 stage 1). Additive columns with defaults; every existing source keeps its intake and works as before.
-- intake newsletter: a signup is confirmed by mail (double opt-in) before the contact, its tags and the consent record are written. The signup path ships in a later stage; until then the webhook refuses such a source.
-- apply_tags: the tags a confirmed subscriber receives. confirm_url: the https page the confirmation link opens. confirm_from: the address the confirmation mail is sent from.
-- confirm_secret: the key that signs confirmation links. The plugin makes it and no tool, view, export or log returns it. confirm_daily_cap: the most confirmation mails the source sends in 24 hours.
-- Rollback: revert the code. The columns and both CHECKs can stay: old code names its columns and never writes a newsletter source.

ALTER TABLE plugin_crm_832258244c.lead_sources DROP CONSTRAINT IF EXISTS lead_sources_intake;

ALTER TABLE plugin_crm_832258244c.lead_sources ADD CONSTRAINT lead_sources_intake CHECK (intake IN ('lead', 'issue', 'newsletter'));

ALTER TABLE plugin_crm_832258244c.lead_sources ADD COLUMN IF NOT EXISTS apply_tags jsonb NOT NULL DEFAULT '[]';

ALTER TABLE plugin_crm_832258244c.lead_sources ADD COLUMN IF NOT EXISTS confirm_url text;

ALTER TABLE plugin_crm_832258244c.lead_sources ADD COLUMN IF NOT EXISTS confirm_from text;

ALTER TABLE plugin_crm_832258244c.lead_sources ADD COLUMN IF NOT EXISTS confirm_secret text;

ALTER TABLE plugin_crm_832258244c.lead_sources ADD COLUMN IF NOT EXISTS confirm_daily_cap integer NOT NULL DEFAULT 300;

-- A newsletter source has tags to give and everything a confirmation needs; any other source has none of the newsletter settings.
ALTER TABLE plugin_crm_832258244c.lead_sources ADD CONSTRAINT lead_sources_newsletter CHECK (
  CASE WHEN intake = 'newsletter'
    THEN jsonb_typeof(apply_tags) = 'array' AND apply_tags <> '[]'::jsonb
      AND confirm_url IS NOT NULL AND confirm_from IS NOT NULL AND confirm_secret IS NOT NULL
      AND signing_secret IS NOT NULL AND consent_text IS NOT NULL
    ELSE apply_tags = '[]'::jsonb AND confirm_url IS NULL AND confirm_from IS NULL AND confirm_secret IS NULL
  END
);
