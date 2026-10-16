-- Billing 0.8: the CRM company's billing details (email, phone, address, VAT no., reg. no.) as the CRM sends them
-- with company.upserted. Printed in the Bill to block of drafts, and frozen into customer_snapshot at send.
-- Null until the CRM (0.15+) sends them. Additive: the previous code ignores the column.
ALTER TABLE plugin_billing_287195dc99.crm_companies ADD COLUMN IF NOT EXISTS billing jsonb;
