import { memo, useState } from "react";
import { FileText } from "lucide-react";
import { PLANNING_CANVAS_LIMITS, type PlanningCanvasMarkdownData } from "@paperclipai/shared";
import { MarkdownBody } from "@/components/MarkdownBody";
import { useLatestCanvas } from "@/components/planning-canvas/nodes/canvas-context";
import { RefCard } from "@/components/planning-canvas/nodes/RefCard";

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

/**
 * A markdown node. The text is untrusted (an agent or another person wrote it), so it only ever
 * goes through `MarkdownBody`: raw HTML is not rendered, unsafe link schemes are dropped and
 * Mermaid runs lazily with `securityLevel: "strict"`. Double-click edits the source.
 */
export const MarkdownNode = memo(function MarkdownNode({ nodeKey, data, title }: { nodeKey: string; data: PlanningCanvasMarkdownData; title: string }) {
  const latest = useLatestCanvas();
  const [editing, setEditing] = useState(false);

  return (
    <RefCard label={title || "Markdown"} icon={<FileText className="size-3.5" />}>
      <div
        className="min-h-0 flex-1 overflow-auto text-sm"
        onPointerDown={editing ? stop : undefined}
        data-canvas-scroll=""
        onDoubleClick={(e) => {
          stop(e);
          setEditing(true);
        }}
      >
        {editing ? (
          <textarea
            autoFocus
            aria-label="Markdown source"
            className="h-full w-full resize-none bg-transparent font-mono text-xs text-foreground outline-none"
            value={data.markdown}
            maxLength={PLANNING_CANVAS_LIMITS.markdownMaxLength}
            onChange={(e) => latest.current.opStore.setNodeData(nodeKey, { markdown: e.target.value })}
            onBlur={() => setEditing(false)}
          />
        ) : data.markdown.trim() ? (
          <MarkdownBody mediaMode="render">{data.markdown}</MarkdownBody>
        ) : (
          <p className="text-xs text-muted-foreground">Double-click to write markdown.</p>
        )}
      </div>
    </RefCard>
  );
});
