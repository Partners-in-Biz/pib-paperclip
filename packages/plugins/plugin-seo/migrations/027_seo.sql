-- Page-scoped apply windows (0.40.0, PAR-9131 T3, PAR-9144): the last window this plugin sent to the CRM for each site.
-- The 5-minute job picks its sites from here, so a window whose last page was undone (the preview row is pending again and
-- no longer names the site) still gets its close. is_open is true when the last set sent was not empty. closed_at is when the
-- window last went from open to closed. seq is the seq of that event; a slower, older sync never overwrites a newer one.
-- Rollback: DROP TABLE plugin_seo_8099f8879a.apply_windows; the old code never reads it.
CREATE TABLE plugin_seo_8099f8879a.apply_windows (
  company_id text NOT NULL,
  site_id text NOT NULL,
  is_open boolean NOT NULL,
  until timestamptz,
  seq bigint NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  PRIMARY KEY (company_id, site_id)
);
