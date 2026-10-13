import { definePlugin, runWorker, type ToolRunContext, type PluginApiRequestInput, type PluginApiResponse, type PluginContext } from "@paperclipai/plugin-sdk";
import { readSettings, secretStatus } from "./settings.js";
import { handleApiRequest } from "./routes.js";
import { TELEPHONY_TOOLS } from "./tools.js";

let ctx: PluginContext | null = null;

const plugin = definePlugin({
  async setup(pluginCtx) {
    ctx = pluginCtx;

    pluginCtx.jobs.register("media-pipeline", async () => {
      pluginCtx.logger.debug("media-pipeline job running");
      // Real pipeline handlers come in PR1b+
    });

    for (const tool of TELEPHONY_TOOLS) {
      pluginCtx.tools.register(tool.name, tool, async (_params, run: ToolRunContext) => {
        const settings = await readSettings(pluginCtx, run.companyId);
        const status = await secretStatus(pluginCtx, run.companyId, []);
        return { data: { settings, secrets: status } };
      });
    }
  },

  async onApiRequest(input: PluginApiRequestInput): Promise<PluginApiResponse> {
    if (!ctx) {
      return { status: 503, body: { error: "Telephony plugin is not ready" } };
    }
    return await handleApiRequest(ctx, input);
  },

  async onWebhook() {
    // Webhook handlers come in PR1b+; acknowledge and return
  },

  async onHealth() {
    return { status: "ok", message: "CRM Telephony plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
