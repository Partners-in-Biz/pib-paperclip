import { memo } from "react";
import { CANVAS_COLOR_THEMES } from "@/lib/planning-canvas-helpers";
import { cn } from "@/lib/utils";
import type { CanvasNode, PersonalNote } from "@paperclipai/shared";
import { useLatestCanvas } from "@/components/planning-canvas/nodes/canvas-context";
import { NodeHandles } from "@/components/planning-canvas/nodes/NodeHandles";
import { NODE_RENDERERS } from "@/components/planning-canvas/nodes/node-renderers";
import type { CanvasController } from "@/components/planning-canvas/state/useCanvasController";

type NodeViewProps = {
  node: CanvasNode;
  isSelected: boolean;
  isEditing: boolean;
  isConnectFrom: boolean;
  showConnectHandles: boolean;
  linkedNote: PersonalNote | null | undefined;
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
}: NodeViewProps) {
  const latest = useLatestCanvas();
  const theme = CANVAS_COLOR_THEMES[node.color] ?? CANVAS_COLOR_THEMES.yellow;
  const { containerClass, Render } = NODE_RENDERERS[node.kind];

  return (
    <div
      onMouseDown={(e) => latest.current.handleNodeMouseDown(e, node)}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (node.kind !== "note") latest.current.setEditingNodeId(node.id);
      }}
      style={{
        left: node.x,
        top: node.y,
        width: node.width,
        height: node.height,
        zIndex: node.kind === "frame" ? 1 : node.zIndex,
      }}
      className={cn(
        "pointer-events-auto absolute transition-shadow",
        isSelected && "ring-2 ring-blue-500 ring-offset-2 ring-offset-background",
        isConnectFrom && "ring-2 ring-amber-500",
        containerClass(node, theme),
      )}
    >
      <Render node={node} isEditing={isEditing} theme={theme} linkedNote={linkedNote} c={latest.current} />
      <NodeHandles node={node} isSelected={isSelected} isEditing={isEditing} showConnectHandles={showConnectHandles} />
    </div>
  );
});

export function NodesLayer({ c }: { c: CanvasController }) {
  const { sortedNodes, selectedNodeIds, editingNodeId, connectFromId, notesById } = c;
  return (
    <>
      {sortedNodes.map((node) => {
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
          />
        );
      })}
    </>
  );
}
