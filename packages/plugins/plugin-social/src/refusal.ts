import type { PluginContext } from "@paperclipai/plugin-sdk";
import { SocialError } from "./domain.js";
import type { Viewer } from "./service.js";

type Handler = (ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) => Promise<unknown>;

/**
 * Actions where a person clicks a button and a rule can say no ("The Reviewer has
 * not passed this version yet", "A draft post cannot move to approved", "scheduled
 * time is in the past"). Those are expected answers, not worker faults. A thrown
 * error reaches the browser as a bare 502, which the host shows as "Paperclip is
 * temporarily unavailable"; returning it lets the page show the real reason.
 * Anything that is not a SocialError still throws.
 */
export const REFUSABLE_ACTIONS: ReadonlySet<string> = new Set([
  "social.review",
  "social.back-to-draft",
  "social.request-changes",
  "social.approve",
  "social.request-client-approval",
  "social.record-client-approval",
  "social.schedule",
  "social.unschedule",
  "social.retry-post",
  "social.update-post",
  "social.attach",
  "social.detach",
  "social.delete-post",
  "social.mark-posted",
  "social.mark-destination-posted",
  "social.skip-destination",
]);

export function refusalAsResult(handler: Handler): Handler {
  return async (ctx, viewer, params) => {
    try {
      return await handler(ctx, viewer, params);
    } catch (error) {
      if (error instanceof SocialError) return { ok: false, error: { code: "SOCIAL_RULE", message: error.message } };
      throw error;
    }
  };
}
