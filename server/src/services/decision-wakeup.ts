import type { DecisionServiceOptions } from "./decisions.js";
import type { ArchiveNotificationBatch } from "./decision-retention.js";
import { SYSTEM_CAUSING_ACTOR, type WakeCausingActor } from "./heartbeat/causing-actor.js";

type HeartbeatWakeup = (
  agentId: string,
  options: {
    source: "automation";
    triggerDetail: "system";
    reason: string;
    payload: Record<string, unknown>;
    causingActor: WakeCausingActor;
  },
) => Promise<unknown>;

/**
 * Connect decision continuations to the heartbeat runtime only while that
 * runtime is enabled. A disabled scheduler must not accept wakeups that it
 * cannot own for the rest of the process lifetime.
 */
export function createDecisionWakeOriginAgent(
  wakeup: HeartbeatWakeup | null,
): DecisionServiceOptions["wakeOriginAgent"] {
  if (!wakeup) return async () => null;
  return async (input) => wakeup(input.agentId, {
    source: "automation",
    triggerDetail: "system",
    reason: `decision_${input.outcome}`,
    // The person who decided caused the continuation; an expiry has no person.
    causingActor: input.decidedByUserId ? { type: "user", userId: input.decidedByUserId } : SYSTEM_CAUSING_ACTOR,
    payload: {
      issueId: input.issueId,
      decisionId: input.decisionId,
      outcome: input.outcome,
    },
  });
}

export function createDecisionRetentionNotifyOriginAgent(
  wakeup: HeartbeatWakeup | null,
): (batch: ArchiveNotificationBatch) => Promise<unknown> {
  if (!wakeup) return async () => null;
  return async (batch) => wakeup(batch.agentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "attention_auto_archived",
    causingActor: SYSTEM_CAUSING_ACTOR,
    payload: {
      issueIds: [...new Set(batch.items.map((item) => item.issueId))],
      archives: batch.items.map((item) => ({
        sourceKind: item.sourceKind,
        sourceId: item.sourceId,
        archiveVersion: item.archiveVersion,
      })),
    },
  });
}
