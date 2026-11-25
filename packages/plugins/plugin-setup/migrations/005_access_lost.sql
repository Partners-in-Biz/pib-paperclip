-- Per-person access, stage A (PAR-12578 plan, 4.2 When numbers disagree).
-- access_lost: a guarded plugin reported a stored rev above 0 for a company where Setup has no access_settings row
-- (Setup restored from an older backup). Setup does not invent a mode: the People screen shows switch lost, choose
-- again, while the company has no settings row. rev is the highest rev reported, so the next save starts above it.
-- noted_at is set once the one activity entry is written.
-- Keep quote characters out of these comments: the host migration check strips quoted text before comments.
-- Undo: DROP TABLE plugin_setup_48494712db.access_lost (the old code never reads it).
CREATE TABLE plugin_setup_48494712db.access_lost (
  company_id text PRIMARY KEY,
  rev integer NOT NULL CHECK (rev > 0),
  first_plugin_key text NOT NULL,
  reported_at timestamptz NOT NULL DEFAULT now(),
  noted_at timestamptz
);
