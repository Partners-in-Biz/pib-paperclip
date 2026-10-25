import type { PluginApiRequestInput, PluginApiResponse, PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { PIB_PLUGINS, pluginEvent, registerCompanyBootstrap } from "@partnersinbiz/pib-plugin-kit";
import { DRIVE_BINDING_EVENT } from "./drive-checklist.js";
import { isCompanyAdmin, isOperatorAdmin } from "./access.js";
import { operatorDowngrade } from "./entitlements.js";
import { SETUP_EVENTS } from "./kit-setup.js";
import { JOBS } from "./manifest.js";
import { effectiveModules, ForbiddenError, SetupError } from "./modules.js";
import { PLUGIN_ID } from "./namespace.js";
import { approveStarterPack, bootstrapCompany, isOwnerCompany, loadNewCompany, recordStep, rememberNewCompany, startTemplateHire, starterPackForImport, templateDraft, templatesForOps } from "./new-company.js";
import { registerTemplateTools } from "./template-tools.js";
import { backfillEntitlements, loadSetup, message, moduleView, setEntitlements, onDriveBind, onDriveBindingEvent, onStatusEvent, reemitModules, refreshFinishIssue, rememberInstalled, reportMemory, reportStatuses, saveModules, weeklyFinishSetup } from "./service.js";

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
  // Listen to CRM's drive.binding event to track Google Drive setup state
  ctx.events.on(pluginEvent(PIB_PLUGINS.crm, DRIVE_BINDING_EVENT), async (event) => {
    try {
      await onDriveBindingEvent(ctx, event);
    } catch (error) {
      ctx.logger.info("Setup drive binding event failed", { error: message(error) });
    }
  });
  registerTemplateTools(ctx);
  ctx.actions.register("setup.load", (params, context) => loadSetup(ctx, requiredCompany(context), params));
  ctx.actions.register("setup.save-modules", (params, context) =>
    refusable(async () => {
      const companyId = requiredCompany(context);
      if (context.actor.type !== "user" || !context.actor.userId) throw new SetupError("Only a board user can change the modules");
      // Only an owner or admin of this company, or of ours (the operator), may change what a company runs.
      if (!(await isCompanyAdmin(ctx, companyId, context.actor.userId)) && !(await isOperatorAdmin(ctx, context.actor.userId))) {
        throw new ForbiddenError("Only a company owner or admin can change the modules");
      }
      if (params.installed) await rememberInstalled(ctx, params.installed);
      return { ok: true, ...(await saveModules(ctx, { companyId, modules: params.modules, userId: context.actor.userId })) };
    }),
  );
  // What a company bought. Only an owner or admin of the operator company (ours) may write it, from that company's
  // own page: the host does not pass an instance-admin flag to plugin actions, so a client's own owner is refused.
  // The host overwrites `params.companyId` with the page's company, so the company to change is `params.targetCompanyId`.
  ctx.actions.register("setup.set-entitlements", (params, context) =>
    refusable(async () => {
      if (context.actor.type !== "user" || !context.actor.userId) throw new ForbiddenError("Only a board user can set entitlements");
      if (!(await isOperatorAdmin(ctx, context.actor.userId))) throw new ForbiddenError("Only an owner or admin of the operator company can set entitlements, and only from that company's own page (the host scopes member lookups to the company the action runs for)");
      const pageCompanyId = requiredCompany(context);
      const companyId = typeof params.targetCompanyId === "string" ? params.targetCompanyId.trim() : "";
      if (!companyId) throw new SetupError("targetCompanyId is required: the company whose plan to set (the host replaces companyId with the page's company)");
      // The operator company is always on the full plan; nobody downgrades it, not even by naming it.
      // (The host may hide another company's settings from this page, so the page's own company is checked by id.)
      if (await isOwnerCompany(ctx, companyId) || (companyId === pageCompanyId && (await isOwnerCompany(ctx, pageCompanyId)))) {
        const problem = operatorDowngrade(params.plan, params.modules);
        if (problem) throw new ForbiddenError(problem);
      }
      return { ok: true, ...(await setEntitlements(ctx, { companyId, plan: params.plan, modules: params.modules, until: params.until, userId: context.actor.userId })) };
    }),
  );
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
    // Retry the one-time entitlement backfill if the first start could not finish it.
    try {
      await backfillEntitlements(ctx);
    } catch (error) {
      ctx.logger.warn("Entitlement backfill failed; companies stay unlocked until it succeeds", { error: message(error) });
    }
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
  ctx.actions.register("setup.drive-bind", async (params, context) => {
    const companyId = requiredCompany(context);
    return onDriveBind(ctx, {
      companyId,
      sharedDriveId: params.sharedDriveId,
    });
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
    // `modules` stays the saved choice AND the entitlements (older kit copies read only it). `enabled` is the
    // company's own switch and `entitled` is its plan, so a page can tell "off in Setup" from "not in your plan".
    const view = await moduleView(ctx, input.companyId);
    const known = view.ready || view.choice;
    return {
      status: 200,
      body: {
        modules: known ? view.modules : null,
        enabled: known ? effectiveModules(view.choice?.modules ?? null) : null,
        entitled: known ? view.entitled : null,
        updatedAt: view.updatedAt,
      },
    };
  } catch (error) {
    ctx.logger.info("Setup modules route failed", { error: message(error) });
    return { status: 500, body: { error: message(error) } };
  }
}

/**
 * A refusal the caller can act on comes back as `{ ok: false, error }`, not a throw: the host turns a thrown plugin
 * error into HTTP 502, and behind Cloudflare the page then loses the message.
 */
async function refusable<T extends object>(run: () => Promise<T>): Promise<T | { ok: false; error: string }> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SetupError) return { ok: false, error: error.message };
    throw error;
  }
}

function requiredCompany(context: PluginPerformActionContext): string {
  if (!context.companyId) throw new SetupError("Company is required");
  return context.companyId;
}
