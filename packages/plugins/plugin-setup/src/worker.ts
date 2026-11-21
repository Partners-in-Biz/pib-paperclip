import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { AccessGuard } from "@partnersinbiz/pib-plugin-kit";
import { registerSetup } from "./register.js";
import { backfillEntitlements } from "./service.js";
import { resendAllAccess } from "./access-sync.js";

/** The access guard: every action, tool and API route goes through it (`./access-table.ts`). */
let guard: AccessGuard | null = null;

const plugin = definePlugin({
  async setup(ctx) {
    guard = registerSetup(ctx);
    // Entitle every company that exists now to everything, once (the hourly job retries a failure).
    try {
      const backfill = await backfillEntitlements(ctx);
      if (!backfill.alreadyDone) ctx.logger.info("Entitlements backfilled", backfill);
    } catch (error) {
      ctx.logger.warn("Entitlement backfill failed; companies stay unlocked until it succeeds", { error: error instanceof Error ? error.message : String(error) });
    }
    // Send every company's access state once (a plugin may have missed a change while Setup was down). Not awaited.
    void resendAllAccess(ctx).then(
      (result) => (result.sent || result.skipped || result.failed) && ctx.logger.info("Access sent at start", result),
      (error: unknown) => ctx.logger.info("Access send at start failed", { error: error instanceof Error ? error.message : String(error) }),
    );
    ctx.logger.info("Setup plugin ready");
  },
  async onHealth() {
    return { status: "ok", message: "Setup plugin ready" };
  },
  // Settings changes need no restart: every read goes to the host.
  async onConfigChanged() {},
  async onApiRequest(input) {
    if (!guard) return { status: 503, body: { error: "Setup plugin is not ready" } };
    return guard.handleApiRequest(input);
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
