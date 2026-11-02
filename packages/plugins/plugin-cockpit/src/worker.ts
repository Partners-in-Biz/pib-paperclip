import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { registerDriveReplies } from "@partnersinbiz/pib-plugin-kit";
import type { Env } from "./env.js";
import { GITHUB_CI_ENDPOINT, handleGithubCi } from "./webhooks/github-ci.js";
import { handleApiRoute, registerCockpit } from "./register.js";

let env: Env | null = null;

const plugin = definePlugin({
  async setup(ctx) {
    registerDriveReplies(ctx);
    env = registerCockpit(ctx);
    ctx.logger.info("Cockpit plugin ready");
  },
  async onHealth() {
    return { status: "ok", message: "Cockpit plugin ready" };
  },
  // Settings changes need no restart: every read goes to the host.
  async onConfigChanged() {},
  async onWebhook(input) {
    if (input.endpointKey !== GITHUB_CI_ENDPOINT) throw new Error(`Unknown webhook endpoint ${input.endpointKey}`);
    if (!env) throw new Error("Cockpit plugin is not ready; GitHub will send this again.");
    const result = await handleGithubCi(env.ctx, input, env.now());
    // The host maps any throw to HTTP 502 and GitHub retries 502, so a refused delivery (bad signature) is logged and
    // returned as handled: a retry could never succeed. Only real failures (no env, a failed post) throw.
    if (result.status !== 200) env.ctx.logger.warn("GitHub CI webhook refused", { status: result.status, outcome: result.outcome });
  },
  async onApiRequest(input) {
    if (!env) return { status: 503, body: { error: "Cockpit plugin is not ready" } };
    return handleApiRoute(env, input);
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
