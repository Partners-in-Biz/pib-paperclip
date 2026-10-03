-- 0.23.0: GEO (AI search) audits and sampled AI answers, GA4 weekly numbers, and page groups for site-wide tasks.

-- A fourth integration, ga4 (read only, through the same Google service account as Search Console).
ALTER TABLE plugin_seo_8099f8879a.integrations DROP CONSTRAINT IF EXISTS integrations_provider_check;

ALTER TABLE plugin_seo_8099f8879a.integrations ADD CONSTRAINT integrations_provider_check CHECK (provider IN ('gsc', 'bing', 'pagespeed', 'ga4'));

-- Snapshots carry the AI-search readiness score and the GA4 organic numbers beside traffic, rankings and the rest.
ALTER TABLE plugin_seo_8099f8879a.audit_snapshots ADD COLUMN geo jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE plugin_seo_8099f8879a.audit_snapshots ADD COLUMN analytics jsonb NOT NULL DEFAULT '{}'::jsonb;

-- One row per geo-audit run: the readiness score, its sections, and the evidence behind them (never page content).
CREATE TABLE plugin_seo_8099f8879a.geo_audits (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  sprint_id text NOT NULL REFERENCES plugin_seo_8099f8879a.sprints (id) ON DELETE CASCADE,
  audited_on date NOT NULL,
  audited_at timestamptz NOT NULL DEFAULT now(),
  score integer NOT NULL,
  band text NOT NULL,
  complete boolean NOT NULL DEFAULT true,
  breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  sections jsonb NOT NULL DEFAULT '{}'::jsonb,
  finding_count integer NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'tool',
  CONSTRAINT geo_audits_source_check CHECK (source IN ('tool', 'snapshot', 'scheduled'))
);

CREATE INDEX geo_audits_sprint ON plugin_seo_8099f8879a.geo_audits (sprint_id, audited_at DESC);

-- AI answers the agent sampled for the key questions of the sprint. A mention or citation always carries its evidence.
-- query_key is the question lower-cased with spaces collapsed; sampling the same question on the same assistant on
-- the same day again replaces the row of that day.
CREATE TABLE plugin_seo_8099f8879a.ai_mentions (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  sprint_id text NOT NULL REFERENCES plugin_seo_8099f8879a.sprints (id) ON DELETE CASCADE,
  query text NOT NULL,
  query_key text NOT NULL,
  engine text NOT NULL,
  sampled_on date NOT NULL,
  mentioned boolean NOT NULL DEFAULT false,
  cited boolean NOT NULL DEFAULT false,
  position integer,
  cited_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  competitors jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence text,
  note text,
  method text,
  recorded_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ai_mentions_sample ON plugin_seo_8099f8879a.ai_mentions (sprint_id, query_key, engine, sampled_on);

CREATE INDEX ai_mentions_sprint ON plugin_seo_8099f8879a.ai_mentions (sprint_id, sampled_on);

-- GA4 weekly numbers per sprint (ISO weeks, Monday first): totals, the Organic Search channel, organic landing pages,
-- source / medium, key events by name and AI-assistant referrals. Refreshed for the last weeks on every pull.
CREATE TABLE plugin_seo_8099f8879a.analytics_weeks (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  sprint_id text NOT NULL REFERENCES plugin_seo_8099f8879a.sprints (id) ON DELETE CASCADE,
  week_start date NOT NULL,
  property_id text NOT NULL,
  sessions integer NOT NULL DEFAULT 0,
  engaged_sessions integer NOT NULL DEFAULT 0,
  users integer NOT NULL DEFAULT 0,
  key_events integer NOT NULL DEFAULT 0,
  organic_sessions integer NOT NULL DEFAULT 0,
  organic_engaged_sessions integer NOT NULL DEFAULT 0,
  organic_users integer NOT NULL DEFAULT 0,
  organic_key_events integer NOT NULL DEFAULT 0,
  channels jsonb NOT NULL DEFAULT '[]'::jsonb,
  landing_pages jsonb NOT NULL DEFAULT '[]'::jsonb,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  key_event_names jsonb NOT NULL DEFAULT '[]'::jsonb,
  ai_referrals jsonb NOT NULL DEFAULT '[]'::jsonb,
  pulled_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX analytics_weeks_week ON plugin_seo_8099f8879a.analytics_weeks (sprint_id, week_start);

-- Page groups: a site-wide task (a title and description for every page, alt text, noindex) is split into child
-- issues of N pages, opened one at a time. One row per group, under the issue of the parent task.
CREATE TABLE plugin_seo_8099f8879a.task_chunks (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  sprint_id text NOT NULL REFERENCES plugin_seo_8099f8879a.sprints (id) ON DELETE CASCADE,
  task_id text NOT NULL REFERENCES plugin_seo_8099f8879a.sprint_tasks (id) ON DELETE CASCADE,
  parent_issue_id text NOT NULL,
  seq integer NOT NULL,
  total integer NOT NULL,
  label text NOT NULL,
  urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'queued',
  issue_id text,
  issue_identifier text,
  opened_at timestamptz,
  done_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_chunks_status_check CHECK (status IN ('queued', 'open', 'done', 'cancelled'))
);

CREATE UNIQUE INDEX task_chunks_group ON plugin_seo_8099f8879a.task_chunks (parent_issue_id, seq);

CREATE INDEX task_chunks_task ON plugin_seo_8099f8879a.task_chunks (task_id, status);

CREATE INDEX task_chunks_issue ON plugin_seo_8099f8879a.task_chunks (company_id, issue_id);
