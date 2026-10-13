import { definePlugin, runWorker, type PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { readConfig, SecretResolver } from "@partnersinbiz/pib-plugin-kit";
import { DEFAULT_SETTINGS, normalizeSettings, validateSettings } from "./settings.js";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.jobs.register("media-pipeline", async () => {
      ctx.logger.debug("media-pipeline job running");
      // Real pipeline handlers come in PR1b+
    });

    ctx.actions.register("telephony.settings.get", async (_params, context) => {
      const companyId = requiredCompany(context);
      const stored = await ctx.state.get({ scopeKind: "company", scopeId: companyId, stateKey: "settings" });
      const settings = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
      const config = await readConfig(ctx, companyId);
      const secrets = new SecretResolver(ctx, companyId, config);

      const secretPresence = await Promise.all(
        ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET", "TWILIO_TWIML_APP_SID", "DEEPGRAM_API_KEY", "SMS_PROVIDER_KEY"].map(
          async (key) => ({ key, set: !!(await secrets.get(key)) }),
        ),
      );

      return {
        settings: normalizeSettings(settings),
        secretPresence,
      };
    });

    ctx.actions.register("telephony.settings.save", async (params, context) => {
      const companyId = requiredCompany(context);
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

    ctx.actions.register("telephony.settings.sync-templates", async (_params, context) => {
      const companyId = requiredCompany(context);
      const timestamp = new Date().toISOString();

      const stored = (await ctx.state.get({ scopeKind: "company", scopeId: companyId, stateKey: "settings" })) as Record<string, unknown> | null;
      const current = stored && typeof stored === "object" ? stored : { ...DEFAULT_SETTINGS };

      await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: "settings" }, {
        ...current,
        templateSyncRequestedAt: timestamp,
      });

      return { ok: true, syncRequestedAt: timestamp };
    });
  },

  async onWebhook() {
    // Webhook handlers come in PR1b+; acknowledge and return
  },

  async onHealth() {
    return { status: "ok", message: "CRM Telephony plugin ready" };
  },
});

function requiredCompany(context: PluginPerformActionContext): string {
  if (!context.companyId) throw new Error("Company is required");
  return context.companyId;
}

function objectParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Parameters must be an object");
  return value as Record<string, unknown>;
}

export default plugin;
runWorker(plugin, import.meta.url);
