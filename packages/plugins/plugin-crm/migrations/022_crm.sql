-- CRM: report intake mode for lead sources (PAR-10822). Additive columns; every existing source keeps intake lead and works as before.
-- intake issue: a submission opens one issue in target_project_id (optional assignee target_agent_id), with no contact and no consent record.
-- Rollback: none needed. Old code never reads these columns; an issue source would then act as a lead source again.

ALTER TABLE plugin_crm_832258244c.lead_sources ADD COLUMN IF NOT EXISTS intake text NOT NULL DEFAULT 'lead';

ALTER TABLE plugin_crm_832258244c.lead_sources ADD COLUMN IF NOT EXISTS target_project_id text;

ALTER TABLE plugin_crm_832258244c.lead_sources ADD COLUMN IF NOT EXISTS target_agent_id text;
