import { and, desc, eq } from "drizzle-orm";
import { agentWakeupRequests, type Db } from "@paperclipai/db";
import type { UnblockOwnerWakeOptions } from "./routable-blocked.js";

/**
 * The `wakeup` for deliverAgentUnblockNotification (routes/issues.ts).
 * PAR-9390: enqueueWakeup returns null both for a skip and for a deferred
 * wake, so read the receipt by idempotency key. PAR-10086: the receipt's
 * runId tells whether a run exists for the wake (isRunBackedWakeResult).
 */
export function createUnblockOwnerWakeup(input: {
  db: Db;
  heartbeat: {
    wakeup: (agentId: string, options: UnblockOwnerWakeOptions) => Promise<{ id: string } | null>;
  };
  companyId: string;
}) {
  const { db, heartbeat, companyId } = input;
  return async (agentId: string, options: UnblockOwnerWakeOptions) => {
    const run = await heartbeat.wakeup(agentId, options);
    if (run) return run;
    const [receipt] = await db
      .select({ status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.idempotencyKey, options.idempotencyKey),
        ),
      )
      .orderBy(desc(agentWakeupRequests.requestedAt))
      .limit(1);
    return receipt ?? null;
  };
}
