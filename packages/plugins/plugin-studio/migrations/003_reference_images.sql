-- Reference images for a generation (PAR-7986, slice 2a): library asset ids only, never links. The worker signs
-- short-lived links just before it sends the job.
-- Rollback: reinstall 0.1.6, then ALTER TABLE plugin_studio_e414325bb6.generations DROP COLUMN reference_asset_ids;
ALTER TABLE plugin_studio_e414325bb6.generations ADD COLUMN reference_asset_ids jsonb NOT NULL DEFAULT '[]';
