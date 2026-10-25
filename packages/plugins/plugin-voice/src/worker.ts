import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { liveSessionAction, statusAction, transcribeAction } from "./actions.js";
import { outboundFetch } from "./outbound.js";

const plugin = definePlugin({
  async setup(ctx) {
    // The host puts the authorized company on params; a caller cannot widen it.
    ctx.data.register("status", async (params) =>
      statusAction(ctx, typeof params.companyId === "string" ? params.companyId : null),
    );
    ctx.actions.register("transcribe", (params, context) => transcribeAction(ctx, params, context, outboundFetch(ctx)));
    ctx.actions.register("live-session", (_params, context) => liveSessionAction(ctx, context, outboundFetch(ctx)));
  },

  async onHealth() {
    return { status: "ok", message: "Voice ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
