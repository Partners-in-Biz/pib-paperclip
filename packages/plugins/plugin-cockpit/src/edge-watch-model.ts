/**
 * Edge watch: pure logic for deciding which blocker edges to announce.
 * Rules: skip if disabled; skip edge with created_at < cutoff (only edges created after deploy count);
 * skip terminal blocked issue (status done/cancelled); skip blocker already terminal; skip agent-assigned blocker;
 * dedupe if marker already present in comments of the blocked issue.
 */

export interface EdgeCandidate {
  blockedId: string;
  blockedIdentifier: string | null;
  blockedStatus: string;
  blockerId: string;
  blockerIdentifier: string | null;
  blockerStatus: string;
  blockerAssigneeAgentId: string | null;
  blockerAssigneeUserId: string | null;
  createdAt: string;
}

export interface EdgeMarkerComment {
  id: string;
  body: string;
}

export interface EdgeToAnnounce {
  blockedId: string;
  blockerId: string;
}

export function edgeMarker(blockedId: string, blockerId: string): string {
  return `<!-- edge-watch:${blockedId}-${blockerId} -->`;
}

export function decideEdges(
  candidates: EdgeCandidate[],
  options: {
    cutoff: string; // ISO timestamp
    enabled: boolean;
  },
): EdgeToAnnounce[] {
  if (!options.enabled) return [];

  const cutoffTime = Date.parse(options.cutoff);
  const result: EdgeToAnnounce[] = [];

  for (const edge of candidates) {
    // Skip if edge is older than cutoff
    if (Date.parse(edge.createdAt) < cutoffTime) continue;

    // Skip terminal blocked issue
    if (["done", "cancelled"].includes(edge.blockedStatus)) continue;

    // Skip terminal blocker
    if (["done", "cancelled"].includes(edge.blockerStatus)) continue;

    // Skip agent-assigned blocker (only user-assigned or unassigned matter)
    if (edge.blockerAssigneeAgentId !== null) continue;

    result.push({
      blockedId: edge.blockedId,
      blockerId: edge.blockerId,
    });
  }

  return result;
}

export function renderEdgeComment(
  blockedId: string,
  blockedIdentifier: string | null,
  blockerId: string,
  blockerIdentifier: string | null,
  blockerAssigneeAgentId: string | null,
  blockerAssigneeUserId: string | null,
): string {
  const blockedRef = blockedIdentifier ?? blockedId;
  const blockerRef = blockerIdentifier ?? blockerId;

  const assigneeStatus =
    blockerAssigneeUserId !== null
      ? "waiting on a person (owner-assigned)"
      : "unassigned";

  return `This issue will now wait for ${blockerRef} (${blockedRef} is blocked by it). The blocker is ${assigneeStatus}. Remove this edge if ${blockedRef} only needs the engineering part of the blocker and can proceed in parallel.

${edgeMarker(blockedId, blockerId)}`;
}

export function shouldPostToIssue(
  comments: EdgeMarkerComment[],
  blockedId: string,
  blockerId: string,
): boolean {
  const marker = edgeMarker(blockedId, blockerId);
  return !comments.some((c) => c.body.includes(marker));
}
