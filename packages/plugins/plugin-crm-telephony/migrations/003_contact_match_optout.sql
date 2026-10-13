-- Telephony 0.3.0: CRM contact matching and opt-out tracking. Rollback: leave the tables and the column; 0.2.x code ignores them (the column has a default).

-- CRM projection: contacts cache (companies not needed for telephony).
CREATE TABLE plugin_crm_telephony_40e33d0807.crm_contacts (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  name text NOT NULL,
  emails text[] NOT NULL DEFAULT '{}',
  phones text[] NOT NULL DEFAULT '{}',
  lifecycle text,
  tags text[] NOT NULL DEFAULT '{}',
  account_ids text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL,
  deleted boolean NOT NULL DEFAULT false
);

CREATE INDEX crm_contacts_company ON plugin_crm_telephony_40e33d0807.crm_contacts (company_id, name);

-- Messages: mark ambiguous matches (multiple contacts matched).
ALTER TABLE plugin_crm_telephony_40e33d0807.tel_messages
  ADD COLUMN ambiguous boolean NOT NULL DEFAULT false;

-- Number opt-outs per channel (SMS, WhatsApp).
CREATE TABLE plugin_crm_telephony_40e33d0807.tel_number_optouts (
  company_id text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('sms', 'whatsapp')),
  e164 text NOT NULL,
  opt_out_at timestamptz NOT NULL DEFAULT now(),
  source_msg_id text,
  PRIMARY KEY (company_id, channel, e164)
);

CREATE INDEX tel_number_optouts_company ON plugin_crm_telephony_40e33d0807.tel_number_optouts (company_id, channel);
