/**
 * Routine failures: detect when managed routines fail to create work, wake
 * the assignee on first failure, and escalate on the second distinct failure.
 */

import { createWorkIssue, escalate, routineHealth } from "@partnersinbiz/pib-plugin-kit";
import { ORIGIN, ORIGIN_ID } from "./constants.js";
import { message, type Env } from "./env.js";

export interface RoutineFailureTickCounts {
  routine_wake: number;
  routine_escalated: number;
}

interface StoredFailure {
  count: number;
  since: string;
  issueId: string;
}

/** Internal state key for routine failures tracking. */
function routineFailureStateKey(companyId: string) {
  return {
    scopeKind: "company" as const,
    scopeId: companyId,
    namespace: "cockpit",
    stateKey: `routine-failures:${companyId}`,
  };
}

/**
 * Hourly job: detect routine failures, wake on first failure, escalate on second.
 * Wraps each routine in its own try/catch so one failure does not stop the others.
 */
export async function routineFailureTick(env: Env, companyId: string): Promise<RoutineFailureTickCounts> {
  const counts: RoutineFailureTickCounts = {
    routine_wake: 0,
    routine_escalated: 0,
  };

  const now = env.now();

  // Get all routine health checks (only "bad" status ones are included in the result)
  const checks = await routineHealth(env.ctx, companyId);
  const stateKey = routineFailureStateKey(companyId);
  const stored = (await env.ctx.state.get(stateKey)) as Record<string, StoredFailure> | null;
  const current = new Map<string, StoredFailure>(Object.entries(stored ?? {}));

  // Process each failed routine
  for (const check of checks) {
    // Extract routine key from check.key (format: "routine:<routineKey>")
    if (!check.key.startsWith("routine:")) continue;
    const routineKey = check.key.slice("routine:".length);

    try {
      // Get routine details (assignee, id, title)
      const found = await env.ctx.routines?.managed?.get?.(routineKey, companyId);
      if (!found?.routine) {
        env.ctx.logger.info("Routine not found", { companyId, routineKey });
        continue;
      }

      const routine = found.routine;
      const routineId = found.routineId ?? routine.id ?? null;
      const assignee = routine.assigneeAgentId ?? null;
      const title = routine.title ?? routineKey;
      const since = check.since ?? now.toISOString();

      // Check if we have a stored entry for this routine
      const entry = current.get(routineKey);

      if (entry && entry.since === since) {
        // Same failure, no re-wake or re-escalate
        continue;
      }

      // New failure (different since) or first time seeing it
      const newCount = (entry?.count ?? 0) + 1;

      if (newCount === 1) {
        // First failure: wake the assignee
        try {
          const originId = `${ORIGIN_ID.routineFailure}${routineKey}:${since}`;
          const created = await createWorkIssue(env.ctx, {
            companyId,
            title: `${title} failed its last run`,
            description: check.detail ?? `The routine "${title}" fired but failed to create any work.`,
            priority: "high",
            originKind: ORIGIN.routineFailure as `plugin:${string}`,
            originId,
            ...(assignee ? { assigneeAgentId: assignee } : {}),
            wake: !!assignee,
            wakeReason: `Routine "${title}" failed`,
          });

          current.set(routineKey, {
            count: 1,
            since,
            issueId: created.id,
          });

          counts.routine_wake += 1;
        } catch (error) {
          env.ctx.logger.info("Routine failure issue creation failed", {
            companyId,
            routineKey,
            error: message(error),
          });
          // Don't store the entry if creation failed; next tick will retry
        }
      } else if (newCount >= 2) {
        // Second or later failure: escalate
        if (!entry?.issueId) {
          // Should not happen, but safety check
          env.ctx.logger.info("No issue to escalate for routine failure", { companyId, routineKey });
          continue;
        }

        try {
          await escalate(env.ctx, entry.issueId, "routine_failed", { companyId, now });

          current.set(routineKey, {
            count: newCount,
            since,
            issueId: entry.issueId,
          });

          counts.routine_escalated += 1;
        } catch (error) {
          env.ctx.logger.info("Routine failure escalation failed", {
            companyId,
            routineKey,
            issueId: entry.issueId,
            error: message(error),
          });
        }
      }
    } catch (error) {
      env.ctx.logger.info("Routine failure check failed", {
        companyId,
        routineKey,
        error: message(error),
      });
    }
  }

  // Remove entries for routines that are no longer failing (healthy)
  const failingKeys = new Set(checks.filter((c) => c.key.startsWith("routine:")).map((c) => c.key.slice("routine:".length)));
  for (const key of current.keys()) {
    if (!failingKeys.has(key)) {
      current.delete(key);
    }
  }

  // Store updated state
  if (current.size > 0) {
    await env.ctx.state.set(stateKey, Object.fromEntries(current));
  } else {
    await env.ctx.state.set(stateKey, null);
  }

  return counts;
}
