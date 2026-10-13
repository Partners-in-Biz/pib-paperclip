import { definePlugin, runWorker, type PluginContext, type ToolResult, type ToolRunContext } from "@paperclipai/plugin-sdk";
import manifest from "./manifest.js";
import { readSettings, secretStatus } from "./settings.js";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.tools.register("telephony-status", manifest.tools![0]!, async (_params, run) => {
      return runTelephonyStatus(ctx, run);
    });

    ctx.jobs.register("media-pipeline", async () => {
      ctx.logger.debug("media-pipeline job running");
      // Real pipeline handlers come in PR1b+
    });
  },

  async onWebhook(input) {
    // Webhook handlers come in PR1b+; acknowledge and return
  },

  async onHealth() {
    return { status: "ok", message: "CRM Telephony plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);

async function runTelephonyStatus(ctx: PluginContext, run: ToolRunContext): Promise<ToolResult> {
  try {
    const settings = await readSettings(ctx, run.companyId);
    const secrets = await secretStatus(ctx, run.companyId, settings);
    return {
      content: "Telephony settings retrieved",
      data: {
        settings: {
          recordingEnabled: settings.recordingEnabled,
          whatsappEnabled: settings.whatsappEnabled,
          smsEnabled: settings.smsEnabled,
          maxCallsPerDay: settings.maxCallsPerDay,
          maxMessagesPerDay: settings.maxMessagesPerDay,
          allowedHours: settings.allowedHours,
          callerIds: settings.callerIds,
        },
        secretStatus: secrets,
      },
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Failed to retrieve telephony status",
    };
  }
}
