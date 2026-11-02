import type { PluginContext } from "@paperclipai/plugin-sdk";
import { GrowthError } from "@partnersinbiz/pib-plugin-kit";
import type { Viewer } from "../service.js";

type Handler = (ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) => Promise<unknown> | unknown;

/**
 * Growth Lab rules ("3 experiments are already running", "already decided") are
 * expected outcomes, not worker faults. A thrown error reaches the browser as a
 * bare 502; returning it lets the page show the real message. Anything else
 * still throws.
 */
export function growthAction(handler: Handler): (ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) => Promise<unknown> {
  return async (ctx, viewer, params) => {
    try {
      return await handler(ctx, viewer, params);
    } catch (error) {
      if (error instanceof GrowthError) return { ok: false, error: { code: "GROWTH_RULE", message: error.message } };
      throw error;
    }
  };
}
