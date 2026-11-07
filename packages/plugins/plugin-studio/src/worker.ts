import { definePlugin, runWorker, type PluginContext, type ToolRunContext } from "@paperclipai/plugin-sdk";
import { normalizeToolResult, registerClientProjectWatch, registerCrmProjection, scopeOfRow, toolFail } from "@partnersinbiz/pib-plugin-kit";
import { assetFileForAgent, assetUrlForPerson, assetUrlsForPerson, getAssetRow, importFromAttachment, linkAsset, listAssets } from "./assets.js";
import { archiveCanvas, createCanvas, getCanvas, listCanvases, saveCanvas } from "./canvas.js";
import { addComment, listComments, listVersions, restoreVersion, saveVersion } from "./canvas-versions.js";
import { briefDoc } from "./canvas-brief.js";
import { createShare, listShares, refreshShares, revokeShare } from "./canvas-share.js";
import { giveAsset, giveChoices } from "./give.js";
import { reviewAsset } from "./review.js";
import { saveAssetToDrive } from "./drive.js";
import { importFromDrive, listDriveFiles } from "./drive-import.js";
import { registerDriveReadReplies } from "@partnersinbiz/pib-plugin-kit";
import { errorText, StudioError } from "./errors.js";
import { guardAction } from "./refusal.js";
import { runDetached } from "./detach.js";
import { estimateGeneration, generationStatus, processQueue, requestGeneration } from "./generation.js";
import { agentLimitKey, isAgentLimitKey, setCap } from "./ledger.js";
import { assetDetail, pageAssets, pageGenerations, pageRequest } from "./page.js";
import { canGenerate, isCompanyOwner, isOwnerOrAdmin, memberRole, overview, usageView } from "./service.js";
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

