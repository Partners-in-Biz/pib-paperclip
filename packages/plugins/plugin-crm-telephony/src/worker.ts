import { definePlugin, runWorker, type PluginContext, type PluginWebhookInput, type ToolRunContext, type PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { registerCrmProjection } from "@partnersinbiz/pib-plugin-kit";
import { readSettings, secretStatus } from "./settings.js";
import { TELEPHONY_TOOLS } from "./tools.js";
import { handleWaInbound, handleWaStatus } from "./whatsapp.js";
import { handleRecordingStatus } from "./recording-intake.js";
import { PLUGIN_ID, NAMESPACE } from "./namespace.js";
import { runMediaPipeline } from "./pipeline.js";
import { voiceTokenAction } from "./voice-token-action.js";

let ctx: PluginContext | null = null;

function requireCtx(): PluginContext {
  if (!ctx) throw new Error("Plugin context not initialized");
  return ctx;
}

export async function telephonyToolHandler(
  pluginCtx: PluginContext,
  _params: unknown,
  run: ToolRunContext,
) {
  const settings = await readSettings(pluginCtx, run.companyId);
  const status = await secretStatus(pluginCtx, run.companyId, []);
  return { data: { settings, secrets: status } };
}

const plugin = definePlugin({
  async setup(pluginCtx) {
    ctx = pluginCtx;

    registerCrmProjection(pluginCtx, pluginCtx.db.namespace, { companies: false, contacts: true });

    pluginCtx.jobs.register("media-pipeline", async () => {
      const result = await runMediaPipeline(pluginCtx);
      pluginCtx.logger.debug(`media-pipeline: processed=${result.processed} failed=${result.failed} dead=${result.dead} abandoned=${result.abandoned} issuesRaised=${result.issuesRaised}`);
    });

    for (const tool of TELEPHONY_TOOLS) {
      pluginCtx.tools.register(tool.name, tool, (params, run) =>
        telephonyToolHandler(pluginCtx, params, run),
      );
    }

    pluginCtx.actions.register("voice-token", async (_params, context: PluginPerformActionContext) => {
      return voiceTokenAction(pluginCtx, context);
    });
  },

  async onWebhook(input: PluginWebhookInput) {
    const { endpointKey } = input;
    const pluginCtx = requireCtx();

    // Dispatch to handlers by endpoint key
    if (endpointKey === "wa-inbound") {
      await handleWaInbound(pluginCtx, pluginCtx.db, NAMESPACE, input, PLUGIN_ID);
      return;
    }

    if (endpointKey === "wa-status") {
      await handleWaStatus(pluginCtx, pluginCtx.db, NAMESPACE, input, PLUGIN_ID);
      return;
    }

    if (endpointKey === "recording-status") {
      await handleRecordingStatus(pluginCtx, pluginCtx.db, NAMESPACE, input, PLUGIN_ID);
      return;
    }

    // Other endpoints: acknowledge and return
  },

  async onHealth() {
    return { status: "ok", message: "CRM Telephony plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
