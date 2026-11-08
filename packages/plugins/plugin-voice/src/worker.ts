import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { agentVoiceData, liveSessionAction, setAgentVoiceAction, statusAction, transcribeAction } from "./actions.js";
import { outboundFetch } from "./outbound.js";

const plugin = definePlugin({
  async setup(ctx) {
    // The host puts the authorized company on params; a caller cannot widen it.
    ctx.data.register("status", async (params) =>
      statusAction(ctx, typeof params.companyId === "string" ? params.companyId : null),
    );
    ctx.actions.register("transcribe", (params, context) => transcribeAction(ctx, params, context, outboundFetch(ctx)));
    ctx.data.register("agent-voice", async (params) =>
      agentVoiceData(ctx, typeof params.companyId === "string" ? params.companyId : null, params.agentId),
    );
    ctx.actions.register("live-session", (params, context) => liveSessionAction(ctx, context, outboundFetch(ctx), params));
    ctx.actions.register("set-agent-voice", (params, context) => setAgentVoiceAction(ctx, params, context));
  },

  async onHealth() {
    return { status: "ok", message: "Voice ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
