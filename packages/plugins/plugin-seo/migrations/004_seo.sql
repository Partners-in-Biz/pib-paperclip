-- Sprint tasks: the Outrank-90 plan per sprint. Each due task gets a Paperclip sub-issue.
CREATE TABLE plugin_seo_8099f8879a.sprint_tasks (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  sprint_id text NOT NULL REFERENCES plugin_seo_8099f8879a.sprints (id) ON DELETE CASCADE,
  template_key text,
  week integer NOT NULL DEFAULT 0,
  phase integer NOT NULL DEFAULT 0,
  due_day integer,
  focus text NOT NULL DEFAULT '',
  title text NOT NULL,
  description text,
  task_type text NOT NULL DEFAULT 'custom',
  owner text NOT NULL DEFAULT 'agent' CHECK (owner IN ('agent', 'human')),
  autopilot_eligible boolean NOT NULL DEFAULT false,
  playbook_key text,
  status text NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'blocked', 'done', 'skipped', 'na')),
  source text NOT NULL DEFAULT 'template' CHECK (source IN ('template', 'manual', 'optimization')),
  parent_optimization_id text,
  context text,
  issue_id text,
  issue_identifier text,
  issue_status text,
  assignee_kind text,
  blocker_reason text,
  human_ask text,
  evidence jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  completed_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX sprint_tasks_template_key ON plugin_seo_8099f8879a.sprint_tasks (sprint_id, template_key) WHERE template_key IS NOT NULL;

CREATE INDEX sprint_tasks_sprint_status ON plugin_seo_8099f8879a.sprint_tasks (sprint_id, status, week);

CREATE INDEX sprint_tasks_issue ON plugin_seo_8099f8879a.sprint_tasks (issue_id);

CREATE INDEX sprint_tasks_company ON plugin_seo_8099f8879a.sprint_tasks (company_id);
