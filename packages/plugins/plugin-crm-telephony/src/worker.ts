import { definePlugin, runWorker, type ToolRunContext } from "@paperclipai/plugin-sdk";
import { readSettings, secretStatus } from "./settings.js";
import { TELEPHONY_TOOLS } from "./tools.js";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.jobs.register("media-pipeline", async () => {
      ctx.logger.debug("media-pipeline job running");
      // Real pipeline handlers come in PR1b+
    });

    for (const tool of TELEPHONY_TOOLS) {
      ctx.tools.register(tool.name, tool, async (_params, run: ToolRunContext) => {
        const settings = await readSettings(ctx, run.companyId);
        const status = await secretStatus(ctx, run.companyId, []);
        return { data: { settings, secrets: status } };
      });
    }
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
