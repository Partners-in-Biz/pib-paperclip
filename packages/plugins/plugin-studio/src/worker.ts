import { definePlugin, runWorker, type PluginContext, type ToolRunContext } from "@paperclipai/plugin-sdk";
import { normalizeToolResult, registerClientProjectWatch, registerCrmProjection, toolFail } from "@partnersinbiz/pib-plugin-kit";
import { assetFileForAgent, assetUrlForPerson, importFromAttachment, linkAsset, listAssets } from "./assets.js";
import { errorText, StudioError } from "./errors.js";
import { estimateGeneration, generationStatus, processQueue, requestGeneration } from "./generation.js";
import { setCap } from "./ledger.js";
import { isCompanyOwner, overview, usageView } from "./service.js";
import { sweepLocalCopies } from "./storage.js";
import { loadIssue, scopeForWork, scopeInput } from "./scope.js";
import { STUDIO_TOOLS } from "./tools.js";

function objectParams(params: unknown): Record<string, unknown> {
  return params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
}

async function runIssueId(ctx: PluginContext, run: ToolRunContext): Promise<string | null> {
  try {
    const rows = await ctx.db.query<{ issue_id: string | null }>(
      "SELECT context_snapshot->>'issueId' AS issue_id FROM public.heartbeat_runs WHERE id = $1 AND company_id = $2 AND agent_id = $3 LIMIT 1",
      [run.runId, run.companyId, run.agentId],
    );
    return rows[0]?.issue_id || null;
  } catch {
    return null;
  }
}

/** The issue a tool call is for: the one named, or the run's own. Its project sets whose work this is. */
async function workOf(ctx: PluginContext, run: ToolRunContext, params: Record<string, unknown>) {
  const ref = (typeof params.issueId === "string" && params.issueId.trim()) || (await runIssueId(ctx, run));
  if (!ref) return { issueId: null, projectId: run.projectId || null };
  const issue = await loadIssue(ctx, run.companyId, ref);
  return { issueId: issue.id, projectId: issue.projectId ?? (run.projectId || null) };
}

async function runTool(ctx: PluginContext, name: string, params: Record<string, unknown>, run: ToolRunContext): Promise<unknown> {
  const companyId = run.companyId;
  switch (name) {
    case "studio-usage": {
      const work = await workOf(ctx, run, params);
      const where = await scopeForWork(ctx, companyId, scopeInput(params), work.projectId);
      return usageView(ctx, companyId, where.scope);
    }
    case "studio-estimate": {
      const work = await workOf(ctx, run, params);
      return estimateGeneration(ctx, companyId, params, { projectId: work.projectId });
    }
    case "studio-generate": {
      const work = await workOf(ctx, run, params);
      if (!work.issueId) throw new StudioError("Generation is charged to a task: pass issueId, or run from an issue.", "no_issue");
      const out = await requestGeneration(ctx, companyId, params, { agentId: run.agentId, runId: run.runId, issueId: work.issueId, projectId: work.projectId });
      void processQueue(ctx).catch((error) => ctx.logger.info("Studio queue kick failed", { error: errorText(error) }));
      return out;
    }
    case "studio-generation-status": {
      const work = await workOf(ctx, run, {});
      return generationStatus(ctx, companyId, params, work.projectId);
    }
    case "studio-list-assets": {
      const work = await workOf(ctx, run, {});
      const where = await scopeForWork(ctx, companyId, scopeInput(params), work.projectId);
      return {
        assets: await listAssets(ctx, companyId, {
          scope: where.scope,
          projectId: typeof params.projectId === "string" ? params.projectId : null,
          kind: typeof params.kind === "string" ? params.kind : null,
          targetType: typeof params.targetType === "string" ? params.targetType : null,
          targetId: typeof params.targetId === "string" ? params.targetId : null,
          limit: typeof params.limit === "number" ? params.limit : 50,
        }),
      };
    }
    case "studio-get-asset": {
      const work = await workOf(ctx, run, {});
      return assetFileForAgent(ctx, companyId, String(params.assetId ?? "").trim(), work.projectId);
    }
    case "studio-import-from-attachment": {
      const work = await workOf(ctx, run, params);
      if (!work.issueId) throw new StudioError("issueId is required: the issue the file is attached to.", "bad_import");
      return importFromAttachment(ctx, companyId, { ...params, issueId: work.issueId }, { agentId: run.agentId });
    }
    case "studio-link-asset": {
      const work = await workOf(ctx, run, {});
      return linkAsset(ctx, companyId, params, work.projectId);
    }
    default:
      throw new StudioError(`Unknown tool ${name}`);
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    registerCrmProjection(ctx, ctx.db.namespace);
    registerClientProjectWatch(ctx);

    for (const tool of STUDIO_TOOLS) {
      ctx.tools.register(tool.name, tool, async (params, run) => {
        try {
          const data = await runTool(ctx, tool.name, objectParams(params), run);
          return normalizeToolResult({ content: JSON.stringify(data), data });
        } catch (error) {
          if (!(error instanceof StudioError)) ctx.logger.warn("Studio tool failed", { tool: tool.name, error: errorText(error) });
          return normalizeToolResult(toolFail(errorText(error)));
        }
      });
    }

    ctx.data.register("overview", async (params) => {
      const companyId = String(objectParams(params).companyId ?? "");
      if (!companyId) throw new StudioError("Company is required");
      return overview(ctx, companyId);
    });

    ctx.actions.register("set-cap", async (params, context) => {
      const companyId = context.companyId ?? context.actor.companyId;
      if (!companyId) throw new StudioError("Company is required");
      if (!(await isCompanyOwner(ctx, companyId, context.actor))) throw new StudioError("Only a company owner can change a credit cap.", "forbidden");
      const p = objectParams(params);
      const value = p.monthlyCredits === null || p.monthlyCredits === "" || p.monthlyCredits === undefined ? null : Number(p.monthlyCredits);
      await setCap(ctx, companyId, String(p.scopeKey ?? ""), value, String(context.actor.userId));
      return overview(ctx, companyId);
    });

    ctx.actions.register("asset-url", async (params, context) => {
      const companyId = context.companyId ?? context.actor.companyId;
      if (!companyId) throw new StudioError("Company is required");
      if (context.actor.type !== "user") throw new StudioError("Agents open files with studio-get-asset.", "forbidden");
      const members = await ctx.access.members.list({ companyId });
      const member = members.some((m) => m.principalType === "user" && m.principalId === context.actor.userId && m.status === "active");
      if (!member && context.actor.userId !== "local-board") throw new StudioError("You are not an active member of this company.", "forbidden");
      return { url: await assetUrlForPerson(ctx, companyId, String(objectParams(params).assetId ?? "")) };
    });

    ctx.jobs.register("process-queue", async () => {
      await processQueue(ctx);
    });
    ctx.jobs.register("sweep-local-files", async () => {
      await sweepLocalCopies();
    });
  },

  async onHealth() {
    return { status: "ok" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
