import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import { handleApiRoute, registerSetup } from "./register.js";
import { backfillEntitlements } from "./service.js";

let pluginCtx: PluginContext | null = null;

const plugin = definePlugin({
  async setup(ctx) {
    pluginCtx = ctx;
    registerSetup(ctx);
    // Entitle every company that exists now to everything, once (the hourly job retries a failure).
    try {
      const backfill = await backfillEntitlements(ctx);
      if (!backfill.alreadyDone) ctx.logger.info("Entitlements backfilled", backfill);
    } catch (error) {
      ctx.logger.warn("Entitlement backfill failed; companies stay unlocked until it succeeds", { error: error instanceof Error ? error.message : String(error) });
    }
    ctx.logger.info("Setup plugin ready");
  },
  async onHealth() {
    return { status: "ok", message: "Setup plugin ready" };
  },
  // Settings changes need no restart: every read goes to the host.
  async onConfigChanged() {},
  async onApiRequest(input) {
    if (!pluginCtx) return { status: 503, body: { error: "Setup plugin is not ready" } };
    return handleApiRoute(pluginCtx, input);
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
