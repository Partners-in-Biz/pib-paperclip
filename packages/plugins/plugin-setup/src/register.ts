import type { PluginApiRequestInput, PluginApiResponse, PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { PIB_PLUGINS, pluginEvent, registerCompanyBootstrap } from "@partnersinbiz/pib-plugin-kit";
import { getChoice } from "./db.js";
import { SETUP_EVENTS } from "./kit-setup.js";
import { JOBS } from "./manifest.js";
import { SetupError } from "./modules.js";
import { PLUGIN_ID } from "./namespace.js";
import { approveStarterPack, bootstrapCompany, loadNewCompany, recordStep, rememberNewCompany, startTemplateHire, starterPackForImport, templateDraft, templatesForOps } from "./new-company.js";
import { loadSetup, message, onStatusEvent, reemitModules, refreshFinishIssue, rememberInstalled, reportMemory, reportStatuses, saveModules, weeklyFinishSetup } from "./service.js";

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
  // The Setup page reports what it read from LLM Wiki (Company wiki).
  ctx.actions.register("setup.report-memory", async (params, context) => {
    const companyId = requiredCompany(context);
    if (context.actor.type !== "user") throw new SetupError("Only the Setup page can report Company wiki");
    return { status: await reportMemory(ctx, companyId, params.snapshot) };
  });
  // The Setup page reports the statuses it just checked live, so every count agrees with the page.
  ctx.actions.register("setup.report-statuses", async (params, context) => {
    const companyId = requiredCompany(context);
    if (context.actor.type !== "user") throw new SetupError("Only the Setup page can report setup statuses");
    return reportStatuses(ctx, companyId, params.statuses);
  });
  registerNewCompany(ctx);
  ctx.jobs.register(JOBS.reemitModules, async () => {
    const result = await reemitModules(ctx);
    if (result.emitted || result.failed) ctx.logger.info("Module switches re-sent", result);
    // Host rule: a job acts only for a company whose Setup settings are saved. Say so instead of skipping silently (Q7-7).
    if (result.skipped) ctx.logger.info("Companies skipped because Setup's settings are not saved (New company saves them)", { skipped: result.skipped });
  });
  ctx.jobs.register(JOBS.weeklyFinishSetup, async () => {
    ctx.logger.info("Weekly Finish setup", await weeklyFinishSetup(ctx));
  });
}

/**
 * Setup -> New company: one `company.created` wiring for the plugin (kit
 * `registerCompanyBootstrap`: remembers the company, opens the owner's "Set up
 * <company>" issue once, catches up lazily), and the actions behind the page's
 * New company section. All of them need a board user except reading the state.
 */
function registerNewCompany(ctx: PluginContext): void {
  registerCompanyBootstrap(ctx, {
    ownerIssue: { originKind: `plugin:${PLUGIN_ID}` },
    onBootstrap: (companyId, source) => rememberNewCompany(ctx, companyId, source),
  });
  const user = (context: PluginPerformActionContext): string => {
    if (context.actor.type !== "user" || !context.actor.userId) throw new SetupError("Only a board user can do this");
    return context.actor.userId;
  };
  const optionsOf = (params: Record<string, unknown>) => (params.options && typeof params.options === "object" ? params.options : {});
  // The starter pack's facts go to people only (they read them to approve); an agent gets the run state and the counts.
  ctx.actions.register("setup.new-company", async (_params, context) => loadNewCompany(ctx, requiredCompany(context), { includeFacts: context.actor.type === "user" }));
  ctx.actions.register("setup.bootstrap-company", async (params, context) => {
    const companyId = requiredCompany(context);
    const userId = user(context);
    if (params.installed) await rememberInstalled(ctx, params.installed);
    return bootstrapCompany(ctx, { companyId, userId, options: optionsOf(params) });
  });
  ctx.actions.register("setup.bootstrap-record", async (params, context) => {
    const companyId = requiredCompany(context);
    return recordStep(ctx, { companyId, userId: user(context), stepId: params.stepId, status: params.status, detail: params.detail, items: params.items, grants: params.grants, starterImport: params.starterImport });
  });
  ctx.actions.register("setup.template-draft", async (params, context) => {
    const companyId = requiredCompany(context);
    user(context);
    return templateDraft(ctx, { companyId, key: params.key, agents: params.agents, ceo: params.ceo, ownerName: params.ownerName, wikiRoot: params.wikiRoot });
  });
  ctx.actions.register("setup.start-template-hire", async (params, context) => {
    const companyId = requiredCompany(context);
    return startTemplateHire(ctx, {
      companyId,
      userId: user(context),
      key: params.key,
      agents: params.agents,
      ceo: params.ceo,
      ownerName: params.ownerName,
      wikiRoot: params.wikiRoot,
      assigneeAgentId: params.assigneeAgentId,
      assigneeUserId: params.assigneeUserId,
    });
  });
  ctx.actions.register("setup.approve-starter-pack", async (params, context) => approveStarterPack(ctx, { userId: user(context), hash: params.hash }));
  ctx.actions.register("setup.starter-pack-import", async (_params, context) => {
    requiredCompany(context);
    user(context);
    return starterPackForImport(ctx);
  });
}

export async function handleApiRoute(ctx: PluginContext, input: PluginApiRequestInput): Promise<PluginApiResponse> {
  // GET /templates?companyId=: the team template pack and every kit role's run profile, rendered for the company. The ops scripts read it, so none keeps a copy.
  if (input.routeKey === "templates") {
    try {
      return { status: 200, body: await templatesForOps(ctx, { companyId: input.companyId, key: "ceo" }) };
    } catch (error) {
      ctx.logger.info("Setup templates route failed", { error: message(error) });
      return { status: 500, body: { error: message(error) } };
    }
  }
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
