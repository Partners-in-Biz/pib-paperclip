-- Mailbox 0.6.1: a person can lift a reputation hold (with a record of who and why), what the provider says about tracking for a domain, and a cheap way
-- to find the send of a client message. Never edit this file once it may have run: add the next number.

-- A provider domain: what the provider last said about open and click tracking (null: it did not say), and the moment a person lifted the
-- reputation hold. From that day only what happens next is judged; the counts of the clearing day at that moment are taken off that day.
ALTER TABLE plugin_mailbox_319145c88b.esp_domains
  ADD COLUMN open_tracking boolean,
  ADD COLUMN click_tracking boolean,
  ADD COLUMN reputation_cleared_at timestamptz,
  ADD COLUMN reputation_cleared_by text,
  ADD COLUMN reputation_cleared_day text,
  ADD COLUMN reputation_cleared_baseline jsonb;

-- What a person did to the limits of a provider domain: who (the signed-in user the host reports, never a value from the request), when and why.
CREATE TABLE plugin_mailbox_319145c88b.esp_domain_audit (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  domain text NOT NULL,
  action text NOT NULL,
  actor text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT esp_domain_audit_action CHECK (action IN ('clear_reputation_hold', 'set_limits'))
);

CREATE INDEX esp_domain_audit_domain ON plugin_mailbox_319145c88b.esp_domain_audit (company_id, domain, created_at DESC);

-- Client messages (a signing email, a report) keep no text once their send has ended. The hourly sweep and the reads of the Mailbox find them by
-- their context kind, so only those rows are indexed.
CREATE INDEX send_requests_client_message ON plugin_mailbox_319145c88b.send_requests (company_id, created_at) WHERE (context ->> 'kind') = 'client_message';
