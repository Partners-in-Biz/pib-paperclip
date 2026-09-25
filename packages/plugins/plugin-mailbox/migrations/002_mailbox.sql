ALTER TABLE plugin_mailbox_319145c88b.messages
  ADD COLUMN read_at timestamptz;

CREATE TABLE plugin_mailbox_319145c88b.email_templates (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  name text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX email_templates_workspace ON plugin_mailbox_319145c88b.email_templates (company_id);
