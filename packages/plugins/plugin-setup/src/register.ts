import type { PluginApiRequestInput, PluginApiResponse, PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { PIB_PLUGINS, pluginEvent } from "@partnersinbiz/pib-plugin-kit";
import { getChoice } from "./db.js";
import { SETUP_EVENTS } from "./kit-setup.js";
import { JOBS } from "./manifest.js";
import { SetupError } from "./modules.js";
import { loadSetup, message, onStatusEvent, reemitModules, refreshFinishIssue, rememberInstalled, saveModules, weeklyFinishSetup } from "./service.js";

/** Registers everything; exported for tests. */
export function registerSetup(ctx: PluginContext): void {
  for (const pluginKey of Object.values(PIB_PLUGINS)) {
    ctx.events.on(pluginEvent(pluginKey, SETUP_EVENTS.status), async (event) => {
      try {
        await onStatusEvent(ctx, pluginKey, event);
      } catch (error) {
        ctx.logger.info("Setup status projection failed", { pluginKey, error: message(error) });
      }
    });
  }
  ctx.actions.register("setup.load", (params, context) => loadSetup(ctx, requiredCompany(context), params));
  ctx.actions.register("setup.save-modules", async (params, context) => {
    const companyId = requiredCompany(context);
    if (context.actor.type !== "user" || !context.actor.userId) throw new SetupError("Only a board user can change the modules");
    if (params.installed) await rememberInstalled(ctx, params.installed);
    return saveModules(ctx, { companyId, modules: params.modules, userId: context.actor.userId });
  });
  ctx.actions.register("setup.refresh-issue", async (params, context) => {
    const companyId = requiredCompany(context);
    if (params.installed) await rememberInstalled(ctx, params.installed);
    return refreshFinishIssue(ctx, companyId, { allowCreate: true });
  });
  ctx.jobs.register(JOBS.reemitModules, async () => {
    const result = await reemitModules(ctx);
    if (result.emitted || result.failed) ctx.logger.info("Module switches re-sent", result);
  });
  ctx.jobs.register(JOBS.weeklyFinishSetup, async () => {
    ctx.logger.info("Weekly Finish setup", await weeklyFinishSetup(ctx));
  });
}

export async function handleApiRoute(ctx: PluginContext, input: PluginApiRequestInput): Promise<PluginApiResponse> {
  if (input.routeKey !== "modules") return { status: 404, body: { error: "Not found" } };
  try {
    const choice = await getChoice(ctx, input.companyId);
    return { status: 200, body: { modules: choice?.modules ?? null, updatedAt: choice?.updatedAt ?? null } };
  } catch (error) {
    ctx.logger.info("Setup modules route failed", { error: message(error) });
    return { status: 500, body: { error: message(error) } };
  }
}

function requiredCompany(context: PluginPerformActionContext): string {
  if (!context.companyId) throw new SetupError("Company is required");
  return context.companyId;
}
