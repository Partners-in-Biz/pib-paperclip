import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { issueService } from "./issues.js";

/**
 * Ops alerts (PAR-1963). Platform guards (wake loop breaker, spend alarm) post
 * one system comment on a single operator inbox issue and wake its assignee,
 * who relays the alert to a human. Dedupe is the caller's job: call this only
 * when the guard actually tripped.
 */
export const OPS_ALERT_ISSUE_ID_ENV = "PAPERCLIP_OPS_ALERT_ISSUE_ID";
export const OPS_ALERT_ACTOR_ID = "ops_alert";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read per call so an env change applies without a code change. Invalid means unset. */
export function readOpsAlertIssueId(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[OPS_ALERT_ISSUE_ID_ENV]?.trim();
  return raw && UUID_PATTERN.test(raw) ? raw.toLowerCase() : null;
}

export function isOpsAlertIssue(issueId: string, env: NodeJS.ProcessEnv = process.env) {
  const alertIssueId = readOpsAlertIssueId(env);
  return alertIssueId !== null && alertIssueId === issueId.toLowerCase();
}

/** Subset of the heartbeat wakeup options the alert wake uses. */
export type OpsAlertWakeupOptions = {
  source: "automation";
  triggerDetail: "system";
  reason: "issue_commented";
  payload: Record<string, unknown>;
  requestedByActorType: "system";
  requestedByActorId: string;
  contextSnapshot: Record<string, unknown>;
};

export type OpsAlertInput = {
  companyId: string;
  /** Stable id of what tripped, for logs (e.g. `wake_loop_breaker:<actionId>`). */
  key: string;
  /** One line: what, since when (SAST), impact, link, what the operator must do. */
  body: string;
};

export type OpsAlertResult =
  | { posted: true; issueId: string; commentId: string; wokeAgentId: string | null }
  | { posted: false; reason: "alert_issue_unset" | "alert_issue_not_found" };

export function opsAlertService(
  db: Db,
  deps: {
    wakeup: (agentId: string, opts: OpsAlertWakeupOptions) => Promise<unknown>;
    env?: NodeJS.ProcessEnv;
  },
) {
  const issuesSvc = issueService(db);

  async function postOpsAlert(input: OpsAlertInput): Promise<OpsAlertResult> {
    const alertIssueId = readOpsAlertIssueId(deps.env ?? process.env);
    if (!alertIssueId) {
      logger.warn(
        { key: input.key, companyId: input.companyId, body: input.body },
        "ops_alert.log_only",
      );
      return { posted: false, reason: "alert_issue_unset" };
    }

    const alertIssue = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        assigneeAgentId: issues.assigneeAgentId,
        status: issues.status,
      })
      .from(issues)
      .where(and(eq(issues.id, alertIssueId), eq(issues.companyId, input.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!alertIssue) {
      // Another company's alert issue is never a valid target.
      logger.warn(
        { key: input.key, companyId: input.companyId, alertIssueId, body: input.body },
        "ops_alert.log_only",
      );
      return { posted: false, reason: "alert_issue_not_found" };
    }

    const comment = await issuesSvc.addComment(alertIssue.id, input.body, {}, {
      authorType: "system",
    });
    await logActivity(db, {
      companyId: alertIssue.companyId,
      actorType: "system",
      actorId: OPS_ALERT_ACTOR_ID,
      agentId: null,
      runId: null,
      action: "issue.comment_added",
      entityType: "issue",
      entityId: alertIssue.id,
      details: { commentId: comment.id, source: OPS_ALERT_ACTOR_ID, key: input.key },
    });

    // A service-level comment bypasses the route's wake logic, so wake the
    // inbox assignee the same way the child stop relay does.
    const wokeAgentId =
      alertIssue.assigneeAgentId && !["done", "cancelled"].includes(alertIssue.status)
        ? alertIssue.assigneeAgentId
        : null;
    if (wokeAgentId) {
      await deps.wakeup(wokeAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId: alertIssue.id, commentId: comment.id, mutation: "comment" },
        requestedByActorType: "system",
        requestedByActorId: OPS_ALERT_ACTOR_ID,
        contextSnapshot: {
          issueId: alertIssue.id,
          taskId: alertIssue.id,
          commentId: comment.id,
          wakeCommentId: comment.id,
          source: "ops_alert",
          wakeReason: "issue_commented",
          opsAlertKey: input.key,
        },
      });
    }

    logger.info(
      { key: input.key, companyId: input.companyId, alertIssueId, commentId: comment.id, wokeAgentId },
      "ops_alert.posted",
    );
    return { posted: true, issueId: alertIssue.id, commentId: comment.id, wokeAgentId };
  }

  return { postOpsAlert };
}
