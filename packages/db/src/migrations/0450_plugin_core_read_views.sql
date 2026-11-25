-- Chat privacy (PAR-12776, plan PAR-12774 4.9 part A, points 1 and 4): chat-free read views for plugin SQL.
-- No code reads these views yet; CP-4b-2 (PAR-12843) points plugin SQL on the three core tables at them.
-- Each view lists every column of its table in table order. A view does not pick up a column added to its
-- table later: the migration that adds the column recreates the view here (drift guard:
-- server/src/__tests__/plugin-core-read-views.test.ts, AC-P16).
-- A task is a chat when issues.conversation_agent_id IS NOT NULL. A run belongs to a chat when issue_id,
-- native_issue_id, context_snapshot ->> 'issueId' or context_snapshot ->> 'taskId' names a chat of its company.
-- The trigger set_heartbeat_run_scope_kind (0313) fills issue_id on insert, but issue_id can later become NULL
-- (ON DELETE SET NULL, or an update) while the other three still name the chat, so all four are checked.
-- Grants (R-Chat-0, PAR-12840): production runs migrations and queries as one role, `paperclip`, which owns
-- the tables and therefore the new schema and views; no GRANT is needed. Nothing is granted to PUBLIC.
-- Undo: DROP SCHEMA IF EXISTS "plugin_core_read" CASCADE;
CREATE SCHEMA IF NOT EXISTS "plugin_core_read";--> statement-breakpoint
REVOKE ALL ON SCHEMA "plugin_core_read" FROM PUBLIC;--> statement-breakpoint
CREATE OR REPLACE VIEW "plugin_core_read"."issues" AS
SELECT
  i."id", i."company_id", i."project_id", i."goal_id", i."parent_id", i."title", i."description",
  i."status", i."priority", i."assignee_agent_id", i."created_by_agent_id", i."created_by_user_id",
  i."request_depth", i."billing_code", i."started_at", i."completed_at", i."cancelled_at",
  i."created_at", i."updated_at", i."issue_number", i."identifier", i."hidden_at",
  i."checkout_run_id", i."execution_run_id", i."execution_agent_name_key", i."execution_locked_at",
  i."assignee_user_id", i."assignee_adapter_overrides", i."execution_workspace_settings",
  i."project_workspace_id", i."execution_workspace_id", i."execution_workspace_preference",
  i."origin_kind", i."origin_id", i."origin_run_id", i."execution_policy", i."execution_state",
  i."origin_fingerprint", i."monitor_next_check_at", i."monitor_wake_requested_at",
  i."monitor_last_triggered_at", i."monitor_attempt_count", i."monitor_notes",
  i."monitor_scheduled_by", i."work_mode", i."source_trust", i."responsible_user_id",
  i."harness_kind", i."unblock_descriptor", i."blocked_transition_at",
  i."blocked_owner_notified_at", i."review_policy", i."status_version",
  i."last_status_decision_id", i."origin_identity_context_id",
  i."continuation_identity_context_id", i."conversation_agent_id", i."conversation_user_id",
  i."conversation_state", i."conversation_session_generation",
  i."conversation_boundary_comment_id", i."title_needs_generation", i."visibility",
  i."privacy_root_issue_id", i."privacy_parent_issue_id", i."workspace_binding_revision",
  i."workspace_selection", i."workspace_pending_selection", i."origin_issue_id"
FROM "public"."issues" i
WHERE i."conversation_agent_id" IS NULL;--> statement-breakpoint
CREATE OR REPLACE VIEW "plugin_core_read"."issue_comments" AS
SELECT
  c."id", c."company_id", c."issue_id", c."author_agent_id", c."author_user_id", c."body",
  c."created_at", c."updated_at", c."created_by_run_id", c."author_type", c."presentation",
  c."metadata", c."deleted_at", c."deleted_by_type", c."deleted_by_agent_id",
  c."deleted_by_user_id", c."deleted_by_run_id", c."source_trust", c."derived_author_agent_id",
  c."derived_created_by_run_id", c."derived_author_source", c."on_behalf_of_user_id",
  c."client_request_id", c."conversation_session_generation", c."origin",
  c."fast_response_request_id"
FROM "public"."issue_comments" c
WHERE NOT EXISTS (
  SELECT 1 FROM "public"."issues" ci
  WHERE ci."id" = c."issue_id" AND ci."conversation_agent_id" IS NOT NULL
);--> statement-breakpoint
CREATE OR REPLACE VIEW "plugin_core_read"."heartbeat_runs" AS
SELECT
  r."id", r."company_id", r."agent_id", r."invocation_source", r."status", r."started_at",
  r."finished_at", CASE WHEN chat."is_chat" THEN NULL ELSE r."error" END AS "error",
  r."external_run_id",
  CASE WHEN chat."is_chat" THEN NULL ELSE r."context_snapshot" END AS "context_snapshot",
  r."created_at", r."updated_at", r."trigger_detail", r."wakeup_request_id", r."exit_code",
  r."signal", r."usage_json",
  CASE WHEN chat."is_chat" THEN NULL ELSE r."result_json" END AS "result_json",
  r."session_id_before", r."session_id_after", r."log_store", r."log_ref", r."log_bytes",
  r."log_sha256", r."log_compressed",
  CASE WHEN chat."is_chat" THEN NULL ELSE r."stdout_excerpt" END AS "stdout_excerpt",
  CASE WHEN chat."is_chat" THEN NULL ELSE r."stderr_excerpt" END AS "stderr_excerpt",
  r."error_code", r."process_pid", r."process_started_at", r."retry_of_run_id",
  r."process_loss_retry_count", r."issue_comment_status",
  r."issue_comment_satisfied_by_comment_id", r."issue_comment_retry_queued_at",
  r."process_group_id", r."liveness_state", r."liveness_reason", r."continuation_attempt",
  r."last_useful_action_at", r."next_action", r."scheduled_retry_at", r."scheduled_retry_attempt",
  r."scheduled_retry_reason", r."last_output_at", r."last_output_seq", r."last_output_stream",
  r."last_output_bytes", r."responsible_user_id", r."runtime_mode",
  r."runtime_mode_resolver_version", r."runtime_mode_reason", r."runtime_mode_resolved_at",
  r."runner_profile_json", r."runner_instance_id", r."native_session_id", r."native_issue_id",
  r."driver_kind", r."driver_version", r."completion_contract_id", r."completion_contract_sha256",
  r."next_event_seq", r."native_phase", r."native_phase_updated_at",
  r."active_identity_context_id", r."execution_control_deadline_at",
  r."execution_status_delivery_id", r."controller_boot_id", r."controller_lease_expires_at",
  r."execution_stage", r."cost_accounting_pending", r."cost_accounted_at",
  r."accounting_projection_version", r."accounting_last_attempt_at", r."accounting_last_error",
  r."accounting_attempt_count", r."scope_kind", r."issue_id", r."legacy_process_settlement",
  r."process_host_hash", r."controller_process"
FROM "public"."heartbeat_runs" r
CROSS JOIN LATERAL (
  SELECT EXISTS (
    SELECT 1 FROM "public"."issues" ci
    WHERE ci."company_id" = r."company_id"
      AND ci."conversation_agent_id" IS NOT NULL
      AND ci."id"::text IN (
        r."issue_id"::text, r."native_issue_id"::text,
        r."context_snapshot" ->> 'issueId', r."context_snapshot" ->> 'taskId'
      )
  ) AS "is_chat"
) chat;--> statement-breakpoint
REVOKE ALL ON "plugin_core_read"."issues", "plugin_core_read"."issue_comments", "plugin_core_read"."heartbeat_runs" FROM PUBLIC;
