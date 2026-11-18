-- Chat privacy CP-4b-3 (PAR-12886, finding PAR-12885): recreate plugin_core_read.heartbeat_runs with the same
-- columns and the same chat rule as 0450, but a cheaper chat test. In 0450 Postgres flattened the `chat` lateral
-- and copied its correlated EXISTS into each of the five blanked columns: six SubPlans per run row. Here each
-- key is matched against one uncorrelated set of (company_id, chat id), which Postgres hashes once per query,
-- and OFFSET 0 keeps the lateral from being flattened, so is_chat is computed once per row.
-- A NULL key gives NULL, not false; NULL OR false is NULL, so the CASE falls to ELSE and a non-chat run keeps
-- its text, as in 0450. A key that names a chat gives true whatever the other keys give.
-- Cockpit readTreeRuns on 420 issues / 6000 runs: about 213 ms with 0450, about 44 ms with this view.
-- Undo: re-run the heartbeat_runs statement of 0450_plugin_core_read_views.sql.
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
  SELECT
    (r."company_id", r."issue_id"::text) IN (
      SELECT ci."company_id", ci."id"::text FROM "public"."issues" ci WHERE ci."conversation_agent_id" IS NOT NULL
    )
    OR (r."company_id", r."native_issue_id"::text) IN (
      SELECT ci."company_id", ci."id"::text FROM "public"."issues" ci WHERE ci."conversation_agent_id" IS NOT NULL
    )
    OR (r."company_id", r."context_snapshot" ->> 'issueId') IN (
      SELECT ci."company_id", ci."id"::text FROM "public"."issues" ci WHERE ci."conversation_agent_id" IS NOT NULL
    )
    OR (r."company_id", r."context_snapshot" ->> 'taskId') IN (
      SELECT ci."company_id", ci."id"::text FROM "public"."issues" ci WHERE ci."conversation_agent_id" IS NOT NULL
    ) AS "is_chat"
  OFFSET 0
) chat;--> statement-breakpoint
REVOKE ALL ON "plugin_core_read"."heartbeat_runs" FROM PUBLIC;
