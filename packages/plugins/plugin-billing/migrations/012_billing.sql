-- Billing 0.6: money in through a payment provider (Stripe, PayFast, a test provider), refunds, and the erasure ledger.

-- One hosted checkout link for one invoice at one amount. The id travels to the provider as the reference the payment comes back with.
-- status: active (can be paid), paid, cancelled (the invoice changed or a person withdrew it), needs_attention (money arrived that a person must decide), failed (the provider refused to make it).
CREATE TABLE plugin_billing_287195dc99.payment_links (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  invoice_id text NOT NULL REFERENCES plugin_billing_287195dc99.invoices (id),
  provider text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  amount_minor bigint NOT NULL,
  currency text NOT NULL,
  url text,
  provider_ref text,
  provider_payment_id text,
  payment_id text,
  fee_minor bigint,
  refunded_minor bigint NOT NULL DEFAULT 0,
  last_error text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  deactivated_at timestamptz,
  remote_off_at timestamptz,
  CONSTRAINT payment_links_status CHECK (status IN ('active', 'paid', 'cancelled', 'needs_attention', 'failed')),
  CONSTRAINT payment_links_provider CHECK (provider IN ('stripe', 'payfast', 'mock'))
);

CREATE INDEX payment_links_invoice ON plugin_billing_287195dc99.payment_links (company_id, invoice_id, status);

CREATE UNIQUE INDEX payment_links_provider_payment ON plugin_billing_287195dc99.payment_links (provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL;

CREATE INDEX payment_links_provider_ref ON plugin_billing_287195dc99.payment_links (provider, provider_ref) WHERE provider_ref IS NOT NULL;

-- Every provider delivery that passed its signature check, once: the key is the provider and its event id.
-- result: applied, ignored (not about money), needs_attention (a person was asked) or failed (it will be retried by the provider).
CREATE TABLE plugin_billing_287195dc99.payment_events (
  key text PRIMARY KEY,
  company_id text NOT NULL,
  provider text NOT NULL,
  kind text NOT NULL,
  link_id text,
  result text NOT NULL DEFAULT 'failed',
  detail text,
  received_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  CONSTRAINT payment_events_result CHECK (result IN ('applied', 'ignored', 'needs_attention', 'failed'))
);

CREATE INDEX payment_events_company ON plugin_billing_287195dc99.payment_events (company_id, received_at);

-- A refund of money a provider took. The payment row it reverses is a negative payment with the same source key.
CREATE TABLE plugin_billing_287195dc99.payment_refunds (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  invoice_id text NOT NULL REFERENCES plugin_billing_287195dc99.invoices (id),
  link_id text,
  payment_id text,
  provider text NOT NULL,
  source_key text NOT NULL,
  amount_minor bigint NOT NULL,
  reason text,
  source text NOT NULL DEFAULT 'webhook',
  recorded_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX payment_refunds_source ON plugin_billing_287195dc99.payment_refunds (company_id, source_key);

-- Erasure of one person (POPIA). `erasures` keeps proof that it happened without the person (a hash of the subject key);
-- `privacy_holds` lists what the law makes Billing keep for now, so the nightly job can finish the erasure when the period ends.
CREATE TABLE plugin_billing_287195dc99.erasures (
  company_id text NOT NULL,
  request_id text NOT NULL,
  subject_hash text NOT NULL,
  status text NOT NULL,
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  retained jsonb NOT NULL DEFAULT '[]'::jsonb,
  approved_by text,
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, request_id)
);

CREATE TABLE plugin_billing_287195dc99.privacy_holds (
  company_id text NOT NULL,
  customer_kind text NOT NULL,
  customer_ref text NOT NULL,
  request_id text NOT NULL,
  retain_until date NOT NULL,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, customer_kind, customer_ref)
);

CREATE INDEX privacy_holds_due ON plugin_billing_287195dc99.privacy_holds (retain_until) WHERE released_at IS NULL;
