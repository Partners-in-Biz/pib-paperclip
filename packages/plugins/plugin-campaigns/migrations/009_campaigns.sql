ALTER TABLE plugin_campaigns_d355219713.campaigns
  ADD COLUMN client_kind text,
  ADD COLUMN client_ref text,
  ADD COLUMN client_name text,
  ADD COLUMN audience_mode text NOT NULL DEFAULT 'tags';

ALTER TABLE plugin_campaigns_d355219713.campaigns
  ADD CONSTRAINT campaigns_client_kind CHECK (client_kind IS NULL OR client_kind IN ('company', 'contact'));

ALTER TABLE plugin_campaigns_d355219713.campaigns
  ADD CONSTRAINT campaigns_audience_mode CHECK (audience_mode IN ('tags', 'client_contacts', 'client_contact'));

CREATE INDEX campaigns_client ON plugin_campaigns_d355219713.campaigns (company_id, client_ref, client_kind);
