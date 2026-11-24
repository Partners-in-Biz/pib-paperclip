import { memo, useRef } from "react";
import { CANVAS_COLOR_THEMES } from "@/lib/planning-canvas-helpers";
import { cn } from "@/lib/utils";
import type { CanvasNode, PersonalNote } from "@paperclipai/shared";
import { useLatestCanvas } from "@/components/planning-canvas/nodes/canvas-context";
import { NodeHandles } from "@/components/planning-canvas/nodes/NodeHandles";
import { NODE_RENDERERS } from "@/components/planning-canvas/nodes/node-renderers";
import { REF_CARD_CLASS } from "@/components/planning-canvas/nodes/RefCard";
import { AgentNode } from "@/components/planning-canvas/nodes/AgentNode";
import { GoalNode } from "@/components/planning-canvas/nodes/GoalNode";
import { IssueNode } from "@/components/planning-canvas/nodes/IssueNode";
import { ProjectNode } from "@/components/planning-canvas/nodes/ProjectNode";
import { NodeLinks } from "@/components/planning-canvas/nodes/NodeLinks";
import { TableNode } from "@/components/planning-canvas/nodes/TableNode";
import { MarkdownNode } from "@/components/planning-canvas/nodes/MarkdownNode";
import { KanbanNode } from "@/components/planning-canvas/nodes/KanbanNode";
import { TimelineNode } from "@/components/planning-canvas/nodes/TimelineNode";
import type { TypedNodeMeta } from "@/components/planning-canvas/nodes/typed-meta";
import type { NodeLinkMeta } from "@/components/planning-canvas/nodes/link-meta";
import { nodeAriaLabel } from "@/components/planning-canvas/panels/outline/outline-order";
import type { CanvasController } from "@/components/planning-canvas/state/useCanvasController";

/** Hold this long on touch to open the node menu (C19). */
const LONG_PRESS_MS = 500;
/** A finger that moves further than this is a drag, not a press. */
const LONG_PRESS_SLOP = 8;

/** Handlers shared by both detail levels: right-click and long-press open the node menu. */
function useNodeMenu(node: CanvasNode) {
  const latest = useLatestCanvas();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  return {
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      cancel();
      latest.current.setSelectedNodeIds([node.id]);
      latest.current.setContextMenu({ nodeId: node.id, x: e.clientX, y: e.clientY });
    },
    onPointerDownCapture: (e: React.PointerEvent) => {
      if (e.pointerType !== "touch" || !e.isPrimary) return;
      origin.current = { x: e.clientX, y: e.clientY };
      cancel();
      const { clientX: x, clientY: y } = e;
      timer.current = setTimeout(() => {
        timer.current = null;
        latest.current.setSelectedNodeIds([node.id]);
        latest.current.setContextMenu({ nodeId: node.id, x, y });
      }, LONG_PRESS_MS);
    },
    onPointerMoveCapture: (e: React.PointerEvent) => {
      const o = origin.current;
      if (timer.current && o && Math.hypot(e.clientX - o.x, e.clientY - o.y) > LONG_PRESS_SLOP) cancel();
    },
    onPointerUpCapture: cancel,
    onPointerCancelCapture: cancel,
  };
}

/** Every node is a focusable, labelled group (C19); the focus ring uses the ring token. */
function nodeA11y(node: CanvasNode, isSelected: boolean) {
  return {
    role: "group" as const,
    tabIndex: isSelected ? 0 : -1,
    "aria-label": nodeAriaLabel(node),
  };
}

const REF_NODES = { issue: IssueNode, agent: AgentNode, project: ProjectNode, goal: GoalNode } as const;

type NodeViewProps = {
  node: CanvasNode;
  isSelected: boolean;
  isEditing: boolean;
  isConnectFrom: boolean;
  showConnectHandles: boolean;
  linkedNote: PersonalNote | null | undefined;
  /** Ref and link ids of a linked-entity node, or of any node handed to agents (C10). */
  link: NodeLinkMeta | undefined;
  /** Typed data of a table or markdown node (C16). */
  typed: TypedNodeMeta | undefined;
  /** Below zoom 0.4 (C17): a plain card in the node's colours, no content, handles or queries. */
  lowDetail: boolean;
};

/**
 * One canvas node. Memoized so a pan or zoom (viewport-only change) does not re-render every node;
 * it re-renders only when its own node, selection, editing or link state changes.
 */
