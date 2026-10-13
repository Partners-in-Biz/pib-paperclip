-- Telephony tables for call recording, messaging, and transcription. Rollback: leave tables, old code ignores them.

CREATE TABLE plugin_crm_telephony_40e33d0807.tel_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL,
  contact_id text,
  user_id text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  from_e164 text NOT NULL,
  to_e164 text NOT NULL,
  call_sid text UNIQUE NOT NULL,
  status text NOT NULL DEFAULT 'initiated',
  started_at timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  duration_s int,
  recorded boolean NOT NULL DEFAULT false,
  consent_notice_played boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tel_calls_company_created ON plugin_crm_telephony_40e33d0807.tel_calls (company_id, created_at DESC);
CREATE INDEX tel_calls_contact_created ON plugin_crm_telephony_40e33d0807.tel_calls (contact_id, created_at DESC);

CREATE TABLE plugin_crm_telephony_40e33d0807.tel_recordings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_sid text NOT NULL,
  recording_sid text UNIQUE NOT NULL,
  twilio_url text NOT NULL,
  r2_key text,
  bytes bigint,
  sha256 text,
  state text NOT NULL DEFAULT 'received' CHECK (state IN ('received', 'downloaded', 'twilio_deleted', 'transcribed', 'summarised', 'noted', 'failed', 'dead', 'skipped', 'erased')),
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  last_error text,
  expires_at timestamptz,
  erased_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tel_recordings_state_attempt ON plugin_crm_telephony_40e33d0807.tel_recordings (state, next_attempt_at) WHERE erased_at IS NULL;
CREATE INDEX tel_recordings_call_sid ON plugin_crm_telephony_40e33d0807.tel_recordings (call_sid);
CREATE INDEX tel_recordings_expires ON plugin_crm_telephony_40e33d0807.tel_recordings (expires_at, state);

CREATE TABLE plugin_crm_telephony_40e33d0807.tel_contact_prefs (
  company_id text NOT NULL,
  contact_id text NOT NULL,
  PRIMARY KEY (company_id, contact_id),
  do_not_record boolean NOT NULL DEFAULT false,
  language text CHECK (language IN ('af', 'en') OR language IS NULL),
  sms_opt_out_at timestamptz,
  wa_opt_out_at timestamptz,
  erased_at timestamptz,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plugin_crm_telephony_40e33d0807.tel_transcripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id uuid UNIQUE NOT NULL,
  call_sid text UNIQUE NOT NULL,
  provider text NOT NULL DEFAULT 'deepgram',
  language text CHECK (language IN ('af', 'en') OR language IS NULL),
  text text NOT NULL,
  segments jsonb,
  summary text,
  next_actions jsonb,
  crm_activity_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plugin_crm_telephony_40e33d0807.tel_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('sms', 'whatsapp')),
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  provider_msg_id text UNIQUE NOT NULL,
  contact_id text,
  from_e164 text NOT NULL,
  to_e164 text NOT NULL,
  body text,
  template_id uuid,
  kind text NOT NULL DEFAULT 'service' CHECK (kind IN ('marketing', 'service')),
  status text NOT NULL DEFAULT 'queued',
  received_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tel_messages_contact_created ON plugin_crm_telephony_40e33d0807.tel_messages (contact_id, created_at DESC);
CREATE INDEX tel_messages_channel_direction ON plugin_crm_telephony_40e33d0807.tel_messages (channel, direction);

CREATE TABLE plugin_crm_telephony_40e33d0807.tel_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('sms', 'whatsapp')),
  name text NOT NULL,
  language text NOT NULL CHECK (language IN ('af', 'en')),
  twilio_content_sid text,
  body_preview text,
  approved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tel_templates_channel_language_approved ON plugin_crm_telephony_40e33d0807.tel_templates (channel, language, approved);

CREATE TABLE plugin_crm_telephony_40e33d0807.tel_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL,
  user_id text NOT NULL,
  action text NOT NULL,
  contact_id text,
  at timestamptz NOT NULL DEFAULT now(),
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tel_audit_company_user_at ON plugin_crm_telephony_40e33d0807.tel_audit (company_id, user_id, at DESC);
CREATE INDEX tel_audit_action_at ON plugin_crm_telephony_40e33d0807.tel_audit (action, at DESC);
