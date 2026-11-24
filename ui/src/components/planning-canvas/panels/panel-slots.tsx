import type { ComponentType } from "react";
import { BoardBar } from "@/components/planning-canvas/panels/BoardBar";
import { BlueprintsDialog } from "@/components/planning-canvas/panels/blueprints/BlueprintsDialog";
import { BottomRightControls } from "@/components/planning-canvas/panels/BottomRightControls";
import { CheatSheet } from "@/components/planning-canvas/panels/CheatSheet";
import { CommentPins } from "@/components/planning-canvas/panels/comments/CommentPins";
import { CommentsPanel } from "@/components/planning-canvas/panels/comments/CommentsPanel";
import { PluginCanvasPanels } from "@/components/planning-canvas/panels/PluginCanvasPanels";
import { OutlinePanel } from "@/components/planning-canvas/panels/outline/OutlinePanel";
import { CanvasContextMenu } from "@/components/planning-canvas/toolbar/CanvasContextMenu";
import { ConflictDrafts } from "@/components/planning-canvas/panels/ConflictDrafts";
import { HandoffDialog } from "@/components/planning-canvas/panels/handoff/HandoffDialog";
import { InsertLinkPanel } from "@/components/planning-canvas/panels/InsertLinkPanel";
import { NotesDrawer } from "@/components/planning-canvas/panels/NotesDrawer";
import { RevokedNotice } from "@/components/planning-canvas/realtime/RevokedNotice";
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
  top: [
    { id: "board-bar", Component: BoardBar },
    { id: "access-revoked", Component: RevokedNotice },
  ],
  left: [{ id: "tool-rail", Component: ToolRail }],
  floating: [
    { id: "pen-toolbar", Component: PenToolbar },
    { id: "multi-select-toolbar", Component: MultiSelectToolbar },
    { id: "connect-hint", Component: ConnectHint },
    { id: "context-toolbar", Component: ContextToolbar },
    { id: "conflict-drafts", Component: ConflictDrafts },
    { id: "handoff-dialog", Component: HandoffDialog },
    { id: "blueprints-dialog", Component: BlueprintsDialog },
    { id: "cheat-sheet", Component: CheatSheet },
    { id: "context-menu", Component: CanvasContextMenu },
    { id: "comment-pins", Component: CommentPins },
  ],
  right: [
    { id: "comments-panel", Component: CommentsPanel },
    { id: "outline", Component: OutlinePanel },
    { id: "notes-drawer", Component: NotesDrawer },
    { id: "insert-link-panel", Component: InsertLinkPanel },
    { id: "plugin-panels", Component: PluginCanvasPanels },
  ],
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
