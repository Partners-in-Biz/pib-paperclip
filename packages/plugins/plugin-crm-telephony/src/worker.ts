import { definePlugin, runWorker, type PluginContext, type PluginWebhookInput, type ToolRunContext } from "@paperclipai/plugin-sdk";
import { readSettings, secretStatus } from "./settings.js";
import { TELEPHONY_TOOLS } from "./tools.js";
import { handleWaInbound, handleWaStatus } from "./whatsapp.js";
import { PLUGIN_ID, NAMESPACE } from "./namespace.js";
import { syncTemplates, listPickerTemplates } from "./templates.js";

let ctx: PluginContext | null = null;

function requireCtx(): PluginContext {
  if (!ctx) throw new Error("Plugin context not initialized");
  return ctx;
}

/**
 * Build a Twilio client and resolve secrets for the company.
 * Returns null if required secrets are missing.
 */
async function buildTwilioClientForSecrets(
  pluginCtx: PluginContext,
  companyId: string,
  requiredSecrets: string[],
): Promise<{
  client: any;
  secrets: Record<string, string>;
} | null> {
  const secrets: Record<string, string> = {};

  for (const secretName of requiredSecrets) {
    try {
      const value = await pluginCtx.secrets.resolve(secretName, { companyId });
      if (!value) {
        return null;
      }
      secrets[secretName] = value;
    } catch {
      return null;
    }
  }

  // Import and create the Twilio client
  const { createTwilioClient } = await import("./twilio-client.js");
  const client = createTwilioClient({
    accountSid: secrets.TWILIO_ACCOUNT_SID,
    authToken: secrets.TWILIO_AUTH_TOKEN,
    fetch: pluginCtx.http.fetch,
  });

  return { client, secrets };
}

const plugin = definePlugin({
  async setup(pluginCtx) {
    ctx = pluginCtx;

    pluginCtx.jobs.register("media-pipeline", async () => {
      pluginCtx.logger.debug("media-pipeline job running");
      // Real pipeline handlers come in PR1b+
    });

    // Register tools with their handlers
    const toolHandlers: Record<
      string,
      (params: unknown, run: ToolRunContext) => Promise<{ content?: string; data?: unknown; error?: string }>
    > = {
      "telephony-status": async (_params, run: ToolRunContext) => {
        const settings = await readSettings(pluginCtx, run.companyId);
        const status = await secretStatus(pluginCtx, run.companyId, []);
        return { data: { settings, secrets: status } };
      },

      "whatsapp-templates": async (
        params: unknown,
        run: ToolRunContext,
      ) => {
        const p = params as { language?: string } | null;
        const language = p?.language as "af" | "en" | undefined;

        const templates = await listPickerTemplates(pluginCtx.db, NAMESPACE, run.companyId, { language });
        return {
          data: {
            templates: templates.map((t) => ({
              id: t.id,
              name: t.name,
              language: t.language,
              preview: t.bodyPreview,
            })),
            count: templates.length,
          },
        };
      },

      "whatsapp-sync-templates": async (
        _params: unknown,
        run: ToolRunContext,
      ) => {
        const requiredSecrets = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"];
        const result = await buildTwilioClientForSecrets(pluginCtx, run.companyId, requiredSecrets);

        if (!result) {
          return {
            error: `Missing required secrets: ${requiredSecrets.join(", ")}`,
          };
        }

        const syncResult = await syncTemplates({
          db: pluginCtx.db,
          namespace: NAMESPACE,
          client: result.client,
          companyId: run.companyId,
          agentId: run.agentId,
        });

        if (syncResult.error) {
          return {
            error: `Sync failed: ${syncResult.error}`,
          };
        }

        return {
          data: {
            created: syncResult.created,
            updated: syncResult.updated,
            approved: syncResult.approved,
            unchanged: syncResult.unchanged,
            skipped: syncResult.skipped,
          },
        };
      },
    };

    // Register all tools
    for (const tool of TELEPHONY_TOOLS) {
      const handler = toolHandlers[tool.name];
      if (!handler) {
        throw new Error(`No handler registered for tool: ${tool.name}`);
      }
      pluginCtx.tools.register(tool.name, tool, handler);
    }
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

    // Other endpoints: acknowledge and return
  },

  async onHealth() {
    return { status: "ok", message: "CRM Telephony plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
