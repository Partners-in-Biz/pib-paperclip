import { memo } from "react";
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
import type { NodeLinkMeta } from "@/components/planning-canvas/nodes/link-meta";
import type { CanvasController } from "@/components/planning-canvas/state/useCanvasController";

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
}: NodeViewProps) {
  const latest = useLatestCanvas();
  const theme = CANVAS_COLOR_THEMES[node.color] ?? CANVAS_COLOR_THEMES.yellow;
  const { containerClass, Render } = NODE_RENDERERS[node.kind];
  const RefRender = link?.refKind ? REF_NODES[link.refKind] : null;
  // A legacy node already shows its first link as a chip when the reader can see its identifier.
  const extraLinks = link ? (RefRender || !node.handedOffIssueIdentifier ? link.links : link.links.slice(1)) : [];

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
        RefRender ? REF_CARD_CLASS : containerClass(node, theme),
      )}
    >
      {RefRender ? (
        <RefRender refId={link!.refId} />
      ) : (
        <Render node={node} isEditing={isEditing} theme={theme} linkedNote={linkedNote} c={latest.current} />
      )}
      <NodeLinks issueIds={extraLinks} />
      <NodeHandles node={node} isSelected={isSelected} isEditing={isEditing} showConnectHandles={showConnectHandles} />
    </div>
  );
});

export function NodesLayer({ c }: { c: CanvasController }) {
  const { sortedNodes, selectedNodeIds, editingNodeId, connectFromId, notesById } = c;
  const linkMeta = c.opStore.linkMeta;
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
            link={linkMeta.get(node.id)}
          />
        );
      })}
    </>
  );
}
