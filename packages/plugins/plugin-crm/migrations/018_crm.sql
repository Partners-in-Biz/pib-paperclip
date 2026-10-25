-- CRM: an outside fetch pass recorded on a site's monitor row (PAR-4812). Additive, nullable columns; old code ignores them.

ALTER TABLE plugin_crm_832258244c.site_monitor ADD COLUMN IF NOT EXISTS outside_url text;

ALTER TABLE plugin_crm_832258244c.site_monitor ADD COLUMN IF NOT EXISTS outside_verdict text;

ALTER TABLE plugin_crm_832258244c.site_monitor ADD COLUMN IF NOT EXISTS outside_checked_at timestamptz;
