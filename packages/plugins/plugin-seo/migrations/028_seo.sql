-- Page apply grants (0.42.0, PAR-9493 T1, PAR-9527): a person or a sign-off delegate agent approved applying a
-- Reviewer-passed change to some pages of a task on a pr_only WordPress site. Each open row adds its page to the
-- page-scoped apply window of the site, next to the approved and handed previews, until apply_until or the task closes.
-- page_url is normalised (kit normalisePageUrl). granted_by_agent_id is null for a person; an agent grant counts only
-- while that agent is in the signoffDelegateAgentIds setting. review_ref is the preview id or comment id of the Reviewer
-- PASS. notified_until is the apply_until the task issue was last told about, so a repeat call posts no second comment.
-- Rollback: revert the plugin first (the old code never reads this table; the 5-minute job then closes grant windows),
-- then optionally DROP TABLE plugin_seo_8099f8879a.page_apply_grants.
CREATE TABLE plugin_seo_8099f8879a.page_apply_grants (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  sprint_id text NOT NULL,
  site_id text NOT NULL,
  task_id text NOT NULL,
  page_url text NOT NULL,
  granted_by text NOT NULL,
  granted_by_agent_id text,
  review_ref text,
  note text,
  apply_until timestamptz NOT NULL,
  notified_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by text
);
CREATE UNIQUE INDEX page_apply_grants_open ON plugin_seo_8099f8879a.page_apply_grants (company_id, task_id, page_url) WHERE revoked_at IS NULL;
CREATE INDEX page_apply_grants_site ON plugin_seo_8099f8879a.page_apply_grants (company_id, site_id, apply_until);
