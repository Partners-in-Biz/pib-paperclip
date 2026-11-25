import { and, eq, inArray, ne, notExists, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, heartbeatRuns, summarySlots } from "@paperclipai/db";
import type { IssueStatus } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

const STOPPED_ISSUE_STATUSES = new Set<IssueStatus>(["done", "cancelled", "blocked"]);
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "timed_out", "cancelled", "interrupted"]);
// `scheduled_retry` counts as active: a pending retry still serves the issue and
// may yet write the summary, so a terminal sibling must not fail the slot.
export const ACTIVE_SUMMARY_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;

const FINALIZER_ACTOR_ID = "summary-slot-finalizer";

type SlotFailureRow = {
  id: string;
  companyId: string;
  scopeKind: string;
  scopeId: string | null;
  slotKey: string;
};

const SLOT_FAILURE_RETURNING = {
  id: summarySlots.id,
  companyId: summarySlots.companyId,
  scopeKind: summarySlots.scopeKind,
  scopeId: summarySlots.scopeId,
  slotKey: summarySlots.slotKey,
};

/** Writes one activity row per slot a system path moved to `failed`. */
export async function logSummarySlotFailures(
  db: Pick<Db, "insert">,
  rows: SlotFailureRow[],
  source: string,
  failureReason: string,
  extra: Record<string, unknown> = {},
) {
  if (rows.length === 0) return;
  await db.insert(activityLog).values(
    rows.map((row) => ({
      companyId: row.companyId,
      actorType: "system",
      actorId: FINALIZER_ACTOR_ID,
      action: "summary_slot.generate_failed",
      entityType: "summary_slot",
      entityId: row.id,
      details: {
        source,
        scopeKind: row.scopeKind,
        scopeId: row.scopeId,
        slotKey: row.slotKey,
        failureReason,
        ...extra,
      },
    })),
  );
}

interface StoppedGenerationIssue {
  id: string;
  companyId: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
}

interface TerminalGenerationRun {
  id: string;
  companyId: string;
  status: string;
  issueId?: string | null;
  nativeIssueId?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
  error?: string | null;
}

function failureReasonForIssue(issue: StoppedGenerationIssue) {
  const label = issue.identifier ? `${issue.identifier}: ${issue.title}` : issue.title;
  if (issue.status === "cancelled") {
    return `Summary generation task ${label} was cancelled before writing a summary.`;
  }
  if (issue.status === "blocked") {
    return `Summary generation task ${label} was blocked before writing a summary.`;
  }
  return `Summary generation task ${label} finished without writing a summary.`;
}

function resolveRunIssueId(run: TerminalGenerationRun): string | null {
  if (typeof run.issueId === "string" && run.issueId.trim().length > 0) return run.issueId.trim();
  if (typeof run.nativeIssueId === "string" && run.nativeIssueId.trim().length > 0) return run.nativeIssueId.trim();
  const contextIssueId = run.contextSnapshot?.issueId;
  if (typeof contextIssueId === "string" && contextIssueId.trim().length > 0) return contextIssueId.trim();
  return null;
}

function failureReasonForRun(run: TerminalGenerationRun): string {
  const detail = typeof run.error === "string" && run.error.trim().length > 0
    ? ` (${run.error.trim().slice(0, 200)})`
    : "";
  switch (run.status) {
    case "timed_out":
      return `Summary generation run timed out before writing a summary${detail}.`;
    case "cancelled":
    case "interrupted":
      return `Summary generation run was cancelled before writing a summary${detail}.`;
    case "failed":
      return `Summary generation run failed before writing a summary${detail}.`;
    default:
      return "Summary generation run ended without writing a summary.";
  }
}

export async function finalizeSummarySlotsForTerminalIssue(
  dbOrTx: Pick<Db, "update" | "insert">,
  issue: StoppedGenerationIssue,
) {
  if (!STOPPED_ISSUE_STATUSES.has(issue.status)) return [];

  const failureReason = failureReasonForIssue(issue);
  const rows = await dbOrTx
    .update(summarySlots)
    .set({
      status: "failed",
      failureReason,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(summarySlots.companyId, issue.companyId),
        eq(summarySlots.generatingIssueId, issue.id),
        eq(summarySlots.status, "generating"),
      ),
    )
    .returning(SLOT_FAILURE_RETURNING);
  await logSummarySlotFailures(dbOrTx, rows, "terminal_issue", failureReason, {
    issueId: issue.id,
    issueStatus: issue.status,
  });
  return rows.map((row) => ({ id: row.id }));
}

/**
 * Fail the generating slot of a terminal run's issue unless another queued,
 * running or scheduled-retry run still serves that issue. The "no other active
 * run" check lives in the UPDATE's WHERE clause (NOT EXISTS), so the check and
 * the write are one statement. Under READ COMMITTED a run inserted by a
 * concurrent transaction that has not committed yet is still invisible to that
 * statement; that narrow window is accepted because the new run's own terminal
 * transition runs this hook again.
 *
 * Coverage: the database trigger `summary_slot_terminal_run` (migration 0458)
 * applies the same rule on every `heartbeat_runs` status change to a terminal
 * status, so no writer can skip it. This function stays as the in-process path
 * run-lifecycle calls (and the reference the trigger mirrors); both are
 * idempotent because only a slot still `generating` matches.
 *
 * Policy: any terminal run status (including `succeeded`) fails a slot that is
 * still `generating`. A run that succeeds without closing its issue or writing
 * the summary did not deliver, and a `blocked` issue is stopped work; both
 * would otherwise leave the slot stuck. A successful summary write already moves
 * the slot to idle/ready, so it never matches `status = 'generating'`.
 */
export async function finalizeSummarySlotsForTerminalRun(
  db: Pick<Db, "select" | "update" | "insert">,
  run: TerminalGenerationRun,
) {
  if (!TERMINAL_RUN_STATUSES.has(run.status)) return [];
  const issueId = resolveRunIssueId(run);
  if (!issueId) return [];

  const otherActiveRuns = db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, run.companyId),
        ne(heartbeatRuns.id, run.id),
        inArray(heartbeatRuns.status, [...ACTIVE_SUMMARY_RUN_STATUSES]),
        or(
          eq(heartbeatRuns.issueId, issueId),
          eq(heartbeatRuns.nativeIssueId, issueId),
          sql`(${heartbeatRuns.contextSnapshot} ->> 'issueId') = ${issueId}`,
        ),
      ),
    );

  const failureReason = failureReasonForRun(run);
  const rows = await db
    .update(summarySlots)
    .set({
      status: "failed",
      failureReason,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(summarySlots.companyId, run.companyId),
        eq(summarySlots.generatingIssueId, issueId),
        eq(summarySlots.status, "generating"),
        notExists(otherActiveRuns),
      ),
    )
    .returning(SLOT_FAILURE_RETURNING);
  await logSummarySlotFailures(db, rows, "terminal_run", failureReason, {
    runId: run.id,
    runStatus: run.status,
    issueId,
  });
  return rows.map((row) => ({ id: row.id }));
}

/**
 * Post-commit wrapper for the writers of terminal `heartbeat_runs` rows. Safe
 * to call beside any terminal-run telemetry emit: non-terminal statuses are a
 * no-op, and a failure is logged, never thrown, so it cannot fail the run.
 */
export async function settleSummarySlotsForTerminalRun(
  db: Pick<Db, "select" | "update" | "insert">,
  run: TerminalGenerationRun,
): Promise<void> {
  try {
    await finalizeSummarySlotsForTerminalRun(db, run);
  } catch (err) {
    logger.warn({ err, runId: run.id }, "failed to finalize summary slot for terminal run");
  }
}
