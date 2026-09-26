-- Autonomy (0.6.0): each sprint links the Paperclip project whose workspace holds the site repo,
-- with a change policy for pull requests by the agent and the site verification state.
ALTER TABLE plugin_seo_8099f8879a.sprints
  ADD COLUMN site_project_id text,
  ADD COLUMN site_access text NOT NULL DEFAULT 'unlinked',
  ADD COLUMN repo_url text,
  ADD COLUMN default_branch text NOT NULL DEFAULT 'main',
  ADD COLUMN framework text,
  ADD COLUMN hosting text,
  ADD COLUMN change_policy text NOT NULL DEFAULT 'merge_seo_scope',
  ADD COLUMN verification jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE plugin_seo_8099f8879a.sprints ADD CONSTRAINT sprints_site_access_check CHECK (site_access IN ('unlinked', 'repo', 'none'));

ALTER TABLE plugin_seo_8099f8879a.sprints ADD CONSTRAINT sprints_change_policy_check CHECK (change_policy IN ('merge_seo_scope', 'pr_only', 'full'));

ALTER TABLE plugin_seo_8099f8879a.sprints ADD CONSTRAINT sprints_hosting_check CHECK (hosting IS NULL OR hosting IN ('vercel', 'netlify', 'other'));

-- The project the task issue was created in (code tasks live in the site project).
ALTER TABLE plugin_seo_8099f8879a.sprint_tasks ADD COLUMN issue_project_id text;

-- "Needs you": one digest issue per sprint per week listing what only a person can do.
CREATE TABLE plugin_seo_8099f8879a.needs_you (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  sprint_id text NOT NULL REFERENCES plugin_seo_8099f8879a.sprints (id) ON DELETE CASCADE,
  week_start date NOT NULL,
  issue_id text,
  issue_identifier text,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX needs_you_sprint_week ON plugin_seo_8099f8879a.needs_you (sprint_id, week_start);

CREATE INDEX needs_you_issue ON plugin_seo_8099f8879a.needs_you (company_id, issue_id);
