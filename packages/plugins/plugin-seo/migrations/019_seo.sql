-- 0.21.0: the client fact sheet. Approved wordings the copy may use for claims about how the business works, and
-- things never to say. create-preview refuses claims that are not on it; the Reviewer checks against it.
CREATE TABLE plugin_seo_8099f8879a.client_facts (
  sprint_id text PRIMARY KEY REFERENCES plugin_seo_8099f8879a.sprints (id) ON DELETE CASCADE,
  company_id text NOT NULL,
  facts jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'draft',
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_facts_status_check CHECK (status IN ('draft', 'confirmed'))
);
