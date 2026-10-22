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
import { voiceTokenAction } from "./voice-token-action.js";
import { makeTranscribeStep } from "./transcribe.js";
import { makeSummariseStep } from "./summarise.js";
import { makeNoteStep, registerNoteAck, sweepUnackedNotes } from "./note.js";
import { registerTimelineHandlers } from "./timeline-handlers.js";

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
      pluginCtx.tools.register(tool.name, tool, (params, run) =>
        telephonyToolHandler(pluginCtx, params, run),
      );
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
