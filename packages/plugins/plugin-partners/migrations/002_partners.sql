ALTER TABLE plugin_partners_f5013a90fc.grants
  DROP CONSTRAINT grants_status,
  ADD CONSTRAINT grants_status CHECK (status IN ('proposed', 'active', 'revoked'));
