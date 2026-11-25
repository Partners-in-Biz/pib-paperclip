import { useCallback } from "react";
import type { PluginCanvasBoardProps, PluginCanvasOp } from "@paperclipai/plugin-sdk/ui";
import { planningCanvasesApi } from "@/api/planningCanvases";
import type { CanvasController } from "@/components/planning-canvas/state/useCanvasController";
import type { PlanningCanvasOp } from "@paperclipai/shared";

/**
 * What both canvas slots receive (P2 plan C "Interfaces"). `applyOps` goes through the board's
 * ops endpoint as the viewer, so the server enforces access; the level is passed for display only.
 */
export function useCanvasPluginProps(
  c: Pick<CanvasController, "activeBoard" | "selectedNodeIds" | "selectedCompanyId" | "opStore">,
  selection: string[] = c.selectedNodeIds,
): PluginCanvasBoardProps {
  const { activeBoard, selectedCompanyId, opStore } = c;
  const boardId = activeBoard?.id ?? "";
  const accessLevel = activeBoard?.scope && activeBoard.scope !== "personal" ? (activeBoard.memberAccess ?? "view") : "edit";
  const applyOps = useCallback(
    async (ops: PluginCanvasOp[]) => {
      if (!selectedCompanyId || !boardId) throw new Error("No board is open");
      const result = await planningCanvasesApi.applyOps(selectedCompanyId, boardId, { ops: ops as unknown as PlanningCanvasOp[] });
      void opStore.catchUp();
      return result;
    },
    [selectedCompanyId, boardId, opStore.catchUp],
  );
  return { applyOps, boardId, boardProjectId: activeBoard?.projectId ?? null, accessLevel, selection };
}
