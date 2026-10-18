-- Owner delegate (Elon) threshold for scope-level approval routing.
-- Rollback note: old code keeps working on this schema. It only inserts user: rows so the relaxed approvals_person_or_delegate constraint is fine.
-- Elon-only: approvesAds will add agentId field support, recordSignoff validates only Elon can call it with agentId.

ALTER TABLE plugin_ads_caac8387d2.scopes ADD COLUMN owner_threshold_minor bigint;

ALTER TABLE plugin_ads_caac8387d2.scopes ADD CONSTRAINT scopes_owner_threshold_check CHECK (owner_threshold_minor IS NULL OR owner_threshold_minor >= 0);

ALTER TABLE plugin_ads_caac8387d2.approvals DROP CONSTRAINT approvals_person;

ALTER TABLE plugin_ads_caac8387d2.approvals ADD CONSTRAINT approvals_person_or_delegate CHECK (decided_by LIKE 'user:%' OR (role = 'owner' AND decision = 'approved' AND decided_by LIKE 'agent:%'));
