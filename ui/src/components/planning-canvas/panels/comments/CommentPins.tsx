import { MessageSquare } from "lucide-react";
import { useCanvasComments } from "@/components/planning-canvas/panels/comments/useCanvasComments";
import type { CanvasController } from "@/components/planning-canvas/state/useCanvasController";
import { cn } from "@/lib/utils";

/**
 * One pin per node that has comments, at the node's top-right corner, with the open-thread count and
 * an unread dot. Pins live in screen space (outside the zoomed layer), so they keep one size at any zoom.
 */
export function CommentPins({ c }: { c: CanvasController }) {
  const { selectedCompanyId, activeBoard, nodes, viewport, commentThread, setCommentThread, setTool } = c;
  const { threads } = useCanvasComments(selectedCompanyId, activeBoard?.id);
  if (threads.size === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden" data-testid="canvas-comment-pins">
      {nodes.map((node) => {
        const thread = threads.get(node.id);
        if (!thread) return null;
        const left = viewport.x + (node.x + node.width) * viewport.zoom;
        const top = viewport.y + node.y * viewport.zoom;
        const active = commentThread?.key === node.id;
        const resolved = thread.openCount === 0;
        return (
          <button
            key={node.id}
            type="button"
            style={{ left, top }}
            aria-label={`${thread.count} comment${thread.count === 1 ? "" : "s"}${thread.unread ? ", unread" : ""}${resolved ? ", resolved" : ""}`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => {
              setTool("select");
              setCommentThread({ key: node.id });
            }}
            className={cn(
              "pointer-events-auto absolute flex h-6 min-w-6 -translate-x-1/2 -translate-y-1/2 items-center gap-0.5 rounded-full border px-1.5 text-xs font-medium shadow-sm transition-colors",
              resolved
                ? "border-border bg-muted text-muted-foreground"
                : "border-primary bg-primary text-primary-foreground",
              active && "ring-2 ring-ring ring-offset-1 ring-offset-background",
            )}
          >
            <MessageSquare className="size-3" aria-hidden />
            {thread.count}
            {thread.unread ? (
              <span
                data-testid="comment-unread-dot"
                className="absolute -right-0.5 -top-0.5 size-2 rounded-full border border-background bg-destructive"
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
