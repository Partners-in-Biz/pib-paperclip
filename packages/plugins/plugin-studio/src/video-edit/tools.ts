/**
 * The video edit agent tools (PAR-8276 A8b): the same functions as the page actions (actions.ts), called with the
 * agent's run. Reads are open to the company; every tool is company-scoped by the run. The project comes from the
 * issue of the run unless the call names one.
 */
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { StudioError } from "../errors.js";
import { applyOpsAction, cancelRenderAction, createEditAction, getEditAction, listEditsAction, renderAction, renderStatusAction, type ActionDeps } from "./actions.js";

export const VIDEO_EDIT_TOOL_NAMES = [
  "video-edit-create",
  "video-edit-get",
  "video-edit-list",
  "video-edit-apply-ops",
  "video-edit-render",
  "video-edit-render-status",
  "video-edit-cancel-render",
] as const;

export const isVideoEditTool = (name: string): boolean => (VIDEO_EDIT_TOOL_NAMES as readonly string[]).includes(name);

/** Runs one video edit tool. `work.projectId` is the project of the run's issue (worker.ts workOf). */
export async function runVideoEditTool(
  ctx: PluginContext,
  name: string,
  params: Record<string, unknown>,
  run: Pick<ToolRunContext, "companyId" | "agentId">,
  work: { projectId: string | null },
  deps: ActionDeps = {},
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
    case "video-edit-render":
      return renderAction(ctx, companyId, params, actor);
    case "video-edit-render-status":
      return renderStatusAction(ctx, companyId, params);
    case "video-edit-cancel-render":
      return cancelRenderAction(ctx, companyId, params, actor);
    default:
      throw new StudioError(`Unknown tool ${name}`);
  }
}
