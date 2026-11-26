import { definePlugin, runWorker, type PluginContext, type PluginPerformActionContext, type ToolRunContext } from "@paperclipai/plugin-sdk";
import { registerSocialMediaSync } from "./social-media-sync.js";
import { actingRestriction, createAccessGuard, normalizeToolResult, registerClientProjectWatch, registerCrmProjection, scopeOfRow, toolFail, type ActingRestriction, type ClientScope } from "@partnersinbiz/pib-plugin-kit";
import { boardLibrary } from "./board-library.js";
import { boardScopeInput, boardTarget } from "./board-scope.js";
import { assertExpectedClient, boardGenerationFor, boardGenerationState, boardRunFor, scopeForBoardRun } from "./board-generation.js";
import { boardClientView, setBoardClient } from "./board-clients.js";
import { assetBytesForPerson, assetFileForAgent, assetUrlForPerson, assetUrlsForPerson, getAssetRow, importFromAttachment, linkAsset, listAssets } from "./assets.js";
import { archiveCanvas, canvasScope, createCanvas, getCanvas, listCanvases, saveCanvas } from "./canvas.js";
import { getRender } from "./video-edit/render-queue.js";
import { videoEditScope } from "./video-edit/store.js";
import { addComment, listComments, listVersions, restoreVersion, saveVersion } from "./canvas-versions.js";
import { briefDoc } from "./canvas-brief.js";
import { applyOpsAction, cancelRenderAction, createEditAction, deleteEditAction, getEditAction, listEditsAction, listVersionsAction, renderAction, restoreVersionAction, saveVersionAction, renderStatusAction } from "./video-edit/actions.js";
import { captionClipAction } from "./video-edit/auto-caption.js";
import { detectBeatsAction } from "./video-edit/beats.js";
import { cutToBeatAction } from "./video-edit/cut-to-beat.js";
import { cutSilencesAction } from "./video-edit/silence.js";
import { assertShareOpen, createShare, listShares, refreshShares, revokeShare } from "./canvas-share.js";
import { discardGive, prepareGive, recordGive } from "./give.js";
import { reviewAsset } from "./review.js";
import { saveAssetToDrive } from "./drive.js";
import { getTransfer } from "./drive-jobs.js";
import { importFromDrive, driveThumbs, listDriveFiles } from "./drive-import.js";
import { registerBrandKitReplies, registerDriveReadReplies } from "@partnersinbiz/pib-plugin-kit";
import { brandKitFor } from "./brand-kit.js";
import { deleteTemplate, listSavedTemplates, saveTemplate } from "./prompt-template-store.js";
import { deleteCanvasTemplate, listCanvasTemplates, saveCanvasTemplate } from "./canvas-template-store.js";
import { saveLayoutPage, takeTextDraft, textDrafts, writeCardText } from "./canvas-layout.js";
import { errorText, isStudioError, StudioError } from "./errors.js";
import { guardAction } from "@partnersinbiz/pib-plugin-kit/refusal";
import { STUDIO_ACCESS_TABLE } from "./access-table.js";
import { runDetached } from "./detach.js";
import { estimateGeneration, generationStatus, processQueue, requestGeneration } from "./generation.js";
import { agentLimitKey, isAgentLimitKey, setCap } from "./ledger.js";
import { lipsyncAction } from "./lipsync.js";
import { assetDetail, pageAssets, pageGenerations, pageRequest } from "./page.js";
import { setBalance } from "./balance.js";
import { canGenerate, isCompanyOwner, isOwnerOrAdmin, memberRole, overview, usageView } from "./service.js";
import { sweepLocalCopies } from "./storage.js";
import { sweepRenderWorkdirs } from "./video-edit/workdir.js";
import { createRenderExecutor } from "./video-edit/render-pipeline.js";
import { createRenderRunner } from "./video-edit/runner.js";
import { isVideoEditTool, runVideoEditTool } from "./video-edit/tools.js";
import { musicAction } from "./video-edit/music.js";
import { voiceoverAction } from "./video-edit/voiceover.js";
import { clientSummaries } from "./summary.js";
import { assertOpenToPerson, assertReachable, loadIssue, resolveScope, scopeForWork, scopeInput } from "./scope.js";
import { STUDIO_TOOLS } from "./tools.js";
import { PLUGIN_ID } from "./namespace.js";

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
  if (isVideoEditTool(name)) return runVideoEditTool(ctx, name, params, run, await workOf(ctx, run, params));
  switch (name) {
    case "studio-usage": {
      const work = await workOf(ctx, run, params);
      const where = await scopeForWork(ctx, companyId, scopeInput(params), work.projectId);
      return usageView(ctx, companyId, where.scope);
    }
    case "studio-estimate": {
      const work = await workOf(ctx, run, params);
      // On a board chat thread the board decides who pays, as for studio-generate (PAR-14835 Approach 5).
      const thread = await boardRunFor(ctx, run, work.issueId);
      const scope = thread ? await scopeForBoardRun(ctx, companyId, thread.board, scopeInput(params)) : undefined;
      return estimateGeneration(ctx, companyId, params, { projectId: work.projectId, board: thread?.mark, scope });
    }
    case "studio-generate": {
      const work = await workOf(ctx, run, params);
      if (!work.issueId) throw new StudioError("Generation is charged to a task: pass issueId, or run from an issue.", "no_issue");
      // A run bound to a board chat thread counts against its person's daily board limit (PAR-14281, stage 3d), and
      // charges the board's client: its project's, else the board's link (PAR-14835 Approach 5).
      const thread = await boardRunFor(ctx, run, work.issueId);
      const scope = thread ? await scopeForBoardRun(ctx, companyId, thread.board, scopeInput(params)) : undefined;
      const out = await requestGeneration(ctx, companyId, params, { agentId: run.agentId, runId: run.runId, issueId: work.issueId, projectId: work.projectId, board: thread?.mark, scope });
      runDetached(() => void processQueue(ctx).catch((error) => ctx.logger.info("Studio queue kick failed", { error: errorText(error) })));
      return out;
    }
    case "studio-lipsync": {
      const work = await workOf(ctx, run, params);
      if (!work.issueId) throw new StudioError("Generation is charged to a task: pass issueId, or run from an issue.", "no_issue");
      const out = await lipsyncAction(ctx, companyId, params, { agentId: run.agentId, runId: run.runId, issueId: work.issueId, projectId: work.projectId });
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
    case "studio-drive-save": {
      const work = await workOf(ctx, run, {});
      const assetId = String(params.assetId ?? "").trim();
      await assertReachable(ctx, companyId, scopeOfRow(await getAssetRow(ctx, companyId, assetId)), work.projectId);
      return saveAssetToDrive(ctx, companyId, assetId);
    }
    case "studio-drive-transfer":
      return getTransfer(companyId, String(params.transferId ?? "").trim());
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
    case "studio-brand-kit": {
      const work = await workOf(ctx, run, params);
      return brandKitFor(ctx, companyId, await scopeForWork(ctx, companyId, scopeInput(params), work.projectId));
    }
    case "canvas-create-from-brief":
      return createFromBrief(ctx, params, run);
    case "canvas-write-text": {
      const work = await workOf(ctx, run, {});
      return writeCardText(ctx, companyId, params, { agentId: run.agentId, projectId: work.projectId });
    }
    default:
      throw new StudioError(`Unknown tool ${name}`);
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    // Every action and tool goes through the access guard (PAR-12578 plan 4.4; rows in access-table.ts). Every page
    // action answers a plain refusal as { ok: false, message } with a 200, not a 502 (PAR-8120).
    const guard = createAccessGuard(ctx, { pluginKey: PLUGIN_ID, table: STUDIO_ACCESS_TABLE });
    type ActionHandler = (params: Record<string, unknown>, context: PluginPerformActionContext) => Promise<unknown>;
    const action = (key: string, handler: ActionHandler) => guard.action(key, guardAction(handler, isStudioError));
    registerCrmProjection(ctx, ctx.db.namespace);
    registerClientProjectWatch(ctx);
    registerSocialMediaSync(ctx);

    for (const tool of STUDIO_TOOLS) {
      guard.tool(tool.name, tool, async (params, run) => {
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
    // The host also passes the acting person (PAR-14297): a restricted member gets no client in any page data (PAR-14298).
    ctx.data.register("overview", async (params, context) => {
      const companyId = String(objectParams(params).companyId ?? "");
      if (!companyId) throw new StudioError("Company is required");
      return overview(ctx, companyId, actingRestriction(context?.actor));
    });

    action("set-cap", async (params, context) => {
      const companyId = context.companyId ?? context.actor.companyId;
      if (!companyId) throw new StudioError("Company is required");
      if (!(await isCompanyOwner(ctx, companyId, context.actor))) throw new StudioError("Only a company owner can change a credit cap.", "forbidden");
      const p = objectParams(params);
      const value = p.monthlyCredits === null || p.monthlyCredits === "" || p.monthlyCredits === undefined ? null : Number(p.monthlyCredits);
      await setCap(ctx, companyId, String(p.scopeKey ?? ""), value, String(context.actor.userId));
      return overview(ctx, companyId, actingRestriction(context.actor));
    });

    // The Higgsfield balance as shown on its billing page (PAR-8388): owner only, like a cap.
    action("set-balance", async (params, context) => {
      const companyId = context.companyId ?? context.actor.companyId;
      if (!companyId) throw new StudioError("Company is required");
      if (!(await isCompanyOwner(ctx, companyId, context.actor))) throw new StudioError("Only a company owner can enter the Higgsfield balance.", "forbidden");
      await setBalance(ctx, companyId, objectParams(params).usd, String(context.actor.userId));
      return overview(ctx, companyId, actingRestriction(context.actor));
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
      return overview(ctx, companyId, actingRestriction(context.actor));
    });

    // Page data. Same host company check as "overview"; none of these returns a link or a storage key.
    // Each gets core's member-restriction answer for the acting person (PAR-14298): lists hold own work only for a
    // restricted member, and one client row is refused. A missing answer refuses whatever would show a client.
    const pageData = (key: string, load: (companyId: string, p: Record<string, unknown>, restriction: ActingRestriction) => Promise<unknown>) =>
      ctx.data.register(key, async (params, context) => {
        const p = objectParams(params);
        const companyId = String(p.companyId ?? "");
        if (!companyId) throw new StudioError("Company is required");
        return load(companyId, p, actingRestriction(context?.actor));
      });
    pageData("assets", (companyId, p, restriction) => pageAssets(ctx, companyId, p, restriction));
    pageData("asset", (companyId, p, restriction) => assetDetail(ctx, companyId, String(p.assetId ?? "").trim(), restriction));
    pageData("client-summaries", (companyId, _p, restriction) => clientSummaries(ctx, companyId, restriction));
    pageData("generations", (companyId, p, restriction) => pageGenerations(ctx, companyId, p.groupIds, restriction));

    /**
     * The client a board, a video edit or a render is filed under, checked against the person (PAR-14298). Nothing is
     * looked up for a person who may see client work, so his answers (and their errors) stay as they were.
     */
    const openCanvas = async (companyId: string, canvasId: unknown, restriction: ActingRestriction) => {
      if (restriction !== "unrestricted") assertOpenToPerson(await canvasScope(ctx, companyId, String(canvasId ?? "")), restriction);
    };
    const openEdit = async (companyId: string, editId: unknown, restriction: ActingRestriction) => {
      if (restriction !== "unrestricted") assertOpenToPerson(await videoEditScope(ctx, companyId, String(editId ?? "").trim()), restriction);
    };
    const openRender = async (companyId: string, renderId: unknown, restriction: ActingRestriction) => {
      if (restriction === "unrestricted") return;
      const render = await getRender(ctx, companyId, String(renderId ?? "").trim());
      assertOpenToPerson(render.client ? ({ kind: render.client.kind, id: render.client.id } as ClientScope) : null, restriction);
    };

    /**
     * Person-only actions: an active member of the company, never an agent. Returns the role for finer checks, and
     * core's member-restriction answer: a restricted member gets no client media or client generation (PAR-14274).
     */
    async function person(context: Pick<PluginPerformActionContext, "companyId" | "actor">) {
      const companyId = context.companyId ?? context.actor.companyId;
      if (!companyId) throw new StudioError("Company is required");
      if (context.actor.type !== "user") throw new StudioError("Agents use the studio tools, not the Studio page.", "forbidden");
      const role = await memberRole(ctx, companyId, context.actor);
      if (!role) throw new StudioError("You are not an active member of this company.", "forbidden");
      return { companyId, role, userId: String(context.actor.userId), restriction: actingRestriction(context.actor) };
    }

    action("me", async (_params, context) => {
      const me = await person(context);
      return { role: me.role, canGenerate: canGenerate(me.role), isOwner: me.role === "owner", canSetAgentLimit: me.role === "owner" || me.role === "admin", userId: me.userId };
    });

    // With `boardScope` (a Planning Canvas card, PAR-14280) the file must be the board's client's: board-scope.ts.
    const boardFor = async (companyId: string, p: Record<string, unknown>) => {
      const scope = boardScopeInput(p);
      return scope ? boardTarget(ctx, companyId, scope) : undefined;
    };

    action("asset-url", async (params, context) => {
      const me = await person(context);
      const p = objectParams(params);
      return { url: await assetUrlForPerson(ctx, me.companyId, String(p.assetId ?? ""), me.restriction, await boardFor(me.companyId, p)) };
    });

    // The library panel on a board: only files that pass the board's scope.
    action("board-library", async (params, context) => {
      const me = await person(context);
      const p = objectParams(params);
      const scope = boardScopeInput(p);
      if (!scope) throw new StudioError("boardScope is required.", "bad_board_scope");
      return boardLibrary(ctx, me.companyId, scope, me.restriction, { kind: p.kind, limit: p.limit });
    });

    // The board's CRM client (PAR-14835): what the panel shows, and setting or clearing it (owner or admin, Q7).
    action("board-client", async (params, context) => {
      const me = await person(context);
      const scope = boardScopeInput(objectParams(params));
      if (!scope) throw new StudioError("boardScope is required.", "bad_board_scope");
      return boardClientView(ctx, me.companyId, scope, me);
    });
    action("board-client-set", async (params, context) => {
      const me = await person(context);
      return setBoardClient(ctx, me.companyId, objectParams(params), me);
    });

    // Approve or reject on the page. Viewers can't; approving sends the file to Social.
    action("review", async (params, context) => {
      const me = await person(context);
      if (!canGenerate(me.role)) throw new StudioError("Viewers can look at Studio but can't approve or reject.", "forbidden");
      return reviewAsset(ctx, me.companyId, objectParams(params), { userId: me.userId, restriction: me.restriction });
    });

    // Save to Drive (PAR-8106): into the asset's own client folder, `02 Assets`. Viewers can't.
    action("drive-save", async (params, context) => {
      const me = await person(context);
      if (!canGenerate(me.role)) throw new StudioError("Viewers can look at Studio but can't save to Drive.", "forbidden");
      return saveAssetToDrive(ctx, me.companyId, String(objectParams(params).assetId ?? "").trim(), undefined, me.restriction);
    });

    // Give to agent (give.ts, PAR-8138): the page opens the host's New Task popup. Prefill, then link or clean up.
    // Viewers can't give: every step checks the role again.
    action("give-prepare", async (params, context) => {
      const me = await person(context);
      return prepareGive(ctx, me.companyId, objectParams(params), { userId: me.userId, role: me.role, restriction: me.restriction });
    });
    action("give-record", async (params, context) => {
      const me = await person(context);
      return recordGive(ctx, me.companyId, objectParams(params), { userId: me.userId, role: me.role, restriction: me.restriction });
    });
    action("give-discard", async (params, context) => {
      const me = await person(context);
      return discardGive(ctx, me.companyId, objectParams(params), { userId: me.userId, role: me.role, restriction: me.restriction });
    });

    // From Drive (PAR-8107): list and copy files from the picked client's Drive assets. People only; viewers can't import.
    registerDriveReadReplies(ctx);
    action("drive-list", async (params, context) => {
      const me = await person(context);
      if (!canGenerate(me.role)) throw new StudioError("Viewers can look at Studio but can't add files from Drive.", "forbidden");
      return listDriveFiles(ctx, me.companyId, objectParams(params), me.restriction);
    });
    action("drive-import", async (params, context) => {
      const me = await person(context);
      if (!canGenerate(me.role)) throw new StudioError("Viewers can look at Studio but can't add files from Drive.", "forbidden");
      return importFromDrive(ctx, me.companyId, objectParams(params), { userId: me.userId, restriction: me.restriction });
    });
    // The picker's previews (PAR-8124): a page of small images, or one large one, through the CRM. People only.
    action("drive-thumbs", async (params, context) => {
      const me = await person(context);
      if (!canGenerate(me.role)) throw new StudioError("Viewers can look at Studio but can't add files from Drive.", "forbidden");
      return driveThumbs(ctx, me.companyId, objectParams(params), me.restriction);
    });
    // Progress of a Drive save or import over 5 MiB (PAR-8125). The UI polls this; people only.
    action("drive-transfer", async (params, context) => {
      const me = await person(context);
      if (!canGenerate(me.role)) throw new StudioError("Viewers can look at Studio but can't use Drive transfers.", "forbidden");
      return getTransfer(me.companyId, String(objectParams(params).transferId ?? "").trim());
    });

    // The picked client's brand kit from the CRM (PAR-8134). Shown on the card; a person adds it to the prompt.
    registerBrandKitReplies(ctx);
    action("brand-kit", async (params, context) => {
      const me = await person(context);
      const requested = scopeInput({ client: objectParams(params).client ?? null });
      const where = await resolveScope(ctx, me.companyId, requested ?? null);
      assertOpenToPerson(where.scope, me.restriction); // a restricted member reads no client's kit (PAR-14290)
      return brandKitFor(ctx, me.companyId, where);
    });

    // The Generate page's saved prompt templates: anyone in the company can read them; viewers can't change them.
    action("prompt-templates", async (_params, context) => {
      const me = await person(context);
      return { saved: await listSavedTemplates(ctx, me.companyId) };
    });
    action("save-prompt-template", async (params, context) => {
      const me = await person(context);
      if (!canGenerate(me.role)) throw new StudioError("Viewers can look at Studio but can't save templates. Ask a company owner for member access.", "forbidden");
      return { template: await saveTemplate(ctx, me.companyId, objectParams(params)) };
    });
    action("delete-prompt-template", async (params, context) => {
      const me = await person(context);
      if (!canGenerate(me.role)) throw new StudioError("Viewers can look at Studio but can't delete templates. Ask a company owner for member access.", "forbidden");
      return deleteTemplate(ctx, me.companyId, String(objectParams(params).id ?? ""));
    });

    // The canvases page's saved board templates: same rules as the prompt templates above.
    action("canvas-templates", async (_params, context) => {
      const me = await person(context);
      return { saved: await listCanvasTemplates(ctx, me.companyId) };
    });
    action("save-canvas-template", async (params, context) => {
      const me = await person(context);
      if (!canGenerate(me.role)) throw new StudioError("Viewers can look at Studio but can't save templates. Ask a company owner for member access.", "forbidden");
      return { template: await saveCanvasTemplate(ctx, me.companyId, objectParams(params)) };
    });
    action("delete-canvas-template", async (params, context) => {
      const me = await person(context);
      if (!canGenerate(me.role)) throw new StudioError("Viewers can look at Studio but can't delete templates. Ask a company owner for member access.", "forbidden");
      return deleteCanvasTemplate(ctx, me.companyId, String(objectParams(params).id ?? ""));
    });

    // The Layout card: the picture's bytes to draw on, and saving the finished page.
    action("asset-data", async (params, context) => {
      const me = await person(context);
      return assetBytesForPerson(ctx, me.companyId, String(objectParams(params).assetId ?? ""), me.restriction);
    });
    action("layout-save", async (params, context) => {
      const me = await person(context);
      if (!canGenerate(me.role)) throw new StudioError("Viewers can look at Studio but can't save pages. Ask a company owner for member access.", "forbidden");
      const p = objectParams(params);
      await openCanvas(me.companyId, p.canvasId, me.restriction);
      return saveLayoutPage(ctx, me.companyId, p, me.userId);
    });
    // What agents wrote for Text cards, waiting for the open board to take them in.
    action("canvas-text-drafts", async (params, context) => {
      const me = await person(context);
      const canvasId = String(objectParams(params).canvasId ?? "");
      await openCanvas(me.companyId, canvasId, me.restriction);
      return { drafts: await textDrafts(ctx, me.companyId, canvasId) };
    });
    action("canvas-text-draft-taken", async (params, context) => {
      const me = await person(context);
      const p = objectParams(params);
      await openCanvas(me.companyId, p.canvasId, me.restriction);
      await takeTextDraft(ctx, me.companyId, String(p.canvasId ?? ""), String(p.cardId ?? ""));
      return { ok: true };
    });

    // Previews for a page of the library in one call. Links last five minutes.
    action("asset-urls", async (params, context) => {
      const me = await person(context);
      const p = objectParams(params);
      const raw = p.assetIds;
      const ids = Array.isArray(raw) ? [...new Set(raw.filter((id): id is string => typeof id === "string" && id.length > 0))].slice(0, 100) : [];
      // One settings read and one secret lookup for the whole page (PAR-8102); a failure is reported, not hidden.
      return assetUrlsForPerson(ctx, me.companyId, ids, me.restriction, 300, undefined, await boardFor(me.companyId, p));
    });

    async function generator(context: Parameters<typeof person>[0], params: unknown, opts: { generate?: boolean } = {}) {
      const me = await person(context);
      if (!canGenerate(me.role)) throw new StudioError("Viewers can look at Studio but can't generate. Ask a company owner for member access.", "forbidden");
      const p = objectParams(params);
      // From a board card (PAR-14281): the board decides who pays, its daily limit applies, and the inputs are kept.
      const board = boardScopeInput(p);
      if (board) {
        const on = await boardGenerationFor(ctx, me.companyId, board, p, me.userId, me.restriction);
        // A card that names its board confirms the client its estimate showed (PAR-14835 Approach 4); old tabs don't.
        if (opts.generate && board.boardId) assertExpectedClient(p, on.client);
        const expected = p.expectedCredits === undefined || p.expectedCredits === null ? undefined : Number(p.expectedCredits);
        if (expected !== undefined && !Number.isFinite(expected)) throw new StudioError("expectedCredits must be a number.", "bad_request");
        // No client from the browser (refused above) and no issue: the board decides who pays, server-side.
        return { me, request: pageRequest(p), actor: { userId: me.userId, issueId: null, projectId: on.projectId, restriction: me.restriction, board: on.mark, expectedCredits: expected, scope: on.scope } };
      }
      const ref = typeof p.issueId === "string" ? p.issueId.trim() : "";
      const issue = ref ? await loadIssue(ctx, me.companyId, ref) : null;
      return { me, request: pageRequest(p), actor: { userId: me.userId, issueId: issue?.id ?? null, projectId: issue?.projectId ?? null, restriction: me.restriction } };
    }

    // The page's generate form: the same estimate, queue, caps and ledger as the agent tools.
    action("estimate", async (params, context) => {
      const { me, request, actor } = await generator(context, params);
      return estimateGeneration(ctx, me.companyId, request, actor);
    });

    action("generate", async (params, context) => {
      const { me, request, actor } = await generator(context, params, { generate: true });
      const out = await requestGeneration(ctx, me.companyId, request, actor);
      runDetached(() => void processQueue(ctx).catch((error) => ctx.logger.info("Studio queue kick failed", { error: errorText(error) })));
      return out;
    });

    // The output card of a board generation: its queue state, checked against the board like a file (PAR-14281).
    action("board-generation", async (params, context) => {
      const me = await person(context);
      const p = objectParams(params);
      const scope = boardScopeInput(p);
      if (!scope) throw new StudioError("boardScope is required.", "bad_board_scope");
      return boardGenerationState(ctx, me.companyId, scope, String(p.generationId ?? "").trim(), me.restriction);
    });

    // Lip-sync on the generate page (PAR-8436): a portrait plus an audio asset or a typed line; same generate path.
    action("studio-lipsync", async (params, context) => {
      const me = await person(context);
      if (!canGenerate(me.role)) throw new StudioError("Viewers can look at Studio but can't generate. Ask a company owner for member access.", "forbidden");
      const p = objectParams(params);
      const ref = typeof p.issueId === "string" ? p.issueId.trim() : "";
      const issue = ref ? await loadIssue(ctx, me.companyId, ref) : null;
      const out = await lipsyncAction(ctx, me.companyId, p, { userId: me.userId, issueId: issue?.id ?? null, projectId: issue?.projectId ?? null, restriction: me.restriction });
      runDetached(() => void processQueue(ctx).catch((error) => ctx.logger.info("Studio queue kick failed", { error: errorText(error) })));
      return out;
    });

    // Canvas boards. Reading goes through the host's company check like the other page data; writing is for members
    // who may generate (viewers look only).
    pageData("canvases", (companyId, p, restriction) => listCanvases(ctx, companyId, p, restriction).then((canvases) => ({ canvases })));
    pageData("canvas", async (companyId, p, restriction) => {
      await openCanvas(companyId, p.canvasId, restriction);
      return getCanvas(ctx, companyId, String(p.canvasId ?? ""));
    });
    async function canvasEditor(context: Parameters<typeof person>[0]) {
      const me = await person(context);
      if (!canGenerate(me.role)) throw new StudioError("Viewers can look at canvases but can't change them.", "forbidden");
      return me;
    }
    action("canvas-create", async (params, context) => {
      const me = await canvasEditor(context);
      return createCanvas(ctx, me.companyId, objectParams(params), { userId: me.userId, restriction: me.restriction });
    });
    action("canvas-save", async (params, context) => {
      const me = await canvasEditor(context);
      const p = objectParams(params);
      await openCanvas(me.companyId, p.canvasId, me.restriction);
      return saveCanvas(ctx, me.companyId, p, { userId: me.userId });
    });
    action("canvas-archive", async (params, context) => {
      const me = await canvasEditor(context);
      const canvasId = String(objectParams(params).canvasId ?? "").trim();
      await openCanvas(me.companyId, canvasId, me.restriction);
      return archiveCanvas(ctx, me.companyId, canvasId);
    });
    // Video edits (video-edit/actions.ts, PAR-8276 A8a): anyone in the company reads them; only editors change or render.
    async function videoEditor(context: Parameters<typeof person>[0]) {
      const me = await person(context);
      if (!canGenerate(me.role)) throw new StudioError("Viewers can look at video edits but can't change or render them.", "forbidden");
      return me;
    }
    // A video edit, its versions and its renders are filed under the edit's client: each is checked first (PAR-14298).
    const reader = async (context: Parameters<typeof person>[0], params: unknown, open: typeof openEdit, idKey: "editId" | "renderId") => {
      const me = await person(context);
      const p = objectParams(params);
      await open(me.companyId, p[idKey], me.restriction);
      return { me, p };
    };
    const editor = async (context: Parameters<typeof person>[0], params: unknown, open: typeof openEdit, idKey: "editId" | "renderId") => {
      const me = await videoEditor(context);
      const p = objectParams(params);
      await open(me.companyId, p[idKey], me.restriction);
      return { me, p };
    };
    action("video-edit-list", async (params, context) => {
      const me = await person(context);
      return listEditsAction(ctx, me.companyId, objectParams(params), me.restriction);
    });
    action("video-edit-get", async (params, context) => {
      const { me, p } = await reader(context, params, openEdit, "editId");
      return getEditAction(ctx, me.companyId, p);
    });
    action("video-edit-render-status", async (params, context) => {
      const { me, p } = await reader(context, params, openRender, "renderId");
      return renderStatusAction(ctx, me.companyId, p);
    });
    action("video-edit-create", async (params, context) => {
      const me = await videoEditor(context);
      return createEditAction(ctx, me.companyId, objectParams(params), { userId: me.userId, restriction: me.restriction });
    });
    action("video-edit-apply-ops", async (params, context) => {
      const { me, p } = await editor(context, params, openEdit, "editId");
      return applyOpsAction(ctx, me.companyId, p, { userId: me.userId });
    });
    action("video-edit-caption", async (params, context) => {
      const { me, p } = await editor(context, params, openEdit, "editId");
      return captionClipAction(ctx, me.companyId, p, { userId: me.userId });
    });
    action("video-edit-detect-beats", async (params, context) => {
      const { me, p } = await reader(context, params, openEdit, "editId");
      return detectBeatsAction(ctx, me.companyId, p);
    });
    action("video-edit-cut-to-beat", async (params, context) => {
      const { me, p } = await editor(context, params, openEdit, "editId");
      return cutToBeatAction(ctx, me.companyId, p, { userId: me.userId });
    });
    action("video-edit-cut-silences", async (params, context) => {
      const { me, p } = await editor(context, params, openEdit, "editId");
      return cutSilencesAction(ctx, me.companyId, p, { userId: me.userId });
    });
    action("video-edit-voiceover", async (params, context) => {
      const { me, p } = await editor(context, params, openEdit, "editId");
      return voiceoverAction(ctx, me.companyId, p, { userId: me.userId });
    });
    action("video-edit-music", async (params, context) => {
      const { me, p } = await editor(context, params, openEdit, "editId");
      return musicAction(ctx, me.companyId, p, { userId: me.userId });
    });
    action("video-edit-render", async (params, context) => {
      const { me, p } = await editor(context, params, openEdit, "editId");
      return renderAction(ctx, me.companyId, p, { userId: me.userId });
    });
    action("video-edit-cancel-render", async (params, context) => {
      const { me, p } = await editor(context, params, openRender, "renderId");
      return cancelRenderAction(ctx, me.companyId, p, { userId: me.userId });
    });
    action("video-edit-versions-list", async (params, context) => {
      const { me, p } = await reader(context, params, openEdit, "editId");
      return listVersionsAction(ctx, me.companyId, p);
    });
    action("video-edit-version-save", async (params, context) => {
      const { me, p } = await editor(context, params, openEdit, "editId");
      return saveVersionAction(ctx, me.companyId, p, { userId: me.userId });
    });
    action("video-edit-restore", async (params, context) => {
      const { me, p } = await editor(context, params, openEdit, "editId");
      return restoreVersionAction(ctx, me.companyId, p, { userId: me.userId });
    });
    action("video-edit-delete", async (params, context) => {
      const { me, p } = await editor(context, params, openEdit, "editId");
      return deleteEditAction(ctx, me.companyId, p, { userId: me.userId });
    });
    // Versions and card comments: anyone in the company reads them; only editors save, restore or comment.
    pageData("canvas-versions", async (companyId, p, restriction) => {
      await openCanvas(companyId, p.canvasId, restriction);
      return listVersions(ctx, companyId, String(p.canvasId ?? "")).then((versions) => ({ versions }));
    });
    pageData("canvas-comments", async (companyId, p, restriction) => {
      await openCanvas(companyId, p.canvasId, restriction);
      return listComments(ctx, companyId, String(p.canvasId ?? ""), p.cardId).then((comments) => ({ comments }));
    });
    // Each write below checks the board's client first; `canvasEditor` keeps viewers out (PAR-14298).
    const boardEditor = async (context: Parameters<typeof person>[0], params: unknown) => {
      const me = await canvasEditor(context);
      const p = objectParams(params);
      await openCanvas(me.companyId, p.canvasId, me.restriction);
      return { me, p };
    };
    action("canvas-version-save", async (params, context) => {
      const { me, p } = await boardEditor(context, params);
      return saveVersion(ctx, me.companyId, p, { userId: me.userId });
    });
    action("canvas-version-restore", async (params, context) => {
      const { me, p } = await boardEditor(context, params);
      return restoreVersion(ctx, me.companyId, p, { userId: me.userId });
    });
    action("canvas-comment-add", async (params, context) => {
      const { me, p } = await boardEditor(context, params);
      return addComment(ctx, me.companyId, p, { userId: me.userId });
    });
    // Read-only share links (canvas-share.ts): only editors list, make and revoke them. The list is an action, not
    // page data, because page data has no caller and each entry carries the secret link path.
    action("canvas-share-list", async (params, context) => {
      const me = await canvasEditor(context);
      const canvasId = String(objectParams(params).canvasId ?? "");
      await assertShareOpen(ctx, me.companyId, canvasId, me.restriction);
      return { shares: await listShares(ctx, me.companyId, canvasId) };
    });
    action("canvas-share-create", async (params, context) => {
      const me = await canvasEditor(context);
      return createShare(ctx, me.companyId, objectParams(params), { userId: me.userId, restriction: me.restriction });
    });
    action("canvas-share-revoke", async (params, context) => {
      const me = await canvasEditor(context);
      return revokeShare(ctx, me.companyId, objectParams(params), me.restriction);
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
    // Video renders (PAR-8276 A7a/A7b): one runner per worker. It recovers renders a dead worker left behind now and on
    // every tick, then claims the oldest queued render and runs the pipeline (download, compile, run, verify, upload).
    const renders = createRenderRunner(ctx, { executor: createRenderExecutor() });
    runDetached(() => void renders.recover().catch((error) => ctx.logger.warn("Studio render recovery failed", { error: errorText(error) })));
    ctx.jobs.register("process-renders", async () => {
      await renders.tick();
    });
    ctx.jobs.register("sweep-local-files", async () => {
      await sweepLocalCopies();
      await sweepRenderWorkdirs();
    });
  },

  async onHealth() {
    return { status: "ok" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
