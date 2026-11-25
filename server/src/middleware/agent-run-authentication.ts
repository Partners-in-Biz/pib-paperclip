import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { captureRunIdentity } from "../services/run-identity.js";

export function loadAgentRunAuthentication(db: Db, input: {
  runId: string;
  companyId: string;
  agentId: string;
}) {
  return db.select({
    activeIdentityContextId: heartbeatRuns.activeIdentityContextId,
    responsibleUserId: heartbeatRuns.responsibleUserId,
    status: heartbeatRuns.status,
    resultJson: sql<Record<string, unknown>>`jsonb_build_object(
      'executionCancellation', jsonb_build_object(
        'state', ${heartbeatRuns.resultJson}->'executionCancellation'->'state'
      )
    )`,
    contextSnapshot: sql<Record<string, unknown>>`jsonb_build_object(
      'conversationMode', ${heartbeatRuns.contextSnapshot}->'conversationMode'
    )`,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, input.runId),
    eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.agentId, input.agentId),
  ));
}

/**
 * C40 (PAR-12608): a run with an active identity context works for that
 * context's person, captured fresh. Sign-in and the plugin tool gate both read
 * the run's person through this, so the two cannot drift. A run without one
 * keeps its row's person (sign-in then prefers the token's claim).
 */
export async function refreshRunIdentityPerson(
  db: Db,
  input: { runId: string; companyId: string; agentId: string },
  run: { activeIdentityContextId: string | null; responsibleUserId: string | null; status: string } | undefined,
): Promise<void> {
  if (!run?.activeIdentityContextId || run.status !== "running") return;
  const captured = await captureRunIdentity(db, input, { readScope: "request_authentication" });
  run.activeIdentityContextId = captured.context?.id ?? null;
  run.responsibleUserId = captured.context?.responsibleUserId ?? null;
}
