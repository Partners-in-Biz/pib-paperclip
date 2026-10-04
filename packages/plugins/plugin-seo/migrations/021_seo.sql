-- 0.23.1: the 0.23.0 extras (AI search, Google Analytics, page groups) are off until a person switches them on, per sprint.
-- Every existing sprint gets false in all three columns, so nothing about a running sprint changes when this is applied.

ALTER TABLE plugin_seo_8099f8879a.sprints ADD COLUMN geo_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE plugin_seo_8099f8879a.sprints ADD COLUMN ga4_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE plugin_seo_8099f8879a.sprints ADD COLUMN chunks_enabled boolean NOT NULL DEFAULT false;

-- What NEW sprints of a company start with (also off). Read once, when a sprint is created; running sprints never follow it.
CREATE TABLE plugin_seo_8099f8879a.company_switches (
  company_id text PRIMARY KEY,
  geo_default boolean NOT NULL DEFAULT false,
  ga4_default boolean NOT NULL DEFAULT false,
  chunks_default boolean NOT NULL DEFAULT false,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Every switch change, who made it (a signed-in person, taken from the actor the host reports) and what it did. Append
-- only; no foreign key, so the trail outlives a sprint row.
CREATE TABLE plugin_seo_8099f8879a.switch_log (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  sprint_id text,
  feature text NOT NULL,
  scope text NOT NULL,
  enabled boolean NOT NULL,
  changed_by text NOT NULL,
  effect jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT switch_log_feature_check CHECK (feature IN ('geo', 'ga4', 'chunks')),
  CONSTRAINT switch_log_scope_check CHECK (scope IN ('sprint', 'company'))
);

CREATE INDEX switch_log_sprint ON plugin_seo_8099f8879a.switch_log (company_id, sprint_id, created_at DESC);
