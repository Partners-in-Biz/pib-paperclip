-- CRM 0.24.0: drive_files.subfolder column for Drive sub-folder routing. Additive, nothing dropped. Rollback: old code ignores the column.

ALTER TABLE plugin_crm_832258244c.drive_files ADD COLUMN IF NOT EXISTS subfolder text;
