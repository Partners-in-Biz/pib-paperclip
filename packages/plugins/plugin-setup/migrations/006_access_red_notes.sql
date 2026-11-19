-- Per-person access, stage A (PAR-12578 plan, 4.3 While on enforce).
-- access_red_notes: the last day (UTC) the hourly job wrote the activity entry for a guarded plugin that had not
-- confirmed the current rev for more than 15 minutes while its company is on enforce. One entry per day per
-- plugin and company: the job writes only when it moves noted_on forward.
-- Keep quote characters out of these comments: the host migration check strips quoted text before comments.
-- Undo: DROP TABLE plugin_setup_48494712db.access_red_notes (the old code never reads it).
CREATE TABLE plugin_setup_48494712db.access_red_notes (
  company_id text NOT NULL,
  plugin_key text NOT NULL,
  noted_on date NOT NULL,
  PRIMARY KEY (company_id, plugin_key)
);
