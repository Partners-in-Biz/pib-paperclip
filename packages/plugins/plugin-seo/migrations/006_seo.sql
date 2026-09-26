-- Backlinks (seeded directories plus everything earned), content, and page health.
CREATE TABLE plugin_seo_8099f8879a.backlinks (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  sprint_id text NOT NULL REFERENCES plugin_seo_8099f8879a.sprints (id) ON DELETE CASCADE,
  source text NOT NULL,
  domain text NOT NULL,
  url text,
  submit_url text,
  type text NOT NULL DEFAULT 'directory' CHECK (type IN ('directory', 'community', 'guest_post', 'link_trade', 'organic', 'citation', 'other')),
  dr integer,
  status text NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'submitted', 'live', 'rejected', 'lost')),
  submitted_at timestamptz,
  live_at timestamptz,
  notes text,
  evidence jsonb,
  discovered_via text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX backlinks_template_domain ON plugin_seo_8099f8879a.backlinks (sprint_id, domain) WHERE discovered_via = 'template';

CREATE INDEX backlinks_sprint ON plugin_seo_8099f8879a.backlinks (sprint_id, status);

CREATE TABLE plugin_seo_8099f8879a.content (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  sprint_id text NOT NULL REFERENCES plugin_seo_8099f8879a.sprints (id) ON DELETE CASCADE,
  title text NOT NULL,
  type text NOT NULL DEFAULT 'post',
  status text NOT NULL DEFAULT 'idea' CHECK (status IN ('idea', 'drafting', 'review', 'scheduled', 'live', 'archived')),
  target_keyword_id text,
  target_url text,
  publish_on date,
  published_on date,
  social_post_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  internal_links_added boolean NOT NULL DEFAULT false,
  links_to_pillar_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  impressions integer,
  clicks integer,
  position real,
  perf_pulled_at timestamptz,
  task_id text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX content_sprint ON plugin_seo_8099f8879a.content (sprint_id, status);

CREATE TABLE plugin_seo_8099f8879a.page_health (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  sprint_id text NOT NULL REFERENCES plugin_seo_8099f8879a.sprints (id) ON DELETE CASCADE,
  url text NOT NULL,
  strategy text NOT NULL DEFAULT 'mobile',
  performance integer,
  seo integer,
  accessibility integer,
  best_practices integer,
  lcp_ms real,
  cls real,
  inp_ms real,
  lab_lcp_ms real,
  lab_cls real,
  lab_inp_ms real,
  field_lcp_ms real,
  field_cls real,
  field_inp_ms real,
  field_scope text,
  source text NOT NULL DEFAULT 'lab',
  opportunities jsonb NOT NULL DEFAULT '[]'::jsonb,
  pulled_on date NOT NULL,
  pulled_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX page_health_day ON plugin_seo_8099f8879a.page_health (sprint_id, url, strategy, pulled_on);

CREATE INDEX page_health_sprint ON plugin_seo_8099f8879a.page_health (sprint_id, pulled_at);
