import { definePlugin, runWorker, type PluginPerformActionContext, type ToolRunContext } from "@paperclipai/plugin-sdk";
import { DEFAULT_SETTINGS, normalizeSettings, secretStatus, validateSettings } from "./settings.js";
import { TELEPHONY_TOOLS } from "./tools.js";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.jobs.register("media-pipeline", async () => {
      ctx.logger.debug("media-pipeline job running");
      // Real pipeline handlers come in PR1b+
    });

    /**
     * Read current telephony settings and secret status.
     * Returns stored settings and boolean presence status for configured secrets.
     * No actor check: read-only, agents and users can both read status.
     */
    ctx.actions.register("telephony.settings.get", async (_params, context) => {
      const companyId = requiredCompany(context);
      const stored = await ctx.state.get({ scopeKind: "company", scopeId: companyId, stateKey: "settings" });
      const settings = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;

      // Check presence of configured secrets
      const secretRefs = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET", "TWILIO_TWIML_APP_SID", "DEEPGRAM_API_KEY", "SMS_PROVIDER_KEY"];
      const secretsStatus = await secretStatus(ctx, companyId, secretRefs);

      return {
        settings: normalizeSettings(settings),
        secretsStatus,
      };
    });

    /**
     * Save telephony settings.
     * Requires a user actor (not agent) for security.
     * Preserves templateSyncRequestedAt timestamp if it exists.
     */
    ctx.actions.register("telephony.settings.save", async (params, context) => {
      const companyId = requiredCompany(context);
      const userId = requiredUser(context);

      const raw = objectParams(params);
      const errors = validateSettings(raw);

      if (errors.length > 0) {
        return { ok: false, errors };
      }

      const stored = (await ctx.state.get({ scopeKind: "company", scopeId: companyId, stateKey: "settings" })) as Record<string, unknown> | null;
      const syncRequestedAt = stored && typeof stored === "object" ? (stored.templateSyncRequestedAt as string | undefined) : undefined;

      const normalized = normalizeSettings(raw);
      const toStore = {
        ...normalized,
        ...(syncRequestedAt ? { templateSyncRequestedAt: syncRequestedAt } : {}),
      };

      await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: "settings" }, toStore);
      return { ok: true };
    });

    /**
     * Record a request to sync message templates from Twilio.
     * Requires a user actor (not agent) for security.
     * Records the timestamp and returns immediately; actual sync happens async via job.
     */
    ctx.actions.register("telephony.settings.sync-templates", async (_params, context) => {
      const companyId = requiredCompany(context);
      const userId = requiredUser(context);

      const timestamp = new Date().toISOString();

      const stored = (await ctx.state.get({ scopeKind: "company", scopeId: companyId, stateKey: "settings" })) as Record<string, unknown> | null;
      const current = stored && typeof stored === "object" ? stored : { ...DEFAULT_SETTINGS };

      await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: "settings" }, {
        ...current,
        templateSyncRequestedAt: timestamp,
      });

      return { ok: true, syncRequestedAt: timestamp };
    });

    // Register tools that return status
    for (const tool of TELEPHONY_TOOLS) {
      ctx.tools.register(tool.name, tool, async (_params, run: ToolRunContext) => {
        const companyId = run.companyId;
        const stored = await ctx.state.get({ scopeKind: "company", scopeId: companyId, stateKey: "settings" });
        const settings = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
        const normalized = normalizeSettings(settings);

        // Check presence of configured secrets (never return values)
        const secretRefs = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET", "TWILIO_TWIML_APP_SID", "DEEPGRAM_API_KEY", "SMS_PROVIDER_KEY"];
        const secretsStatus = await secretStatus(ctx, companyId, secretRefs);

        return { data: { settings: normalized, secretsStatus } };
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

/**
 * Require a company to be set in the action context.
 */
function requiredCompany(context: PluginPerformActionContext): string {
  if (!context.companyId) throw new Error("Company is required");
  return context.companyId;
}

/**
 * Require the actor to be a user (not an agent).
 * Users have context.actor.type === "user" and userId is populated.
 */
function requiredUser(context: PluginPerformActionContext): string {
  if (context.actor.type !== "user") throw new Error("User is required; agents cannot modify settings");
  const userId = context.actor.userId;
  if (!userId) throw new Error("User ID is required");
  return userId;
}

/**
 * Coerce params to object shape.
 */
function objectParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Parameters must be an object");
  return value as Record<string, unknown>;
}

export default plugin;
runWorker(plugin, import.meta.url);
