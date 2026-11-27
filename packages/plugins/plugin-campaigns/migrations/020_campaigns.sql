-- Campaigns Stage 4c (rework plan PAR-9192 revision 2): audience_members, the people on a client list. Never edit this file once it may have run: add the next number.
-- A list belongs to one client of one company and never feeds our own CRM contacts. A member is keyed by its email, or its phone when it has no email.
-- New table and indexes only: nothing the previous version reads or writes changes.

CREATE TABLE plugin_campaigns_d355219713.audience_members (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  client_kind text NOT NULL,
  client_ref text NOT NULL,
  list_name text NOT NULL,
  name text,
  email text,
  phone text,
  source text NOT NULL,
  lawful_basis text NOT NULL,
  added_by text,
  added_at timestamptz NOT NULL DEFAULT now(),
  crm_lead_id text,
  CONSTRAINT audience_members_client_kind CHECK (client_kind IN ('company', 'contact')),
  CONSTRAINT audience_members_lawful_basis CHECK (lawful_basis IN ('consent', 'contract', 'legitimate_interest', 'legal_obligation')),
  CONSTRAINT audience_members_reachable CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

CREATE UNIQUE INDEX audience_members_key ON plugin_campaigns_d355219713.audience_members (company_id, client_kind, client_ref, list_name, (coalesce(email, phone)));
CREATE INDEX audience_members_email ON plugin_campaigns_d355219713.audience_members (company_id, email) WHERE email IS NOT NULL;
CREATE INDEX audience_members_phone ON plugin_campaigns_d355219713.audience_members (company_id, phone) WHERE phone IS NOT NULL;
CREATE INDEX audience_members_lead ON plugin_campaigns_d355219713.audience_members (company_id, crm_lead_id) WHERE crm_lead_id IS NOT NULL;
