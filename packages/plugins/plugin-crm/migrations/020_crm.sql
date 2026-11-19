-- CRM: a page-scoped write grant on the sign-off lock (PAR-9131 T2a). Additive, nullable columns; old code ignores them.
-- pages is a JSON array of normalised page URLs, replaced as a whole by each scope pages event; pages_seq orders those
-- events so a late one is ignored. The whole-site grant (approved_until, approved_by) is unchanged.
-- Rollback: none needed. Old code never reads these columns, so a page grant simply stops passing (the safe direction).

ALTER TABLE plugin_crm_832258244c.site_signoff ADD COLUMN IF NOT EXISTS pages jsonb;

ALTER TABLE plugin_crm_832258244c.site_signoff ADD COLUMN IF NOT EXISTS pages_until timestamptz;

ALTER TABLE plugin_crm_832258244c.site_signoff ADD COLUMN IF NOT EXISTS pages_seq bigint NOT NULL DEFAULT 0;

ALTER TABLE plugin_crm_832258244c.site_signoff ADD COLUMN IF NOT EXISTS pages_by text;

ALTER TABLE plugin_crm_832258244c.site_signoff ADD COLUMN IF NOT EXISTS pages_opened_at timestamptz;
