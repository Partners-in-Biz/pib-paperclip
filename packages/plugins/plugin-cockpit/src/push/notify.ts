/**
 * Push notification dispatcher: decision engine and delivery.
 * Orchestrates the policy decision, delivery to subscriptions, and logging.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import { decide, type PolicyClass } from "./policy.js";
import { appendPushLog, listRecentPushLog, listSubscriptionsForUser, type PushSubscription } from "./store.js";
import { sendPush, type SendDeps } from "./send.js";

export type NotifyOutcome = "sent" | "deferred" | "capped" | "duplicate" | "no_subscription" | "collapsed";

export interface NotifyResult {
  outcome: NotifyOutcome;
}

export interface NotifyOwnerDeps {
  /** Send notifications to subscriptions (default: use sendPush). */
  deliver?: (ctx: PluginContext, companyId: string, subs: PushSubscription[], payload: { title: string; body: string; url: string; tag: string; class: PolicyClass }, opts?: SendDeps) => Promise<void>;
  /** Current time (default: new Date). */
  now?: () => Date;
}

/**
 * Notify the owner of an issue update.
 * - Reads recent log (last 24h) for policy decision.
 * - Applies policy (critical/quiet/duplicate/cap/window).
 * - Delivers to owner's subscriptions or logs the decision.
 * - Appends push log entry.
 * Returns the outcome: "sent" if delivered, "no_subscription" if no subscriptions,
 * "deferred" during quiet hours, "duplicate" within 6h, "capped" by daily limit,
 * or "collapsed" when multiple notifications are grouped with a collapse summary.
 */
export async function notifyOwner(
  ctx: PluginContext,
  opts: {
    companyId: string;
    class: PolicyClass;
    title: string;
    body: string;
    issueRef: string;
    ownerUserId: string;
    url: string;
  },
  deps?: NotifyOwnerDeps,
): Promise<NotifyResult> {
  const now = (deps?.now ?? (() => new Date()))();
  const deliver = deps?.deliver ?? defaultDeliver;

  // Read recent log for policy decision
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const recentLog = await listRecentPushLog(ctx, opts.companyId, since24h);

  // Decide based on policy
  const decision = decide({
    class: opts.class,
    issueRef: opts.issueRef,
    now,
    recentLog,
  });

  // Apply the decision
  if (decision.action === "send") {
    // Get owner's subscriptions
    const subs = await listSubscriptionsForUser(ctx, opts.companyId, opts.ownerUserId);
    // Filter to ok subscriptions only
    const okSubs = subs.filter((s) => s.state === "ok");

    if (okSubs.length > 0) {
      // Deliver to owner
      // Note: the deliver function (default sendPush) handles its own logging of "sent".
      // Do not log here to avoid double-logging.
      await deliver(ctx, opts.companyId, okSubs, {
        title: opts.title,
        body: opts.body,
        url: opts.url,
        tag: opts.issueRef,
        class: opts.class,
      });
      return { outcome: "sent" };
    } else {
      return { outcome: "no_subscription" };
    }
  } else if (decision.action === "defer") {
    await appendPushLog(ctx, {
      companyId: opts.companyId,
      class: opts.class,
      issueRef: opts.issueRef,
      title: opts.title,
      status: "deferred",
      createdAt: now,
    });
    return { outcome: "deferred" };
  } else if (decision.action === "drop") {
    const reason = decision.reason === "duplicate" ? "dropped" : "capped";
    await appendPushLog(ctx, {
      companyId: opts.companyId,
      class: opts.class,
      issueRef: opts.issueRef,
      title: opts.title,
      status: reason,
      createdAt: now,
    });
    return { outcome: decision.reason === "duplicate" ? "duplicate" : "capped" };
  } else {
    // Collapse: log with status "collapsed"
    await appendPushLog(ctx, {
      companyId: opts.companyId,
      class: opts.class,
      issueRef: opts.issueRef,
      title: opts.title,
      status: "collapsed",
      createdAt: now,
    });
    // If notify is true, deliver the collapse notification
    if (decision.notify) {
      const subs = await listSubscriptionsForUser(ctx, opts.companyId, opts.ownerUserId);
      const okSubs = subs.filter((s) => s.state === "ok");
      if (okSubs.length > 0) {
        // Deliver collapse notification.
        await deliver(ctx, opts.companyId, okSubs, {
          title: opts.title,
          body: `${opts.body} (+ ${decision.n - 1} more)`,
          url: opts.url,
          tag: opts.issueRef,
          class: "collapse",
        });
        return { outcome: "collapsed" };
      } else {
        return { outcome: "no_subscription" };
      }
    }
    return { outcome: "capped" };
  }
}

/** Default delivery: use production sendPush. */
async function defaultDeliver(
  ctx: PluginContext,
  companyId: string,
  subs: PushSubscription[],
  payload: { title: string; body: string; url: string; tag: string; class: PolicyClass },
): Promise<void> {
  await sendPush(ctx, companyId, subs, payload, { class: payload.class });
}
