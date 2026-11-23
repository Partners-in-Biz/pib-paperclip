import type { ComponentType } from "react";
import { BoardBar } from "@/components/planning-canvas/panels/BoardBar";
import { BottomRightControls } from "@/components/planning-canvas/panels/BottomRightControls";
import { NotesDrawer } from "@/components/planning-canvas/panels/NotesDrawer";
import { ToolRail } from "@/components/planning-canvas/panels/ToolRail";
import {
  ConnectHint,
  ContextToolbar,
  MultiSelectToolbar,
  PenToolbar,
} from "@/components/planning-canvas/toolbar/FloatingToolbars";
import type { CanvasController } from "@/components/planning-canvas/state/useCanvasController";

export type PanelSlotId = "top" | "left" | "floating" | "right" | "bottomRight";

type PanelEntry = { id: string; Component: ComponentType<{ c: CanvasController }> };

/**
 * Panel slots (PAR-13933). The page renders each slot in a fixed place; a later ticket adds a
 * panel (Outline, Comments, ...) by adding an entry here, not by editing the page.
 */
export const PANEL_SLOTS: Record<PanelSlotId, PanelEntry[]> = {
  top: [{ id: "board-bar", Component: BoardBar }],
  left: [{ id: "tool-rail", Component: ToolRail }],
  floating: [
    { id: "pen-toolbar", Component: PenToolbar },
    { id: "multi-select-toolbar", Component: MultiSelectToolbar },
    { id: "connect-hint", Component: ConnectHint },
    { id: "context-toolbar", Component: ContextToolbar },
  ],
  right: [{ id: "notes-drawer", Component: NotesDrawer }],
  bottomRight: [{ id: "zoom-controls", Component: BottomRightControls }],
};

export function PanelSlot({ id, c }: { id: PanelSlotId; c: CanvasController }) {
  return (
    <>
      {PANEL_SLOTS[id].map(({ id: panelId, Component }) => (
        <Component key={panelId} c={c} />
      ))}
    </>
  );
}
