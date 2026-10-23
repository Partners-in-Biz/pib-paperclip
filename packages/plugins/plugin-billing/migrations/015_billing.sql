-- Billing: allow PayPal as a payment_links provider (PAR-4698). Stripe stays for in-flight links.
ALTER TABLE plugin_billing_287195dc99.payment_links DROP CONSTRAINT IF EXISTS payment_links_provider;
ALTER TABLE plugin_billing_287195dc99.payment_links
  ADD CONSTRAINT payment_links_provider CHECK (provider IN ('stripe', 'payfast', 'paypal', 'mock'));
