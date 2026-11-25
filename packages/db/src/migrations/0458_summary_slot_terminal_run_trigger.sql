-- PAR-14563: fail a generating summary slot whenever the run serving its issue reaches a terminal
-- status, whichever code path wrote that status. Many writers update heartbeat_runs directly
-- (native finalizer, watchdog, recovery, restart recovery, session executor, queue cancels...), so a
-- per-writer hook cannot be complete. Mirrors finalizeSummarySlotsForTerminalRun: a sibling run that is
-- queued, running or scheduled_retry keeps the slot generating. Idempotent: only status = 'generating'
-- slots match. Undo: DROP TRIGGER summary_slot_terminal_run ON heartbeat_runs; DROP FUNCTION paperclip_summary_slot_terminal_run();
CREATE OR REPLACE FUNCTION paperclip_summary_slot_terminal_run() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_issue text;
  v_detail text;
  v_reason text;
BEGIN
  v_issue := coalesce(
    nullif(btrim(NEW.issue_id::text), ''),
    nullif(btrim(NEW.native_issue_id::text), ''),
    nullif(btrim(NEW.context_snapshot ->> 'issueId'), '')
  );
  IF v_issue IS NULL THEN
    RETURN NULL;
  END IF;
  v_detail := CASE WHEN nullif(btrim(coalesce(NEW.error, '')), '') IS NULL THEN ''
    ELSE ' (' || left(btrim(NEW.error), 200) || ')' END;
  v_reason := CASE NEW.status
    WHEN 'timed_out' THEN 'Summary generation run timed out before writing a summary' || v_detail || '.'
    WHEN 'cancelled' THEN 'Summary generation run was cancelled before writing a summary' || v_detail || '.'
    WHEN 'interrupted' THEN 'Summary generation run was cancelled before writing a summary' || v_detail || '.'
    WHEN 'failed' THEN 'Summary generation run failed before writing a summary' || v_detail || '.'
    ELSE 'Summary generation run ended without writing a summary.'
  END;
  WITH failed AS (
    UPDATE summary_slots s
    SET status = 'failed', failure_reason = v_reason, updated_at = now()
    WHERE s.company_id = NEW.company_id
      AND s.generating_issue_id::text = v_issue
      AND s.status = 'generating'
      AND NOT EXISTS (
        SELECT 1 FROM heartbeat_runs r
        WHERE r.company_id = NEW.company_id
          AND r.id <> NEW.id
          AND r.status IN ('queued', 'running', 'scheduled_retry')
          AND (r.issue_id::text = v_issue OR r.native_issue_id::text = v_issue OR r.context_snapshot ->> 'issueId' = v_issue)
      )
    RETURNING s.id, s.company_id, s.scope_kind, s.scope_id, s.slot_key
  )
  INSERT INTO activity_log (company_id, actor_type, actor_id, action, entity_type, entity_id, details)
  SELECT f.company_id, 'system', 'summary-slot-finalizer', 'summary_slot.generate_failed', 'summary_slot', f.id::text,
    jsonb_build_object('source', 'terminal_run', 'scopeKind', f.scope_kind, 'scopeId', f.scope_id,
      'slotKey', f.slot_key, 'failureReason', v_reason, 'runId', NEW.id, 'runStatus', NEW.status, 'issueId', v_issue)
  FROM failed f;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS summary_slot_terminal_run ON "heartbeat_runs";--> statement-breakpoint
CREATE TRIGGER summary_slot_terminal_run AFTER UPDATE OF status ON "heartbeat_runs"
FOR EACH ROW WHEN (
  NEW.status IN ('succeeded', 'failed', 'timed_out', 'cancelled', 'interrupted')
  AND OLD.status IS DISTINCT FROM NEW.status
) EXECUTE FUNCTION paperclip_summary_slot_terminal_run();
