import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import { liveSessionAction, statusAction, transcribeAction } from "./actions.js";

/** Outbound calls go through the host client so its http.outbound policy and audit apply. */
function hostFetch(ctx: PluginContext): typeof fetch {
  return ((input, init) => ctx.http.fetch(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init)) as typeof fetch;
}

const plugin = definePlugin({
  async setup(ctx) {
    // The host puts the authorized company on params; a caller cannot widen it.
    ctx.data.register("status", async (params) =>
      statusAction(ctx, typeof params.companyId === "string" ? params.companyId : null),
    );
    ctx.actions.register("transcribe", (params, context) => transcribeAction(ctx, params, context, hostFetch(ctx)));
    ctx.actions.register("live-session", (_params, context) => liveSessionAction(ctx, context, hostFetch(ctx)));
  },

  async onHealth() {
    return { status: "ok", message: "Voice ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
