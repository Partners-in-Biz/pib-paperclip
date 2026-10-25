-- Additive migration: allow improvements.kind = 'template' (PAR-4025, PAR-3884)
-- No down path; template is a new kind of improvement that agents can propose.

ALTER TABLE plugin_cockpit_b8a99e8b16.improvements DROP CONSTRAINT IF EXISTS improvements_kind;
ALTER TABLE plugin_cockpit_b8a99e8b16.improvements ADD CONSTRAINT improvements_kind CHECK (kind IN ('skill', 'instruction', 'routine', 'plugin', 'agent', 'system', 'template'));
