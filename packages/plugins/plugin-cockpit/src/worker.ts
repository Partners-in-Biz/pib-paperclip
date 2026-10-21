import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { Env } from "./env.js";
import { handleApiRoute, registerCockpit } from "./register.js";

let env: Env | null = null;

const plugin = definePlugin({
  async setup(ctx) {
    env = registerCockpit(ctx);
    ctx.logger.info("Cockpit plugin ready");
  },
  async onHealth() {
    return { status: "ok", message: "Cockpit plugin ready" };
  },
  // Settings changes need no restart: every read goes to the host.
  async onConfigChanged() {},
  async onApiRequest(input) {
    if (!env) return { status: 503, body: { error: "Cockpit plugin is not ready" } };
    return handleApiRoute(env, input);
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
