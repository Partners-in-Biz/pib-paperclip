/**
 * Edge watch registration: subscribes to issue.relations.updated
 * and provides handler for issue.updated for deduplication.
 */

import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { message, type Env } from "./env.js";
import { decideEdges, renderEdgeComment, shouldPostToIssue, edgeMarker, type EdgeCandidate } from "./edge-watch-model.js";

const IN_FLIGHT = new Set<string>();

/**
 * Ensures the cutoff time is seeded in plugin state (once per deploy/registration).
 * Seeds from the event's occurredAt time (minus 5 seconds for safety), falling back
 * to now minus 5 seconds if no event time is available. This ensures the first edge
 * created during the deployment is not skipped.
 */
export async function ensureEdgeWatchCutoff(env: Env, companyId: string, eventOccurredAt?: string): Promise<string> {
  const existing = await env.ctx.state.get({
    scopeKind: "company" as const,
    scopeId: companyId,
    namespace: "cockpit",
    stateKey: "edge-watch-since",
  });

  if (typeof existing === "string") {
    return existing;
  }

  // Seed from event time (minus 5 seconds) or now minus 5 seconds
  let seedTime = env.now();
  if (eventOccurredAt) {
    try {
      const eventTime = new Date(eventOccurredAt);
      seedTime = new Date(eventTime.getTime() - 5000); // 5 seconds before event
    } catch {
      // Fall back to now minus 5 seconds
      seedTime = new Date(env.now().getTime() - 5000);
    }
  } else {
    seedTime = new Date(env.now().getTime() - 5000);
  }

  const cutoff = seedTime.toISOString();
  await env.ctx.state.set(
    {
      scopeKind: "company" as const,
      scopeId: companyId,
      namespace: "cockpit",
      stateKey: "edge-watch-since",
    },
    cutoff,
  );

  return cutoff;
}

/**
 * Handles issue.relations.updated event (blocker edge creation/update).
 * Reads the blocker edges from issue_relations and decides which to announce.
 */
export async function onEdgeRelationsUpdated(env: Env, event: PluginEvent): Promise<void> {
  const companyId = event.companyId;
  if (!companyId) return;

  const payload = event.payload as Record<string, unknown> | null;
  if (!payload) return;

  // Get the blocked issue ID from entityId (the issue whose relations changed)
  const blockedId = event.entityId;
  if (!blockedId) return;

  // Read the config
  const config = await env.ctx.config.get(companyId);
  const enabled = (config?.edgeWatch as Record<string, unknown> | undefined)?.enabled !== false;

  if (!enabled) return;

  // Get the cutoff time, seeding from the event's time on first occurrence
  const cutoff = await ensureEdgeWatchCutoff(env, companyId, event.occurredAt);

  // Get list of blocker IDs from the event (new ones)
  const blockedByIssueIds = Array.isArray(payload.blockedByIssueIds) ? (payload.blockedByIssueIds as string[]) : [];

  if (blockedByIssueIds.length === 0) return;

  // Query the blocked issue to get its status and info
  const blockedIssue = await env.ctx.issues.get(blockedId, companyId);
  if (!blockedIssue || ["done", "cancelled"].includes(blockedIssue.status)) return;

  // Query issue_relations for new edges (created after cutoff)
  const edges = await env.ctx.db.query<Record<string, unknown>>(
    `SELECT r.issue_id AS blocker_id, r.created_at,
            b.identifier AS blocker_identifier, b.status AS blocker_status,
            b.assignee_agent_id, b.assignee_user_id
       FROM public.issue_relations r
       JOIN public.issues b ON b.id = r.issue_id AND b.company_id = r.company_id
      WHERE r.company_id = $1 AND r.related_issue_id = $2 AND r.type = 'blocks'
        AND r.created_at >= $3::timestamptz`,
    [companyId, blockedId, cutoff],
  );

  if (edges.length === 0) return;

  // Build candidates from edges
  const candidates: EdgeCandidate[] = edges.map((e) => ({
    blockedId,
    blockedIdentifier: blockedIssue.identifier ?? null,
    blockedStatus: blockedIssue.status,
    blockerId: String(e.blocker_id),
    blockerIdentifier: e.blocker_identifier ? String(e.blocker_identifier) : null,
    blockerStatus: String(e.blocker_status),
    blockerAssigneeAgentId: e.assignee_agent_id ? String(e.assignee_agent_id) : null,
    blockerAssigneeUserId: e.assignee_user_id ? String(e.assignee_user_id) : null,
    createdAt: String(e.created_at),
  }));

  // Decide which edges to announce
  const edgesToAnnounce = decideEdges(candidates, { cutoff, enabled });

  // Post comments for each edge (to both blocked and blocker issues)
  for (const edge of edgesToAnnounce) {
    const marker = edgeMarker(edge.blockedId, edge.blockerId)

    // Skip if already in flight (dedup in-process)
    if (IN_FLIGHT.has(marker)) continue;

    IN_FLIGHT.add(marker);

    try {
      // Get blocker issue info
      const blockerIssue = await env.ctx.issues.get(edge.blockerId, companyId);
      if (!blockerIssue) continue;

      // Check for marker on blocked issue.
      // listComments is limited to 500 comments per the host; sufficient for marker deduplication.
      const blockedComments = await env.ctx.issues.listComments(edge.blockedId, companyId);
      if (shouldPostToIssue(blockedComments, edge.blockedId, edge.blockerId)) {
        const body = renderEdgeComment(
          edge.blockedId,
          blockedIssue.identifier ?? null,
          edge.blockerId,
          blockerIssue.identifier ?? null,
          blockerIssue.assigneeAgentId ?? null,
          blockerIssue.assigneeUserId ?? null,
        );

        await env.ctx.issues.createComment(edge.blockedId, body, companyId).catch((error) => {
          env.ctx.logger.info("Edge watch: could not post comment on blocked issue", { blockedId: edge.blockedId, blockerId: edge.blockerId, error: message(error) });
        });
      }

      // Check for marker on blocker issue
      const blockerComments = await env.ctx.issues.listComments(edge.blockerId, companyId);
      if (shouldPostToIssue(blockerComments, edge.blockedId, edge.blockerId)) {
        const blockedRef = blockedIssue.identifier ?? edge.blockedId;
        const blockerRef = blockerIssue.identifier ?? edge.blockerId;

        const body = `${blockerRef} is now blocking ${blockedRef} (${blockedRef} is waiting for this). If the blocker only needs the engineering work, ${blockedRef} can proceed in parallel.

${marker}`;

        await env.ctx.issues.createComment(edge.blockerId, body, companyId).catch((error) => {
          env.ctx.logger.info("Edge watch: could not post comment on blocker issue", { blockedId: edge.blockedId, blockerId: edge.blockerId, error: message(error) });
        });
      }
    } finally {
      IN_FLIGHT.delete(marker);
    }
  }
}

/**
 * Registers the edge-watch feature (only subscribes to issue.relations.updated).
 */
export function registerW1cEdge(env: Env): void {
  env.ctx.events.on("issue.relations.updated", async (event) => {
    try {
      await onEdgeRelationsUpdated(env, event);
    } catch (error) {
      env.ctx.logger.info("Edge watch: relation update handler failed", { companyId: event.companyId, error: message(error) });
    }
  });
}
