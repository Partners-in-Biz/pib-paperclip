import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { createAccessGuard } from "@partnersinbiz/pib-plugin-kit";
import { ACCESS_TABLE } from "./access-table.js";
import { agentVoiceData, liveSessionAction, setAgentVoiceAction, statusAction, transcribeAction } from "./actions.js";
import { PLUGIN_ID } from "./namespace.js";
import { outboundFetch } from "./outbound.js";

const plugin = definePlugin({
  async setup(ctx) {
    // Every action goes through the access guard (PAR-12678); it also receives the grants Setup sends.
    // With the switch off (every company today) it is a pass-through.
    const guard = createAccessGuard(ctx, { pluginKey: PLUGIN_ID, table: ACCESS_TABLE });
    // The two data handlers carry no caller, so the guard cannot check them; they stay as they are (spec 4.4, S13).
    // The host puts the authorized company on params; a caller cannot widen it.
    ctx.data.register("status", async (params) =>
      statusAction(ctx, typeof params.companyId === "string" ? params.companyId : null),
    );
    guard.action("transcribe", (params, context) => transcribeAction(ctx, params, context, outboundFetch(ctx)));
    ctx.data.register("agent-voice", async (params) =>
      agentVoiceData(ctx, typeof params.companyId === "string" ? params.companyId : null, params.agentId),
    );
    guard.action("live-session", (params, context) => liveSessionAction(ctx, context, outboundFetch(ctx), params));
    guard.action("set-agent-voice", (params, context) => setAgentVoiceAction(ctx, params, context));
  },

  async onHealth() {
    return { status: "ok", message: "Voice ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
