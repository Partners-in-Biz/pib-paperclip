/**
 * Overnight push digest job: if any push_log rows with status 'deferred' exist
 * created since 22:00 SAST, send ONE push titled "N items waited overnight"
 * and mark those rows 'collapsed'. Idempotent: a second run finds no deferred rows.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import { getOvernightWindow, getSastTime } from "./policy.js";
import { appendPushLog, listDeferredSince, listSubscriptionsForCompany, updatePushLogStatus } from "./store.js";
import { sendPush, type SendDeps } from "./send.js";

export interface PushDigestDeps {
  send?: typeof sendPush;
  now?: () => Date;
}

/**
 * Run the overnight digest job for a single company.
 * Returns true if a digest was sent, false if no deferred rows or send was skipped.
 */
export async function runPushDigestForCompany(
  ctx: PluginContext,
  companyId: string,
  opts: { deps?: PushDigestDeps } = {},
): Promise<boolean> {
  const send = opts.deps?.send ?? sendPush;
  const now = (opts.deps?.now ?? (() => new Date()))();

  // Find the window start (most recent 22:00 SAST before now)
  const windowStart = getOvernightWindow(now);

  // List all deferred rows created since the window start
  const deferredRows = await listDeferredSince(ctx, companyId, windowStart);

  if (deferredRows.length === 0) {
    return false; // No deferred items, nothing to do
  }

  // Get all subscriptions for the company
  const subs = await listSubscriptionsForCompany(ctx, companyId);

  if (subs.length === 0) {
    return false; // No subscriptions, can't send
  }

  // Build the digest payload
  const count = deferredRows.length;
  const payload = {
    title: `${count} item${count === 1 ? "" : "s"} waited overnight`,
    body: "Items waiting for you to review",
    url: "/cockpit",
    tag: "digest",
    class: "digest" as const,
  };

  // Send the digest
  const result = await send(ctx, companyId, subs, payload, {
    class: "digest",
    deps: {
      postPush: opts.deps?.send ? undefined : undefined,
      now: () => now,
    },
  });

  // Only mark rows as collapsed if the push actually reached at least one device
  if (result.disabled || result.capped || result.devices.length === 0) {
    return false; // Push was not sent successfully
  }

  // Check if any device was actually reached
  const sentAny = result.devices.some((d) => d.outcome === "sent");
  if (!sentAny) {
    return false; // No devices received the push
  }

  // Mark the deferred rows as collapsed
  const deferredIds = deferredRows.map((r) => r.id);
  await updatePushLogStatus(ctx, companyId, deferredIds, "collapsed");

  // Note: appendPushLog is already called by sendPush with status='sent'
  // so we don't need to call it again

  return true;
}

/**
 * Run the digest job: iterate over all companies, collecting errors per company.
 * Returns a summary of sent digests and errors.
 */
export async function runPushDigest(ctx: PluginContext, now?: () => Date): Promise<Record<string, number>> {
  // Get all companies by reading from the heartbeat_companies table
  const companies = await ctx.db.query<{ company_id: string }>(
    `SELECT DISTINCT company_id FROM heartbeat_runs`,
    [],
  );

  const companyIds = [...new Set(companies.map((row) => String(row.company_id)))];

  const summary: Record<string, number> = { sent: 0, skipped: 0, failed: 0 };

  for (const companyId of companyIds) {
    try {
      const sent = await runPushDigestForCompany(ctx, companyId, { deps: { now } });
      if (sent) {
        summary.sent = (summary.sent ?? 0) + 1;
      } else {
        summary.skipped = (summary.skipped ?? 0) + 1;
      }
    } catch (err) {
      ctx.logger.error(`Push digest failed for company ${companyId}`, { error: String(err) });
      summary.failed = (summary.failed ?? 0) + 1;
    }
  }

  return summary;
}
