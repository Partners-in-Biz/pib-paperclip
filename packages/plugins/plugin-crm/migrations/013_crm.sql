-- A company carries its billing details: where an invoice goes and what prints in its Bill to block.
-- Additive only: five nullable columns, so the previous release keeps running on this schema.
ALTER TABLE plugin_crm_832258244c.companies
  ADD COLUMN IF NOT EXISTS billing_email text,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS address text,
  ADD COLUMN IF NOT EXISTS vat_number text,
  ADD COLUMN IF NOT EXISTS registration_number text;
