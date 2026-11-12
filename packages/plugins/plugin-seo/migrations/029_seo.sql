-- Client email-link answer grant (0.47.1, PAR-10129): the preview service (role pib_preview, ops/preview-server) writes the client's
-- Approve / Request changes answer with DECISION_SQL. Without UPDATE on exactly those columns every answer fails with a 500 ("Something
-- went wrong") and the client never reaches the apply window. The grant used to be a manual root step (ops/preview-server/README.md);
-- it is now part of the migration, so it cannot be forgotten. Idempotent, and a no-op where the role does not exist (dev, CI).
-- A non-owner migration user that may not grant logs a notice instead of failing the plugin upgrade; the README step then applies.
-- Rollback: none needed (REVOKE UPDATE (...) ON plugin_seo_8099f8879a.previews FROM pib_preview would break client answers).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pib_preview') THEN
    GRANT USAGE ON SCHEMA plugin_seo_8099f8879a TO pib_preview;
    GRANT SELECT ON plugin_seo_8099f8879a.previews TO pib_preview;
    GRANT UPDATE (status, decision_note, decided_at, notified_at, decision_source, decided_by, stats) ON plugin_seo_8099f8879a.previews TO pib_preview;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'pib_preview grant skipped: run it as the database owner (ops/preview-server/README.md)';
END
$$;
