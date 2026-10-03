-- Campaigns 0.6.0: send as the client, one unsubscribe list per sender, and SMS and WhatsApp steps.

-- Delivery: auto sends every step on its own channel (email through the Mailbox, SMS and WhatsApp through the provider).
ALTER TABLE plugin_campaigns_d355219713.campaigns
  DROP CONSTRAINT campaigns_delivery;

ALTER TABLE plugin_campaigns_d355219713.campaigns
  ADD CONSTRAINT campaigns_delivery CHECK (delivery IN ('issue', 'email', 'auto'));

-- Steps: the channel, and for a WhatsApp first message the approved template and its variables.
ALTER TABLE plugin_campaigns_d355219713.campaign_steps
  ADD COLUMN channel text NOT NULL DEFAULT 'email',
  ADD COLUMN template_ref text,
  ADD COLUMN template_vars jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE plugin_campaigns_d355219713.campaign_steps
  ADD CONSTRAINT campaign_steps_channel CHECK (channel IN ('email', 'sms', 'whatsapp'));

-- Step events: a step that was skipped, and delivery receipts.
ALTER TABLE plugin_campaigns_d355219713.campaign_step_events
  DROP CONSTRAINT step_events_type;

ALTER TABLE plugin_campaigns_d355219713.campaign_step_events
  ADD CONSTRAINT step_events_type CHECK (event_type IN ('open', 'click', 'sent', 'reply', 'bounce', 'unsubscribe', 'skipped', 'delivered', 'failed'));

-- Suppressions: whose list an opt-out is on. An empty sender key is a row from before 0.6 and stays on every list.
ALTER TABLE plugin_campaigns_d355219713.suppressions
  ADD COLUMN sender_key text NOT NULL DEFAULT '';

ALTER TABLE plugin_campaigns_d355219713.suppressions
  DROP CONSTRAINT suppressions_pkey;

ALTER TABLE plugin_campaigns_d355219713.suppressions
  ADD PRIMARY KEY (company_id, email, sender_key);

-- Who a send goes out as: the mailbox of the client, its reply-to and its sender numbers.
CREATE TABLE plugin_campaigns_d355219713.sender_identities (
  company_id text NOT NULL,
  sender_key text NOT NULL,
  from_address text,
  from_name text,
  reply_to text,
  sms_from text,
  whatsapp_from text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, sender_key)
);

-- SMS and WhatsApp do-not-contact list, per sender. The address is a phone number in E.164 or a hash after an erasure.
CREATE TABLE plugin_campaigns_d355219713.channel_suppressions (
  company_id text NOT NULL,
  channel text NOT NULL,
  address text NOT NULL,
  sender_key text NOT NULL DEFAULT '',
  reason text NOT NULL,
  scope text NOT NULL DEFAULT 'marketing',
  source text NOT NULL,
  contact_id text,
  campaign_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, channel, address, sender_key),
  CONSTRAINT channel_suppressions_channel CHECK (channel IN ('sms', 'whatsapp')),
  CONSTRAINT channel_suppressions_scope CHECK (scope IN ('marketing', 'all'))
);

CREATE INDEX channel_suppressions_created ON plugin_campaigns_d355219713.channel_suppressions (source, created_at);

-- Opt-in per channel and sender. SMS and WhatsApp marketing needs a granted row.
CREATE TABLE plugin_campaigns_d355219713.channel_consents (
  company_id text NOT NULL,
  channel text NOT NULL,
  address text NOT NULL,
  sender_key text NOT NULL DEFAULT '',
  granted boolean NOT NULL,
  basis text NOT NULL,
  source text NOT NULL,
  evidence text,
  contact_id text,
  recorded_at timestamptz NOT NULL,
  recorded_by text,
  PRIMARY KEY (company_id, channel, address, sender_key),
  CONSTRAINT channel_consents_channel CHECK (channel IN ('email', 'sms', 'whatsapp'))
);

-- Every SMS and WhatsApp message: one row per step per contact, written before the provider is called.
CREATE TABLE plugin_campaigns_d355219713.channel_messages (
  key text PRIMARY KEY,
  company_id text NOT NULL,
  campaign_id text NOT NULL,
  enrollment_id text NOT NULL,
  step_position integer NOT NULL,
  channel text NOT NULL,
  to_address text NOT NULL,
  contact_id text,
  sender_key text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  segments integer,
  status text NOT NULL DEFAULT 'sending',
  provider_id text,
  provider_status text,
  error_code text,
  error text,
  attempts integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_messages_channel CHECK (channel IN ('sms', 'whatsapp')),
  CONSTRAINT channel_messages_status CHECK (status IN ('sending', 'pending', 'sent', 'delivered', 'failed', 'unknown'))
);

CREATE INDEX channel_messages_enrollment ON plugin_campaigns_d355219713.channel_messages (enrollment_id);

CREATE INDEX channel_messages_provider ON plugin_campaigns_d355219713.channel_messages (provider_id) WHERE provider_id IS NOT NULL;

CREATE INDEX channel_messages_open ON plugin_campaigns_d355219713.channel_messages (company_id, status, updated_at);
