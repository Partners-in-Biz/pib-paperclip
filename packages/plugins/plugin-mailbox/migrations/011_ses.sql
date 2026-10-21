-- Mailbox 0.7.0: Amazon SES as a second email provider. One SES send-only account per address and company, as for Resend (009). Gmail and
-- Resend rows are not covered. (Addresses are stored in lower case.) Never edit this file once it may have run: add the next number.

CREATE UNIQUE INDEX accounts_ses_address ON plugin_mailbox_319145c88b.accounts (company_id, address) WHERE provider = 'ses';
