/**
 * The video edit agent tools (PAR-8276 A8b): the same functions as the page actions (actions.ts), called with the
 * agent's run. Reads are open to the company; every tool is company-scoped by the run. The project comes from the
 * issue of the run unless the call names one.
 */
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { StudioError } from "../errors.js";
import { applyOpsAction, cancelRenderAction, createEditAction, deleteEditAction, getEditAction, listEditsAction, renderAction, renderStatusAction, type ActionDeps } from "./actions.js";
import { captionClipAction, type CaptionDeps } from "./auto-caption.js";
import { detectBeatsAction, type BeatDeps } from "./beats.js";
import { musicAction, type MusicDeps } from "./music.js";
import { voiceoverAction, type VoiceoverDeps } from "./voiceover.js";

export const VIDEO_EDIT_TOOL_NAMES = [
  "video-edit-create",
  "video-edit-get",
  "video-edit-list",
  "video-edit-apply-ops",
  "video-edit-caption",
  "video-edit-render",
  "video-edit-render-status",
  "video-edit-cancel-render",
  "video-edit-delete",
  "video-edit-voiceover",
  "video-edit-music",
  "video-edit-detect-beats",
] as const;

export const isVideoEditTool = (name: string): boolean => (VIDEO_EDIT_TOOL_NAMES as readonly string[]).includes(name);

/** Runs one video edit tool. `work.projectId` is the project of the run's issue (worker.ts workOf). */
export async function runVideoEditTool(
  ctx: PluginContext,
  name: string,
  params: Record<string, unknown>,
  run: Pick<ToolRunContext, "companyId" | "agentId"> & { runId?: string },
  work: { projectId: string | null; issueId?: string | null },
  deps: ActionDeps & CaptionDeps & { voiceover?: VoiceoverDeps; music?: MusicDeps; beats?: BeatDeps } = {},
): Promise<unknown> {
  const companyId = run.companyId;
  const actor = { agentId: run.agentId };
  switch (name) {
    case "video-edit-create": {
      const projectId = (typeof params.projectId === "string" && params.projectId.trim()) || work.projectId;
      return createEditAction(ctx, companyId, { ...params, projectId }, actor, deps);
    }
    case "video-edit-get":
      return getEditAction(ctx, companyId, params);
    case "video-edit-list":
      return listEditsAction(ctx, companyId, params);
    case "video-edit-apply-ops":
      return applyOpsAction(ctx, companyId, params, actor);
    case "video-edit-caption":
      return captionClipAction(ctx, companyId, params, actor, deps);
    case "video-edit-render":
      return renderAction(ctx, companyId, params, actor);
    case "video-edit-render-status":
      return renderStatusAction(ctx, companyId, params);
    case "video-edit-cancel-render":
      return cancelRenderAction(ctx, companyId, params, actor);
    case "video-edit-delete":
      return deleteEditAction(ctx, companyId, params, actor);
    case "video-edit-voiceover":
      // The run id lets the per-run spend limit apply, like studio-generate.
      return voiceoverAction(ctx, companyId, params, { agentId: run.agentId, runId: run.runId ?? null, issueId: work.issueId ?? null }, deps.voiceover);
    case "video-edit-music":
      return musicAction(ctx, companyId, params, { agentId: run.agentId, runId: run.runId ?? null, issueId: work.issueId ?? null }, deps.music);
    case "video-edit-detect-beats":
      return detectBeatsAction(ctx, companyId, params, deps.beats);
    default:
      throw new StudioError(`Unknown tool ${name}`);
  }
}
