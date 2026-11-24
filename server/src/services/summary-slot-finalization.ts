import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, summarySlots } from "@paperclipai/db";
import type { IssueStatus } from "@paperclipai/shared";

const STOPPED_ISSUE_STATUSES = new Set<IssueStatus>(["done", "cancelled", "blocked"]);
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "timed_out", "cancelled", "interrupted"]);
const ACTIVE_RUN_STATUSES = ["queued", "running"] as const;

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
  dbOrTx: Pick<Db, "update">,
  issue: StoppedGenerationIssue,
) {
  if (!STOPPED_ISSUE_STATUSES.has(issue.status)) return [];

  return dbOrTx
    .update(summarySlots)
    .set({
      status: "failed",
      failureReason: failureReasonForIssue(issue),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(summarySlots.companyId, issue.companyId),
        eq(summarySlots.generatingIssueId, issue.id),
        eq(summarySlots.status, "generating"),
      ),
    )
    .returning({ id: summarySlots.id });
}

export async function finalizeSummarySlotsForTerminalRun(
  db: Pick<Db, "select" | "update">,
  run: TerminalGenerationRun,
) {
  if (!TERMINAL_RUN_STATUSES.has(run.status)) return [];
  const issueId = resolveRunIssueId(run);
  if (!issueId) return [];

  const generatingSlots = await db
    .select({ id: summarySlots.id })
    .from(summarySlots)
    .where(
      and(
        eq(summarySlots.companyId, run.companyId),
        eq(summarySlots.generatingIssueId, issueId),
        eq(summarySlots.status, "generating"),
      ),
    )
    .limit(1);

  if (generatingSlots.length === 0) return [];

  const otherActiveRuns = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, run.companyId),
        ne(heartbeatRuns.id, run.id),
        inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]),
        or(
          eq(heartbeatRuns.issueId, issueId),
          eq(heartbeatRuns.nativeIssueId, issueId),
          sql`(${heartbeatRuns.contextSnapshot} ->> 'issueId') = ${issueId}`,
        ),
      ),
    )
    .limit(1);

  if (otherActiveRuns.length > 0) return [];

  return db
    .update(summarySlots)
    .set({
      status: "failed",
      failureReason: failureReasonForRun(run),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(summarySlots.companyId, run.companyId),
        eq(summarySlots.generatingIssueId, issueId),
        eq(summarySlots.status, "generating"),
      ),
    )
    .returning({ id: summarySlots.id });
}