/** Lays out a board for a person to generate from. Never generates, never charges, never returns a link to a file. */
async function createFromBrief(ctx: PluginContext, params: Record<string, unknown>, run: ToolRunContext) {
  const work = await workOf(ctx, run, params);
  const projectId = (typeof params.projectId === "string" && params.projectId.trim()) || work.projectId;
  const doc = briefDoc(params);
  const { client, title } = params;
  const board = await createCanvas(ctx, run.companyId, { title, client, projectId, doc }, { agentId: run.agentId });
  return {
    canvasId: board.id,
    title: board.title,
    client: board.client,
    projectId: board.projectId,
    cards: board.cards,
    open: `Studio > Canvas, board "${board.title}" (page path studio-canvas?canvas=${board.id})`,
    next: "Nothing was generated or charged. A person opens the board and presses Generate on each image or video card.",
  };
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
    case "canvas-create-from-brief":
      return createFromBrief(ctx, params, run);
    default:
      throw new StudioError(`Unknown tool ${name}`);
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    // Every page action answers a plain refusal as { ok: false, message } with a 200, not a 502 (PAR-8120).
    type ActionHandler = Parameters<PluginContext["actions"]["register"]>[1];
    const action = (key: string, handler: ActionHandler) => ctx.actions.register.call(ctx.actions, key, guardAction(handler));
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

    action("set-cap", async (params, context) => {
      const companyId = context.companyId ?? context.actor.companyId;
      if (!companyId) throw new StudioError("Company is required");
      if (!(await isCompanyOwner(ctx, companyId, context.actor))) throw new StudioError("Only a company owner can change a credit cap.", "forbidden");
      const p = objectParams(params);
      const value = p.monthlyCredits === null || p.monthlyCredits === "" || p.monthlyCredits === undefined ? null : Number(p.monthlyCredits);
      await setCap(ctx, companyId, String(p.scopeKey ?? ""), value, String(context.actor.userId));
      return overview(ctx, companyId);
    });

    // One agent's per-run limit (credit_limits key agent:<id>). Owner or admin; blank clears it.
    action("set-agent-limit", async (params, context) => {
      const companyId = context.companyId ?? context.actor.companyId;
      if (!companyId) throw new StudioError("Company is required");
      if (!(await isOwnerOrAdmin(ctx, companyId, context.actor))) throw new StudioError("Only a company owner or admin can set an agent's credit limit.", "forbidden");
      const p = objectParams(params);
      const agentId = String(p.agentId ?? "");
      if (!isAgentLimitKey(agentLimitKey(agentId))) throw new StudioError("Pick an agent.", "bad_scope");
      const value = p.credits === null || p.credits === "" || p.credits === undefined ? null : Number(p.credits);
      await setCap(ctx, companyId, agentLimitKey(agentId), value, String(context.actor.userId));
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

    action("me", async (_params, context) => {
      const me = await person(context);
      return { role: me.role, canGenerate: canGenerate(me.role), isOwner: me.role === "owner", canSetAgentLimit: me.role === "owner" || me.role === "admin", userId: me.userId };
    });

    action("asset-url", async (params, context) => {
      const me = await person(context);
      return { url: await assetUrlForPerson(ctx, me.companyId, String(objectParams(params).assetId ?? "")) };
    });

    // Approve or reject on the page. Viewers can't; approving sends the file to Social.
    action("review", async (params, context) => {
      const me = await person(context);
      if (!canGenerate(me.role)) throw new StudioError("Viewers can look at Studio but can't approve or reject.", "forbidden");
      return reviewAsset(ctx, me.companyId, objectParams(params), { userId: me.userId });
    });

    // Save to Drive (PAR-8106): into the asset's own client folder, `02 Assets`. Viewers can't.
    action("drive-save", async (params, context) => {
      const me = await person(context);
      if (!canGenerate(me.role)) throw new StudioError("Viewers can look at Studio but can't save to Drive.", "forbidden");
      return saveAssetToDrive(ctx, me.companyId, String(objectParams(params).assetId ?? "").trim());
    });

    // Give to agent (give.ts): agents that can run, then a normal issue for the chosen one. Viewers can't give.
    action("give-agents", async (_params, context) => {
      const me = await person(context);
      if (!canGenerate(me.role)) throw new StudioError("Viewers can look at Studio but can't give files to agents.", "forbidden");
      return { agents: await giveChoices(ctx, me.companyId) };
    });
    action("give", async (params, context) => {
      const me = await person(context);
      return giveAsset(ctx, me.companyId, objectParams(params), { userId: me.userId, role: me.role });
    });

    // From Drive (PAR-8107): list and copy files from the picked client's Drive assets. People only; viewers can't import.
    registerDriveReadReplies(ctx);
    action("drive-list", async (params, context) => {
      const me = await person(context);
      if (!canGenerate(me.role)) throw new StudioError("Viewers can look at Studio but can't add files from Drive.", "forbidden");
      return listDriveFiles(ctx, me.companyId, objectParams(params));
    });
    action("drive-import", async (params, context) => {
      const me = await person(context);
      if (!canGenerate(me.role)) throw new StudioError("Viewers can look at Studio but can't add files from Drive.", "forbidden");
      return importFromDrive(ctx, me.companyId, objectParams(params), { userId: me.userId });
    });

    // Previews for a page of the library in one call. Links last five minutes.
    action("asset-urls", async (params, context) => {
      const me = await person(context);
      const raw = objectParams(params).assetIds;
      const ids = Array.isArray(raw) ? [...new Set(raw.filter((id): id is string => typeof id === "string" && id.length > 0))].slice(0, 100) : [];
      // One settings read and one secret lookup for the whole page (PAR-8102); a failure is reported, not hidden.
      return assetUrlsForPerson(ctx, me.companyId, ids);
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
    action("estimate", async (params, context) => {
      const { me, request, actor } = await generator(context, params);
      return estimateGeneration(ctx, me.companyId, request, actor);
    });

    action("generate", async (params, context) => {
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
    action("canvas-create", async (params, context) => {
      const me = await canvasEditor(context);
      return createCanvas(ctx, me.companyId, objectParams(params), { userId: me.userId });
    });
    action("canvas-save", async (params, context) => {
      const me = await canvasEditor(context);
      return saveCanvas(ctx, me.companyId, objectParams(params), { userId: me.userId });
    });
    action("canvas-archive", async (params, context) => {
      const me = await canvasEditor(context);
      return archiveCanvas(ctx, me.companyId, String(objectParams(params).canvasId ?? "").trim());
    });
    // Versions and card comments: anyone in the company reads them; only editors save, restore or comment.
    pageData("canvas-versions", (companyId, p) => listVersions(ctx, companyId, String(p.canvasId ?? "")).then((versions) => ({ versions })));
    pageData("canvas-comments", (companyId, p) => listComments(ctx, companyId, String(p.canvasId ?? ""), p.cardId).then((comments) => ({ comments })));
    action("canvas-version-save", async (params, context) => {
      const me = await canvasEditor(context);
      return saveVersion(ctx, me.companyId, objectParams(params), { userId: me.userId });
    });
    action("canvas-version-restore", async (params, context) => {
      const me = await canvasEditor(context);
      return restoreVersion(ctx, me.companyId, objectParams(params), { userId: me.userId });
    });
    action("canvas-comment-add", async (params, context) => {
      const me = await canvasEditor(context);
      return addComment(ctx, me.companyId, objectParams(params), { userId: me.userId });
    });
    // Read-only share links (canvas-share.ts): only editors list, make and revoke them. The list is an action, not
    // page data, because page data has no caller and each entry carries the secret link path.
    action("canvas-share-list", async (params, context) => {
      const me = await canvasEditor(context);
      return { shares: await listShares(ctx, me.companyId, String(objectParams(params).canvasId ?? "")) };
    });
    action("canvas-share-create", async (params, context) => {
      const me = await canvasEditor(context);
      return createShare(ctx, me.companyId, objectParams(params), { userId: me.userId });
    });
    action("canvas-share-revoke", async (params, context) => {
      const me = await canvasEditor(context);
      return revokeShare(ctx, me.companyId, objectParams(params));
    });
    const publishShares = () => refreshShares(ctx).catch((error) => ctx.logger.warn("Studio share pages not refreshed", { error: errorText(error) }));
    runDetached(() => void publishShares());

    // The one-minute job also keeps share pages fresh (new preview links) and deletes revoked or expired ones.
    ctx.jobs.register("process-queue", async () => {
      try {
        await processQueue(ctx);
      } finally {
        await publishShares();
      }
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
