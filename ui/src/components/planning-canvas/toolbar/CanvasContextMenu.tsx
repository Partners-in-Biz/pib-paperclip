import { useEffect, useRef } from "react";
import { Copy, MessageSquareText, Pencil, Trash2 } from "lucide-react";
import { type CanvasController } from "@/components/planning-canvas/state/useCanvasController";
import { RelatedButton } from "@/components/planning-canvas/panels/related/RelatedPanel";
import { cn } from "@/lib/utils";

/** Right-click on a node, or long-press on touch (C19). Same actions as the keys. */
export function CanvasContextMenu({ c }: { c: CanvasController }) {
  const { contextMenu, setContextMenu, nodeById, setEditingNodeId, duplicateSelection, deleteSelection, selectedNodeIds, setChatAsk } = c;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!contextMenu) return;
    ref.current?.querySelector<HTMLElement>("button")?.focus();
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e instanceof PointerEvent && ref.current?.contains(e.target as Node)) return;
      setContextMenu(null);
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", close);
    };
  }, [contextMenu, setContextMenu]);
  const node = contextMenu ? nodeById.get(contextMenu.nodeId) : null;
  if (!contextMenu || !node) return null;
  const left = Math.max(8, Math.min(contextMenu.x, window.innerWidth - 200));
  const top = Math.max(8, Math.min(contextMenu.y, window.innerHeight - 140));
  const item = "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-foreground outline-none hover:bg-accent focus-visible:bg-accent";
  const run = (fn: () => void) => () => {
    setContextMenu(null);
    fn();
  };
  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Node actions"
      data-testid="planning-canvas-context-menu"
      style={{ left, top }}
      className="pointer-events-auto fixed z-50 w-48 rounded-xl border border-border bg-popover p-1 shadow-lg"
    >
      {node.kind !== "note" ? (
        <button type="button" role="menuitem" className={item} onClick={run(() => setEditingNodeId(node.id))}>
          <Pencil className="size-4" /> Edit
        </button>
      ) : null}
      <button type="button" role="menuitem" className={item} onClick={run(duplicateSelection)}>
        <Copy className="size-4" /> Duplicate
      </button>
      <button
        type="button"
        role="menuitem"
        className={item}
        onClick={run(() =>
          setChatAsk((p) => {
            const seq = (p?.seq ?? 0) + 1;
            if (node.kind === "frame") return { itemKeys: [], frameKey: node.id, seq };
            return { itemKeys: selectedNodeIds.includes(node.id) ? [...selectedNodeIds] : [node.id], seq };
          }),
        )}
      >
        <MessageSquareText className="size-4" /> {node.kind === "frame" ? "Ask about this frame" : "Ask about selection"}
      </button>
      <RelatedButton c={c} nodeId={node.id} variant="menu" onPick={() => setContextMenu(null)} />
      <button type="button" role="menuitem" className={cn(item, "text-destructive")} onClick={run(deleteSelection)}>
        <Trash2 className="size-4" /> Delete
      </button>
    </div>
  );
}
