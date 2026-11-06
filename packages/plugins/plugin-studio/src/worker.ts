import { definePlugin, runWorker, type PluginContext, type ToolRunContext } from "@paperclipai/plugin-sdk";
import { normalizeToolResult, registerClientProjectWatch, registerCrmProjection, scopeOfRow, toolFail } from "@partnersinbiz/pib-plugin-kit";
import { assetFileForAgent, assetUrlForPerson, getAssetRow, importFromAttachment, linkAsset, listAssets } from "./assets.js";
import { archiveCanvas, createCanvas, getCanvas, listCanvases, saveCanvas } from "./canvas.js";
import { addComment, listComments, listVersions, restoreVersion, saveVersion } from "./canvas-versions.js";
import { reviewAsset } from "./review.js";
import { errorText, StudioError } from "./errors.js";
import { runDetached } from "./detach.js";
import { estimateGeneration, generationStatus, processQueue, requestGeneration } from "./generation.js";
import { setCap } from "./ledger.js";
import { assetDetail, pageAssets, pageGenerations, pageRequest } from "./page.js";
import { canGenerate, isCompanyOwner, memberRole, overview, usageView } from "./service.js";
import { sweepLocalCopies } from "./storage.js";
import { clientSummaries } from "./summary.js";
import { assertReachable, loadIssue, scopeForWork, scopeInput } from "./scope.js";
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
      runDetached(() => void processQueue(ctx).catch((error) => ctx.logger.info("Studio queue kick failed", { error: errorText(error) })));
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
    case "studio-review-asset": {
      const work = await workOf(ctx, run, {});
      const row = await getAssetRow(ctx, companyId, String(params.assetId ?? "").trim());
      await assertReachable(ctx, companyId, scopeOfRow(row), work.projectId);
      return reviewAsset(ctx, companyId, params, { agentId: run.agentId });
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

    // Safe without a membership check here: the host route (POST /api/plugins/:pluginId/data/:key) runs
    // assertCompanyAccess on the request's companyId, and the SDK's getData writes that verified companyId over any
    // companyId in params. With no companyId the host requires an instance admin. So a caller only reaches its own company.
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

    // Page data. Same host company check as "overview"; none of these returns a link or a storage key.
    const pageData = (key: string, load: (companyId: string, p: Record<string, unknown>) => Promise<unknown>) =>
      ctx.data.register(key, async (params) => {
        const p = objectParams(params);
        const companyId = String(p.companyId ?? "");
        if (!companyId) throw new StudioError("Company is required");
        return load(companyId, p);
      });
    pageData("assets", (companyId, p) => pageAssets(ctx, companyId, p));
    pageData("asset", (companyId, p) => assetDetail(ctx, companyId, String(p.assetId ?? "").trim()));
    pageData("client-summaries", (companyId) => clientSummaries(ctx, companyId));
    pageData("generations", (companyId, p) => pageGenerations(ctx, companyId, p.groupIds));

    /** Person-only actions: an active member of the company, never an agent. Returns the role for finer checks. */
    async function person(context: { companyId?: string | null; actor: { type?: string | null; userId?: string | null; companyId?: string | null } }) {
      const companyId = context.companyId ?? context.actor.companyId;
      if (!companyId) throw new StudioError("Company is required");
      if (context.actor.type !== "user") throw new StudioError("Agents use the studio tools, not the Studio page.", "forbidden");
      const role = await memberRole(ctx, companyId, context.actor);
      if (!role) throw new StudioError("You are not an active member of this company.", "forbidden");
      return { companyId, role, userId: String(context.actor.userId) };
    }

    ctx.actions.register("me", async (_params, context) => {
      const me = await person(context);
      return { role: me.role, canGenerate: canGenerate(me.role), isOwner: me.role === "owner", userId: me.userId };
    });

    ctx.actions.register("asset-url", async (params, context) => {
      const me = await person(context);
      return { url: await assetUrlForPerson(ctx, me.companyId, String(objectParams(params).assetId ?? "")) };
    });

    // Approve or reject on the page. Viewers can't; approving sends the file to Social.
    ctx.actions.register("review", async (params, context) => {
      const me = await person(context);
      if (!canGenerate(me.role)) throw new StudioError("Viewers can look at Studio but can't approve or reject.", "forbidden");
      return reviewAsset(ctx, me.companyId, objectParams(params), { userId: me.userId });
    });

    // Previews for a page of the library in one call. Links last five minutes.
    ctx.actions.register("asset-urls", async (params, context) => {
      const me = await person(context);
      const raw = objectParams(params).assetIds;
      const ids = Array.isArray(raw) ? [...new Set(raw.filter((id): id is string => typeof id === "string" && id.length > 0))].slice(0, 100) : [];
      const urls: Record<string, string> = {};
      for (const id of ids) {
        try {
          urls[id] = await assetUrlForPerson(ctx, me.companyId, id);
        } catch {
          // A missing asset just has no preview.
        }
      }
      return { urls };
    });

    async function generator(context: Parameters<typeof person>[0], params: unknown) {
      const me = await person(context);
      if (!canGenerate(me.role)) throw new StudioError("Viewers can look at Studio but can't generate. Ask a company owner for member access.", "forbidden");
      const p = objectParams(params);
      const ref = typeof p.issueId === "string" ? p.issueId.trim() : "";
      const issue = ref ? await loadIssue(ctx, me.companyId, ref) : null;
      return { me, request: pageRequest(p), actor: { userId: me.userId, issueId: issue?.id ?? null, projectId: issue?.projectId ?? null } };
    }

    // The page's generate form: the same estimate, queue, caps and ledger as the agent tools.
    ctx.actions.register("estimate", async (params, context) => {
      const { me, request, actor } = await generator(context, params);
      return estimateGeneration(ctx, me.companyId, request, actor);
    });

    ctx.actions.register("generate", async (params, context) => {
      const { me, request, actor } = await generator(context, params);
      const out = await requestGeneration(ctx, me.companyId, request, actor);
      runDetached(() => void processQueue(ctx).catch((error) => ctx.logger.info("Studio queue kick failed", { error: errorText(error) })));
      return out;
    });

    // Canvas boards. Reading goes through the host's company check like the other page data; writing is for members
    // who may generate (viewers look only).
    pageData("canvases", (companyId, p) => listCanvases(ctx, companyId, p).then((canvases) => ({ canvases })));
    pageData("canvas", (companyId, p) => getCanvas(ctx, companyId, String(p.canvasId ?? "")));
    async function canvasEditor(context: Parameters<typeof person>[0]) {
      const me = await person(context);
      if (!canGenerate(me.role)) throw new StudioError("Viewers can look at canvases but can't change them.", "forbidden");
      return me;
    }
    ctx.actions.register("canvas-create", async (params, context) => {
      const me = await canvasEditor(context);
      return createCanvas(ctx, me.companyId, objectParams(params), { userId: me.userId });
    });
    ctx.actions.register("canvas-save", async (params, context) => {
      const me = await canvasEditor(context);
      return saveCanvas(ctx, me.companyId, objectParams(params), { userId: me.userId });
    });
    ctx.actions.register("canvas-archive", async (params, context) => {
      const me = await canvasEditor(context);
      return archiveCanvas(ctx, me.companyId, String(objectParams(params).canvasId ?? "").trim());
    });
    // Versions and card comments: anyone in the company reads them; only editors save, restore or comment.
    pageData("canvas-versions", (companyId, p) => listVersions(ctx, companyId, String(p.canvasId ?? "")).then((versions) => ({ versions })));
    pageData("canvas-comments", (companyId, p) => listComments(ctx, companyId, String(p.canvasId ?? ""), p.cardId).then((comments) => ({ comments })));
    ctx.actions.register("canvas-version-save", async (params, context) => {
      const me = await canvasEditor(context);
      return saveVersion(ctx, me.companyId, objectParams(params), { userId: me.userId });
    });
    ctx.actions.register("canvas-version-restore", async (params, context) => {
      const me = await canvasEditor(context);
      return restoreVersion(ctx, me.companyId, objectParams(params), { userId: me.userId });
    });
    ctx.actions.register("canvas-comment-add", async (params, context) => {
      const me = await canvasEditor(context);
      return addComment(ctx, me.companyId, objectParams(params), { userId: me.userId });
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
