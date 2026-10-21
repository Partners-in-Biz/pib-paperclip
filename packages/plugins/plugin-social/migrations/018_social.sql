-- Social 0.9.11: Growth Lab programs get a scope_key and project_id, the autopilot CHECK accepts 'reviewed', and scope_key is backfilled
-- from client_kind/client_ref (kit experimentsScopeAlterMigration). Additive: old inserts that omit scope_key still pass.
-- Never edit this file once it may have run: add the next number.

ALTER TABLE plugin_social_e70c4e79f2.growth_programs
  ADD COLUMN IF NOT EXISTS scope_key text,
  ADD COLUMN IF NOT EXISTS project_id text;

ALTER TABLE plugin_social_e70c4e79f2.growth_programs
  DROP CONSTRAINT IF EXISTS growth_programs_autopilot;

ALTER TABLE plugin_social_e70c4e79f2.growth_programs
  ADD CONSTRAINT growth_programs_autopilot CHECK (autopilot IN ('off', 'safe', 'reviewed', 'full'));

UPDATE plugin_social_e70c4e79f2.growth_programs
  SET scope_key = CASE
    WHEN client_kind IS NULL AND client_ref IS NULL THEN 'own'
    ELSE 'client:' || coalesce(client_kind, 'company') || ':' || coalesce(client_ref, '')
  END
  WHERE scope_key IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS growth_programs_scope_key ON plugin_social_e70c4e79f2.growth_programs (company_id, channel, scope_key) WHERE scope_key IS NOT NULL;
