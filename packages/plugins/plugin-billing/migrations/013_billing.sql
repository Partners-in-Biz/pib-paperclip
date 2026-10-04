-- Billing 0.7: what Billing did with each document a client signed (CRM deal.accepted and quote.accepted).
-- One row per signed document, claimed before any work starts: the two events of one signature, a repeated delivery
-- and a retry after a crash all meet on this key, so one signature drafts at most one invoice.
-- No names are kept here (only ids, amounts and fingerprints), so a person erased from the CRM leaves nothing behind.
-- status: processing (claimed, not finished), drafted (an invoice was drafted), already_invoiced (the quote or deal
-- already had an invoice), needs_attention (the signed document and Billing disagree, nothing drafted, an issue is open),
-- skipped (nothing to invoice, for example a document with no amount).
CREATE TABLE plugin_billing_287195dc99.signed_acceptances (
  company_id text NOT NULL,
  document_id text NOT NULL,
  status text NOT NULL DEFAULT 'processing',
  first_event text NOT NULL,
  quote_id text,
  quote_number text,
  deal_id text,
  client_kind text,
  client_ref text,
  amount_minor bigint,
  currency text,
  content_sha256 text,
  audit_head text,
  invoice_id text,
  reason text,
  last_error text,
  canary boolean NOT NULL DEFAULT false,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, document_id),
  CONSTRAINT signed_acceptances_status CHECK (status IN ('processing', 'drafted', 'already_invoiced', 'needs_attention', 'skipped'))
);

CREATE INDEX signed_acceptances_deal ON plugin_billing_287195dc99.signed_acceptances (company_id, deal_id) WHERE deal_id IS NOT NULL;

CREATE INDEX signed_acceptances_quote ON plugin_billing_287195dc99.signed_acceptances (company_id, quote_id) WHERE quote_id IS NOT NULL;

CREATE INDEX signed_acceptances_open ON plugin_billing_287195dc99.signed_acceptances (status, claimed_at) WHERE status = 'processing';
