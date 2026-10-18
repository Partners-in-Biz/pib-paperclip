-- Owner delegate (Elon) threshold for scope-level approval routing.
-- Rollback note: old code keeps working on this schema. It only inserts user: rows so the relaxed approvals_person_or_delegate constraint is fine.
-- Agent-signed approvals (decided_by = agent:...) are restricted to owner role with approved decision, used for Elon delegated sign-off within threshold.

ALTER TABLE plugin_ads_caac8387d2.scopes ADD COLUMN owner_threshold_minor bigint;

ALTER TABLE plugin_ads_caac8387d2.scopes ADD CONSTRAINT scopes_owner_threshold_check CHECK (owner_threshold_minor IS NULL OR owner_threshold_minor >= 0);

ALTER TABLE plugin_ads_caac8387d2.approvals DROP CONSTRAINT approvals_person;

ALTER TABLE plugin_ads_caac8387d2.approvals ADD CONSTRAINT approvals_person_or_delegate CHECK (decided_by LIKE 'user:%' OR (role = 'owner' AND decision = 'approved' AND decided_by LIKE 'agent:%'));
