import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.jobs.register("media-pipeline", async () => {
      ctx.logger.debug("media-pipeline job running");
      // Real pipeline handlers come in PR1b+
    });
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
