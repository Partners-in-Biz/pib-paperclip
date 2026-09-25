CREATE TABLE plugin_social_e70c4e79f2.inbox_items (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  account_id text REFERENCES plugin_social_e70c4e79f2.accounts (id),
  kind text NOT NULL,
  author text NOT NULL DEFAULT '',
  body text NOT NULL,
  status text NOT NULL DEFAULT 'new',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inbox_kind CHECK (kind IN ('mention', 'comment', 'message')),
  CONSTRAINT inbox_status CHECK (status IN ('new', 'read', 'replied'))
);

CREATE INDEX inbox_workspace ON plugin_social_e70c4e79f2.inbox_items (company_id, status);
