-- CRM: speed-to-lead (PAR-2262). Stop-first: replaces care_approvals_kind CHECK to include speed_to_lead.

ALTER TABLE plugin_crm_832258244c.care_approvals DROP CONSTRAINT care_approvals_kind;

ALTER TABLE plugin_crm_832258244c.care_approvals ADD CONSTRAINT care_approvals_kind CHECK (kind IN ('client_action', 'client_reminder', 'client_report', 'feedback_request', 'erasure', 'esign_request', 'esign_reminder', 'esign_copy', 'speed_to_lead'));
