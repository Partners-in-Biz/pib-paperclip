import { definePlugin, runWorker, type PluginContext, type PluginWebhookInput, type ToolRunContext, type PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { registerCrmProjection } from "@partnersinbiz/pib-plugin-kit";
import { readSettings, secretStatus } from "./settings.js";
import { registerSettingsActions } from "./settings-actions.js";
import { TELEPHONY_SECRET_NAMES } from "./secret-names.js";
import { TELEPHONY_TOOLS } from "./tools.js";
import { handleWaInbound, handleWaStatus } from "./whatsapp.js";
import { handleRecordingStatus } from "./recording-intake.js";
import { PLUGIN_ID, NAMESPACE } from "./namespace.js";
import { runMediaPipeline } from "./pipeline.js";
import { createMediaSteps } from "./media-steps.js";
import { voiceTokenAction } from "./voice-token-action.js";
import { makeTranscribeStep } from "./transcribe.js";
import { makeSummariseStep } from "./summarise.js";
import { makeNoteStep, registerNoteAck, sweepUnackedNotes } from "./note.js";
import { registerTimelineHandlers } from "./timeline-handlers.js";
import { syncTemplates, listPickerTemplates } from "./templates.js";
import { normalizeE164 } from "./phone.js";

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
  const status = await secretStatus(pluginCtx, run.companyId, [...TELEPHONY_SECRET_NAMES]);
  return { data: { settings, secrets: status } };
}

/**
 * Build a Twilio client from the company's secrets.
 * Returns null if a required secret is missing.
 */
async function buildTwilioClientForSecrets(
  pluginCtx: PluginContext,
  companyId: string,
  requiredSecrets: string[],
) {
  const secrets: Record<string, string> = {};
  for (const secretName of requiredSecrets) {
    try {
      const value = await pluginCtx.secrets.resolve(secretName, { companyId });
      if (!value) return null;
      secrets[secretName] = value;
    } catch {
      return null;
    }
  }

  const { createTwilioClient } = await import("./twilio-client.js");
  const client = createTwilioClient({
    accountSid: secrets.TWILIO_ACCOUNT_SID,
    authToken: secrets.TWILIO_AUTH_TOKEN,
    fetch: pluginCtx.http.fetch,
  });
  return { client, secrets };
}

const toolHandlers: Record<
  string,
  (pluginCtx: PluginContext, params: unknown, run: ToolRunContext) => Promise<{ content?: string; data?: unknown; error?: string }>
> = {
  "telephony-status": telephonyToolHandler,

  "whatsapp-templates": async (pluginCtx, params, run) => {
    const p = params as { language?: string } | null;
    const language = p?.language as "af" | "en" | undefined;
    const templates = await listPickerTemplates(pluginCtx.db, NAMESPACE, run.companyId, { language });
    return {
      data: {
        templates: templates.map((t) => ({ id: t.id, name: t.name, language: t.language, preview: t.bodyPreview })),
        count: templates.length,
      },
    };
  },

  "whatsapp-sync-templates": async (pluginCtx, _params, run) => {
    const requiredSecrets = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"];
    const result = await buildTwilioClientForSecrets(pluginCtx, run.companyId, requiredSecrets);
    if (!result) return { error: `Missing required secrets: ${requiredSecrets.join(", ")}` };

    const syncResult = await syncTemplates({
      db: pluginCtx.db,
      namespace: NAMESPACE,
      client: result.client,
      companyId: run.companyId,
      agentId: run.agentId,
    });
    if (syncResult.error) return { error: `Sync failed: ${syncResult.error}` };

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
  "whatsapp-send": async (pluginCtx, params, run) => {
    const p = params as {
      contactId?: string;
      toE164: string;
      kind?: string;
      body?: string;
      templateId?: string;
      variables?: string[];
    } | null;
    if (!p?.toE164) return { error: "toE164 is required" };

    const e164 = normalizeE164(p.toE164);
    if (!e164) return { error: `Invalid phone number: ${p.toE164}` };

    const requiredSecrets = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_WHATSAPP_FROM"];
    const result = await buildTwilioClientForSecrets(pluginCtx, run.companyId, requiredSecrets);
    if (!result) return { error: `Missing required secrets: ${requiredSecrets.join(", ")}` };

    const settings = await readSettings(pluginCtx, run.companyId);
    const { sendWhatsapp } = await import("./whatsapp-send.js");
    const variablesRecord = p.variables
      ? Object.fromEntries(p.variables.map((v, i) => [`${i}`, v]))
      : undefined;

    const sendResult = await sendWhatsapp(
      {
        db: pluginCtx.db,
        namespace: NAMESPACE,
        client: result.client,
        settings,
        fromWhatsapp: result.secrets.TWILIO_WHATSAPP_FROM,
        statusCallbackUrl: undefined,
        now: () => new Date(),
      },
      {
        companyId: run.companyId,
        userId: run.agentId,
        contactId: p.contactId || null,
        toE164: e164,
        kind: (p.kind as "service" | "marketing") || "service",
        body: p.body,
        templateId: p.templateId,
        variables: variablesRecord,
      },
    );
    if (!sendResult.sent) return { error: `Send failed: ${sendResult.reason}` };

    return {
      data: { sent: true, messageId: sendResult.messageId, providerMessageId: sendResult.providerMsgId },
    };
  },
};

const plugin = definePlugin({
  async setup(pluginCtx) {
    ctx = pluginCtx;

    registerCrmProjection(pluginCtx, pluginCtx.db.namespace, { companies: false, contacts: true });

    // Register settings actions
    registerSettingsActions(pluginCtx);

    // Register call note ack listener
    registerNoteAck(pluginCtx);

    pluginCtx.jobs.register("media-pipeline", async () => {
      // Build pipeline steps: media recording -> transcribe -> summarise -> note
      const audioUrlStub = async () => {
        throw new Error("audioUrl presign not configured: R2 infrastructure not yet deployed");
      };

      const steps = {
        ...createMediaSteps(),
        twilio_deleted: makeTranscribeStep({ audioUrl: audioUrlStub }),
        transcribed: makeSummariseStep(),
        summarised: makeNoteStep(),
      };

      const result = await runMediaPipeline(pluginCtx, { steps, namespace: NAMESPACE });
      pluginCtx.logger.debug(`media-pipeline: processed=${result.processed} failed=${result.failed} dead=${result.dead} abandoned=${result.abandoned} issuesRaised=${result.issuesRaised}`);

      // Sweep un-acked notes for re-emission
      try {
        const sweepResult = await sweepUnackedNotes(pluginCtx, NAMESPACE);
        if (sweepResult.reemitted > 0 || sweepResult.gaveUp > 0) {
          pluginCtx.logger.debug(`note-sweep: reemitted=${sweepResult.reemitted} gaveUp=${sweepResult.gaveUp}`);
        }
      } catch (err) {
        pluginCtx.logger.debug(`note-sweep failed: ${err}`);
      }
    });

    for (const tool of TELEPHONY_TOOLS) {
      const handler = toolHandlers[tool.name];
      if (!handler) throw new Error(`No handler registered for tool: ${tool.name}`);
      pluginCtx.tools.register(tool.name, tool, (params, run) => handler(pluginCtx, params, run));
    }

    pluginCtx.actions.register("voice-token", async (_params, context: PluginPerformActionContext) => {
      return voiceTokenAction(pluginCtx, context);
    });

    await registerTimelineHandlers(pluginCtx);
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
