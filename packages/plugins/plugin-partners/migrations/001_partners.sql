CREATE TABLE plugin_partners_f5013a90fc.links (
  id text PRIMARY KEY,
  company_a_id text NOT NULL,
  company_b_id text NOT NULL,
  accepted_a boolean NOT NULL DEFAULT false,
  accepted_b boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT links_status CHECK (status IN ('pending', 'active')),
  CONSTRAINT links_distinct CHECK (company_a_id <> company_b_id)
);

CREATE UNIQUE INDEX links_pair ON plugin_partners_f5013a90fc.links (company_a_id, company_b_id);

CREATE TABLE plugin_partners_f5013a90fc.grants (
  id text PRIMARY KEY,
  link_id text NOT NULL REFERENCES plugin_partners_f5013a90fc.links (id),
  record_type text NOT NULL,
  record_id text NOT NULL,
  source_company_id text NOT NULL,
  grantee_company_id text NOT NULL,
  status text NOT NULL DEFAULT 'proposed',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT grants_status CHECK (status IN ('proposed', 'active')),
  CONSTRAINT grants_record_type CHECK (record_type IN ('contact', 'company', 'deal', 'invoice'))
);

CREATE UNIQUE INDEX grants_named_record ON plugin_partners_f5013a90fc.grants (record_type, record_id, grantee_company_id);
