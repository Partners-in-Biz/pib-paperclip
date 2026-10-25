import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { readSettings, saveSettings, settingsView, requestTemplateSync } from "./settings.js";

function requiredCompany(context: PluginPerformActionContext): string {
  if (!context.companyId) throw new Error("Company is required");
  return context.companyId;
}

function requiredUser(context: PluginPerformActionContext): string {
  if (context.actor.type !== "user" || !context.actor.userId) {
    throw new Error("This action is for board users");
  }
  return context.actor.userId;
}

export function registerSettingsActions(ctx: PluginContext): void {
  ctx.actions.register("telephony.settings.get", async (_params, context) => {
    const companyId = requiredCompany(context);
    return settingsView(ctx, companyId);
  });

  ctx.actions.register("telephony.settings.save", async (params, context) => {
    const companyId = requiredCompany(context);
    requiredUser(context);
    return saveSettings(ctx, companyId, params);
  });

  ctx.actions.register("telephony.settings.sync-templates", async (_params, context) => {
    const companyId = requiredCompany(context);
    const userId = requiredUser(context);
    return requestTemplateSync(ctx, companyId, userId);
  });
}