const NodeView = memo(function NodeView({
  node,
  isSelected,
  isEditing,
  isConnectFrom,
  showConnectHandles,
  linkedNote,
  link,
  typed,
  lowDetail,
}: NodeViewProps) {
  const latest = useLatestCanvas();
  const theme = CANVAS_COLOR_THEMES[node.color] ?? CANVAS_COLOR_THEMES.yellow;
  const { containerClass, Render } = NODE_RENDERERS[node.kind];
  const RefRender = link?.refKind ? REF_NODES[link.refKind] : null;
  const menu = useNodeMenu(node);
  const box = { left: node.x, top: node.y, width: node.width, height: node.height, zIndex: node.kind === "frame" ? 1 : node.zIndex };

  if (lowDetail) {
    return (
      <div
        data-canvas-item={node.id}
        data-canvas-lod="low"
        {...nodeA11y(node, isSelected)}
        {...menu}
        onPointerDown={(e) => latest.current.handleNodePointerDown(e, node)}
        style={box}
        className={cn(
          "pointer-events-auto absolute overflow-hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          isSelected && "ring-2 ring-blue-500 ring-offset-2 ring-offset-background",
          RefRender || typed ? REF_CARD_CLASS : containerClass(node, theme),
        )}
      />
    );
  }
  // A legacy node already shows its first link as a chip when the reader can see its identifier.
  const extraLinks = link ? (RefRender || !node.handedOffIssueIdentifier ? link.links : link.links.slice(1)) : [];

  return (
    <div
      data-canvas-item={node.id}
      data-canvas-lod="full"
      {...nodeA11y(node, isSelected)}
      {...menu}
      onPointerDown={(e) => latest.current.handleNodePointerDown(e, node)}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (node.kind !== "note") latest.current.setEditingNodeId(node.id);
      }}
      style={box}
      className={cn(
        "pointer-events-auto absolute transition-shadow focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        isSelected && "ring-2 ring-blue-500 ring-offset-2 ring-offset-background",
        isConnectFrom && "ring-2 ring-amber-500",
        RefRender || typed ? REF_CARD_CLASS : containerClass(node, theme),
      )}
    >
      {RefRender ? (
        <RefRender refId={link!.refId} />
      ) : typed?.kind === "table" ? (
        <TableNode nodeKey={node.id} data={typed.data} title={node.title} />
      ) : typed?.kind === "markdown" ? (
        <MarkdownNode nodeKey={node.id} data={typed.data} title={node.title} />
      ) : typed?.kind === "kanban" ? (
        <KanbanNode nodeKey={node.id} data={typed.data} title={node.title} />
      ) : typed?.kind === "timeline" ? (
        <TimelineNode nodeKey={node.id} data={typed.data} title={node.title} />
      ) : (
        <Render node={node} isEditing={isEditing} theme={theme} linkedNote={linkedNote} c={latest.current} />
      )}
      <NodeLinks issueIds={extraLinks} />
      <NodeHandles node={node} isSelected={isSelected} isEditing={isEditing} showConnectHandles={showConnectHandles} />
    </div>
  );
});

type NodesLayerProps = Pick<CanvasController, "selectedNodeIds" | "editingNodeId" | "connectFromId" | "notesById"> & {
  /** The culled nodes in paint order (C17). */
  nodes: CanvasNode[];
  linkMeta: CanvasController["opStore"]["linkMeta"];
  typedMeta: CanvasController["opStore"]["typedMeta"];
  lowDetail: boolean;
};

/** Memoized: a pan that keeps the same culled set re-renders nothing here. */
export const NodesLayer = memo(function NodesLayer({ nodes, selectedNodeIds, editingNodeId, connectFromId, notesById, linkMeta, typedMeta, lowDetail }: NodesLayerProps) {
  return (
    <>
      {nodes.map((node) => {
        const isSelected = selectedNodeIds.includes(node.id);
        const isEditing = editingNodeId === node.id;
        return (
          <NodeView
            key={node.id}
            node={node}
            isSelected={isSelected}
            isEditing={isEditing}
            isConnectFrom={connectFromId === node.id}
            showConnectHandles={isSelected && selectedNodeIds.length === 1 && !isEditing}
            linkedNote={node.noteId ? notesById.get(node.noteId) : null}
            link={linkMeta.get(node.id)}
            typed={typedMeta?.get(node.id)}
            lowDetail={lowDetail && !isEditing}
          />
        );
      })}
    </>
  );
});
