-- Chat privacy hot fix (PAR-13397, follow-up to R-Chat-1 PAR-12831): plugin_core_read.heartbeat_runs as it has
-- been live since 19 Nov 2026 05:25 UTC, so the repo and live agree. Same columns as 0451 (AC-P16).
-- Why: 0451 put is_chat in a lateral with OFFSET 0, so its four hashed chat sets were probed for every run row,
-- and it read context_snapshot ->> 'issueId' and ->> 'taskId' for every row. context_snapshot is large (live:
-- 2.7 GB for 50,375 runs), so each read is a detoast: a scan of 6.6 s on the table took 17.7 s through the view
-- and Cockpit's cockpit.load went past its 30 s limit.
-- Here the chat ids are one uncorrelated ARRAY (one InitPlan per query) and the CASE reads context_snapshot only
-- when the run has neither issue_id nor native_issue_id. Live: view scan 6.7 s, the same as the table.
-- Rule change against 0451, accepted for the speed (live, 19 Nov: 0 of 50,375 runs differ, 300 chat runs
-- blanked before and after):
-- * A run with issue_id set is a chat run only when issue_id names a chat. The trigger
--   set_heartbeat_run_scope_kind (0313) sets issue_id from native_issue_id, else context issueId, else taskId,
--   so a context key that names a chat other than issue_id is not a shape the host writes.
-- * The chat test no longer pairs the id with company_id. Issue ids are uuids, and the trigger only binds
--   issue_id to an issue of the run's own company, so this can only blank more, never less.
-- Undo: re-run 0451_plugin_core_read_runs_hashed_chat_sets.sql (the slow view).
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
  SELECT CASE
    WHEN r."issue_id" IS NOT NULL THEN r."issue_id"::text = ANY (ARRAY(SELECT ci."id"::text FROM "public"."issues" ci WHERE ci."conversation_agent_id" IS NOT NULL))
    WHEN r."native_issue_id" IS NOT NULL THEN r."native_issue_id"::text = ANY (ARRAY(SELECT ci."id"::text FROM "public"."issues" ci WHERE ci."conversation_agent_id" IS NOT NULL))
    ELSE coalesce((r."context_snapshot" ->> 'issueId') = ANY (ARRAY(SELECT ci."id"::text FROM "public"."issues" ci WHERE ci."conversation_agent_id" IS NOT NULL)), false)
      OR coalesce((r."context_snapshot" ->> 'taskId') = ANY (ARRAY(SELECT ci."id"::text FROM "public"."issues" ci WHERE ci."conversation_agent_id" IS NOT NULL)), false)
  END AS "is_chat"
) chat;--> statement-breakpoint
REVOKE ALL ON "plugin_core_read"."heartbeat_runs" FROM PUBLIC;
