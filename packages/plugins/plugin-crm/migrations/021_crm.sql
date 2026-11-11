-- CRM: the site.changed event and its replay (PAR-9131 T2b). Additive, nullable columns; old code ignores them.
-- site_changes.page_url is the normalised page of an agent write that an open page grant allowed; only those rows are
-- replayed. site_signoff.pages_closed_at is when the page grant last closed, so the replay runs one more hour.
-- Rollback: none needed. Old code never reads these columns, and the replay simply stops.

ALTER TABLE plugin_crm_832258244c.site_changes ADD COLUMN IF NOT EXISTS page_url text;

ALTER TABLE plugin_crm_832258244c.site_signoff ADD COLUMN IF NOT EXISTS pages_closed_at timestamptz;
