/**
 * "Needs you" push trigger: fires when an issue becomes assigned to the owner.
 * - Subscribes to issue.updated and issue.created events.
 * - Checks if the assignee became the owner.
 * - Calls notifyOwner with class "needs_you" if the transition occurs.
 * - Uses upsertSeenAssignee to make the trigger idempotent across replays.
 */

import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { assignableUser } from "../constants.js";
import { getRoles } from "../db.js";
import { message, type Env } from "../env.js";
import { notifyOwner } from "./notify.js";
import { upsertSeenAssignee } from "./store.js";

/**
 * Handle issue.updated or issue.created: fire "needs_you" if assignee is now the owner.
 * - Fetches the issue and current owner.
 * - Checks if previous assignee != owner and current assignee == owner.
 * - Uses upsertSeenAssignee to prevent replays from firing twice.
 */
export async function onIssueNeedsYou(env: Env, event: PluginEvent, deps?: { deliver?: (ctx: any, companyId: string, subs: any[], payload: any, opts?: any) => Promise<void> }): Promise<void> {
  const companyId = event.companyId;
  const issueId = event.entityId;
  if (!companyId || !issueId) return;

  // Fetch the issue
  const issue = await env.ctx.issues.get(issueId, companyId).catch(() => null);
  if (!issue) return;

  // Get the owner user id
  const roles = await getRoles(env.ctx, companyId);
  const ownerUserId = assignableUser(roles?.ownerUserId ?? null);
  if (!ownerUserId) return;

  // Get the current assignee
  const currentAssignee = issue.assigneeUserId ?? null;

  // Update seen assignee and get the previous seen value (do this always for idempotency)
  const seenPrevious = await upsertSeenAssignee(env.ctx, companyId, issueId, currentAssignee);

  // If current assignee is not the owner, don't fire (but seen row is updated above)
  if (currentAssignee !== ownerUserId) return;

  // Get previous assignee (from event payload)
  const payload = event.payload as Record<string, unknown> | null;
  const previousFromEvent = payload?._previous && typeof payload._previous === "object" ? (payload._previous as Record<string, unknown>).assigneeUserId : undefined;
  const previousAssignee = typeof previousFromEvent === "string" ? previousFromEvent : previousFromEvent === null ? null : undefined;

  // Fire only if:
  // - When event carries _previous: BOTH event-previous and seenPrevious differ from owner (prevents replay double-fire)
  // - When no event previous: seenPrevious differs from owner
  let shouldFire = false;
  if (previousAssignee !== undefined) {
    shouldFire = previousAssignee !== ownerUserId && seenPrevious !== ownerUserId;
  } else {
    shouldFire = seenPrevious !== ownerUserId;
  }

  if (!shouldFire) return;

  // Build the push URL
  let config: Record<string, unknown> | undefined;
  try {
    const rawConfig = await env.ctx.config.get(companyId);
    if (rawConfig && typeof rawConfig === "object") {
      config = rawConfig as Record<string, unknown>;
    }
  } catch {
    config = undefined;
  }
  let publicBaseUrl = typeof config?.publicBaseUrl === "string" && config.publicBaseUrl ? config.publicBaseUrl : "https://paperclip.partnersinbiz.online";
  publicBaseUrl = publicBaseUrl.replace(/\/+$/, ""); // Remove trailing slashes

  // Extract PREFIX from IDENTIFIER (e.g., "PAR" from "PAR-3934")
  const identifier = issue.identifier ?? issueId;
  const prefix = identifier.includes("-") ? identifier.split("-")[0] : identifier;
  const url = `${publicBaseUrl}/${prefix}/issues/${identifier}`;

  // Fire the notification
  await notifyOwner(env.ctx, {
    companyId,
    class: "needs_you",
    title: issue.title ?? "Issue",
    body: `Needs you: ${identifier}`,
    issueRef: identifier,
    ownerUserId,
    url,
  }, { now: env.now, deliver: deps?.deliver });
}
