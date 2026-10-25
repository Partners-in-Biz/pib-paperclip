/**
 * "Critical" push trigger: fires when system health reaches critical status.
 * - Fires when company health level is critical and is new or worse than remembered.
 * - Fires when 4 or more agents are in error status.
 * - Fires when agents require claude_auth_required re-login.
 * - Prevents repeat pushes for unchanged critical state.
 * - Resets memory when condition clears, so later re-occurrence fires again.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import { assignableUser } from "../constants.js";
import { getRoles } from "../db.js";
import type { NotifyOwnerDeps } from "./notify.js";
import { notifyOwner } from "./notify.js";
import { readCriticalLevel, upsertCriticalLevel } from "./store.js";

/**
 * Look up the assignable owner for a company.
 * Returns null if no owner is set or assignable.
 */
export async function resolveOwner(ctx: PluginContext, companyId: string): Promise<string | null> {
  const roles = await getRoles(ctx, companyId);
  return assignableUser(roles?.ownerUserId ?? null);
}

/**
 * Thin wrapper over notifyOwner with class "critical".
 * Can be called by other jobs (e.g., W1) to notify about critical issues.
 */
export async function notifyCritical(
  ctx: PluginContext,
  opts: {
    companyId: string;
    title: string;
    body: string;
    issueRef: string;
    url: string;
  },
  deps?: NotifyOwnerDeps,
): Promise<void> {
  // Look up owner to notify
  const ownerUserId = await resolveOwner(ctx, opts.companyId);
  if (!ownerUserId) return; // No owner, cannot notify

  await notifyOwner(
    ctx,
    {
      companyId: opts.companyId,
      class: "critical",
      title: opts.title,
      body: opts.body,
      issueRef: opts.issueRef,
      ownerUserId,
      url: opts.url,
    },
    deps,
  );
}

/**
 * Check critical conditions and fire notifications if new or worse.
 * Called once per company per hour from healthAlerts.
 *
 * Fires on three conditions:
 * 1. Health level is "bad" (critical) and is new or worse than remembered
 * 2. 4+ agents are in "error" status
 * 3. Agents are in "claude_auth_required" streak
 *
 * Wrapped in try/catch so a push failure is logged and never breaks the health alerts job.
 */
export async function checkCriticalTriggers(
  ctx: PluginContext,
  companyId: string,
  input: {
    agents: Array<{ status: string; id: string; name: string }>;
    authAgentIds: Set<string>;
    healthLevel: "ok" | "warn" | "bad";
    publicBaseUrl?: string;
  },
  deps?: NotifyOwnerDeps,
): Promise<number> {
  try {
    let notified = 0;

    // Get the owner for notifications
    const ownerUserId = await resolveOwner(ctx, companyId);
    if (!ownerUserId) return 0; // No owner, cannot notify

    // Helper: generate public URL
    const publicBaseUrl = input.publicBaseUrl || "https://paperclip.partnersinbiz.online";
    const cockpitUrl = `${publicBaseUrl.replace(/\/+$/, "")}/cockpit`;

    // Condition 1: Health level is "bad" and new or worse
    const levelKey = `critical:health:${companyId}`;
    const rememberedLevel = await readCriticalLevel(ctx, levelKey);
    // Map "ok" -> 0, "warn" -> 1, "bad" -> 2 for comparison
    const levelMap = { ok: 0, warn: 1, bad: 2 };
    const currentLevel = levelMap[input.healthLevel];
    const previousLevel = rememberedLevel !== null ? parseInt(rememberedLevel, 10) : -1;

    // Fire if level is critical and (new or worse)
    if (currentLevel === 2 && (previousLevel < 0 || currentLevel > previousLevel)) {
      await notifyOwner(ctx, {
        companyId,
        class: "critical",
        title: "System health critical",
        body: "Critical system health issues detected. Check the Cockpit.",
        issueRef: "critical:health",
        ownerUserId,
        url: cockpitUrl,
      }, deps);
      notified += 1;
      // Deliberate: send notification, then upsert (duplicate over silence if upsert fails)
      await upsertCriticalLevel(ctx, levelKey, String(currentLevel));
    } else if (currentLevel < 2 && previousLevel >= 0) {
      // Clear memory when condition clears (drops back below critical)
      await upsertCriticalLevel(ctx, levelKey, null);
    }

    // Condition 2: 4+ agents in error
    const errorCount = input.agents.filter((a) => a.status === "error").length;
    const agentErrorKey = `critical:agents:${companyId}`;
    const rememberedErrorCount = await readCriticalLevel(ctx, agentErrorKey);
    const previousErrorCount = rememberedErrorCount !== null ? parseInt(rememberedErrorCount, 10) : -1;

    // Fire if 4+ agents in error and (new or count increased)
    if (errorCount >= 4 && (previousErrorCount < 0 || errorCount > previousErrorCount)) {
      await notifyOwner(ctx, {
        companyId,
        class: "critical",
        title: `${errorCount} agents in error`,
        body: `${errorCount} agents have stopped with errors. Fix or resume them.`,
        issueRef: "critical:agents",
        ownerUserId,
        url: cockpitUrl,
      }, deps);
      notified += 1;
      // Deliberate: send notification, then upsert (duplicate over silence if upsert fails)
      await upsertCriticalLevel(ctx, agentErrorKey, String(errorCount));
    } else if (errorCount < 4 && previousErrorCount >= 0) {
      // Clear memory when error count drops below 4
      await upsertCriticalLevel(ctx, agentErrorKey, null);
    }

    // Condition 3: claude_auth_required streak
    const authKey = `critical:auth:${companyId}`;
    const rememberedAuthCount = await readCriticalLevel(ctx, authKey);
    const previousAuthCount = rememberedAuthCount !== null ? parseInt(rememberedAuthCount, 10) : -1;
    const currentAuthCount = input.authAgentIds.size;

    // Fire if auth agents present and (new or count increased).
    // Note: count comparison only, so one agent clearing while another starts keeps count unchanged (v1 limit).
    if (currentAuthCount > 0 && (previousAuthCount < 0 || currentAuthCount > previousAuthCount)) {
      const agentList = Array.from(input.authAgentIds)
        .slice(0, 3)
        .join(", ");
      await notifyOwner(ctx, {
        companyId,
        class: "critical",
        title: `${currentAuthCount} agents need re-login`,
        body: `Agents need Claude auth refresh: ${agentList}${currentAuthCount > 3 ? ", ..." : ""}`,
        issueRef: "critical:auth",
        ownerUserId,
        url: cockpitUrl,
      }, deps);
      notified += 1;
      // Deliberate: send notification, then upsert (duplicate over silence if upsert fails)
      await upsertCriticalLevel(ctx, authKey, String(currentAuthCount));
    } else if (currentAuthCount === 0 && previousAuthCount > 0) {
      // Clear memory when all auth agents clear
      await upsertCriticalLevel(ctx, authKey, null);
    }

    return notified;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.warn("critical triggers failed", { companyId, error: message });
    return 0;
  }
}
