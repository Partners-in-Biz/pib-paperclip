-- Pages gain the created_at column the page listing orders by.
ALTER TABLE plugin_seo_8099f8879a.pages ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- Sprints become 90-day engines.
ALTER TABLE plugin_seo_8099f8879a.sprints
  ADD COLUMN client_ref text,
  ADD COLUMN client_name text,
  ADD COLUMN site_name text,
  ADD COLUMN start_date date,
  ADD COLUMN template_id text NOT NULL DEFAULT 'outrank-90',
  ADD COLUMN template_version integer NOT NULL DEFAULT 0,
  ADD COLUMN autopilot_mode text NOT NULL DEFAULT 'safe',
  ADD COLUMN owner_user_id text,
  ADD COLUMN project_id text,
  ADD COLUMN root_issue_id text,
  ADD COLUMN root_issue_identifier text,
  ADD COLUMN agent_id text,
  ADD COLUMN notes text,
  ADD COLUMN paused_reason text,
  ADD COLUMN health jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN scoreboard jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN today jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN current_day integer,
  ADD COLUMN current_week integer,
  ADD COLUMN current_phase integer,
  ADD COLUMN last_daily_on date,
  ADD COLUMN last_weekly_on date,
  ADD COLUMN audit_days_done jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN seeded_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- Backfill sprints created by the first version of the plugin (no template, template_version 0).
UPDATE plugin_seo_8099f8879a.sprints SET site_name = name WHERE site_name IS NULL;

UPDATE plugin_seo_8099f8879a.sprints SET start_date = (created_at AT TIME ZONE 'Africa/Johannesburg')::date WHERE start_date IS NULL;

UPDATE plugin_seo_8099f8879a.sprints SET status = 'active' WHERE status NOT IN ('pre_launch', 'active', 'compounding', 'paused', 'archived');

ALTER TABLE plugin_seo_8099f8879a.sprints ALTER COLUMN site_name SET NOT NULL, ALTER COLUMN start_date SET NOT NULL;

ALTER TABLE plugin_seo_8099f8879a.sprints ADD CONSTRAINT sprints_status_check CHECK (status IN ('pre_launch', 'active', 'compounding', 'paused', 'archived'));

ALTER TABLE plugin_seo_8099f8879a.sprints ADD CONSTRAINT sprints_autopilot_check CHECK (autopilot_mode IN ('off', 'safe', 'full'));

CREATE INDEX sprints_company_status ON plugin_seo_8099f8879a.sprints (company_id, status);

CREATE INDEX sprints_company_client ON plugin_seo_8099f8879a.sprints (company_id, client_ref);
