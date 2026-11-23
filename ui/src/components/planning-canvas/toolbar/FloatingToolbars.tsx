import { CANVAS_NODE_COLORS, type CanvasShapeVariant } from "@paperclipai/shared";
import { AlignHorizontalJustifyStart, AlignVerticalJustifyStart, CalendarClock, Copy, Eraser, Highlighter, LayoutGrid, Send, Sparkles, Trash2 } from "lucide-react";
import { type CanvasController } from "@/components/planning-canvas/state/useCanvasController";
import { Button } from "@/components/ui/button";
import { CANVAS_COLOR_THEMES } from "@/lib/planning-canvas-helpers";
import { cn } from "@/lib/utils";

export function PenToolbar({ c }: { c: CanvasController }) {
  const {
    nodes,
    connectors,
    strokes,
    tool,
    penColor,
    setPenColor,
    penHighlighter,
    setPenHighlighter,
    commitCanvasChange,
  } = c;
  return (
    tool === "pen" ? (
      <div className="pointer-events-auto absolute left-1/2 top-3 z-30 flex -translate-x-1/2 items-center gap-2 rounded-xl border border-border bg-popover/95 px-3 py-1.5 shadow-lg backdrop-blur-xs">
        <div className="flex items-center gap-1">
          {CANVAS_NODE_COLORS.map((c) => {
            const theme = CANVAS_COLOR_THEMES[c];
            return (
              <button
                key={c}
                type="button"
                aria-label={`Pen color ${theme.label}`}
                onClick={() => setPenColor(c)}
                className={cn(
                  "size-4 rounded-full transition-transform",
                  theme.swatch,
                  penColor === c
                    ? "scale-110 ring-2 ring-foreground/60 ring-offset-1 ring-offset-background"
                    : "opacity-75 hover:opacity-100",
                )}
              />
            );
          })}
        </div>
        <div className="h-4 w-px bg-border" />
        <Button
          type="button"
          size="xs"
          variant={penHighlighter ? "secondary" : "ghost"}
          onClick={() => setPenHighlighter((h) => !h)}
        >
          <Highlighter className="size-3.5" />
          {penHighlighter ? "Highlighter" : "Pen"}
        </Button>
        {strokes.length > 0 ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => commitCanvasChange(nodes, connectors, [])}
          >
            <Eraser className="size-3.5" />
            Clear ink ({strokes.length})
          </Button>
        ) : null}
      </div>
    ) : null
  );
}

export function MultiSelectToolbar({ c }: { c: CanvasController }) {
  const {
    selectedNodeIds,
    deleteSelection,
    duplicateSelection,
    handleAlignSelection,
    handleDelegateMultiSelection,
  } = c;
  return (
    selectedNodeIds.length > 1 ? (
      <div className="pointer-events-auto absolute left-1/2 top-3 z-30 flex -translate-x-1/2 flex-wrap items-center gap-1.5 rounded-xl border border-border bg-popover/95 px-2.5 py-1.5 shadow-lg backdrop-blur-xs">
        <span className="px-1 text-xs font-semibold text-foreground">
          {selectedNodeIds.length} selected
        </span>
        <div className="h-4 w-px bg-border" />
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          title="Align left"
          aria-label="Align left"
          onClick={() => handleAlignSelection("left")}
        >
          <AlignHorizontalJustifyStart className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          title="Align top"
          aria-label="Align top"
          onClick={() => handleAlignSelection("top")}
        >
          <AlignVerticalJustifyStart className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          title="Distribute horizontally"
          onClick={() => handleAlignSelection("distribute-h")}
        >
          Row
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          title="Tidy into grid"
          onClick={() => handleAlignSelection("tidy-grid")}
        >
          <LayoutGrid className="size-3.5" />
          Tidy
        </Button>
        <div className="h-4 w-px bg-border" />
        <Button type="button" size="xs" onClick={handleDelegateMultiSelection}>
          <Send className="size-3" />
          Give {selectedNodeIds.length} to agent
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          title="Duplicate (⌘D)"
          aria-label="Duplicate selection"
          onClick={duplicateSelection}
        >
          <Copy className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          title="Delete (⌫)"
          aria-label="Delete selection"
          onClick={deleteSelection}
        >
          <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
        </Button>
      </div>
    ) : null
  );
}

export function ConnectHint({ c }: { c: CanvasController }) {
  const {
    tool,
    connectFromId,
  } = c;
  return (
    tool === "connect" ? (
      <div className="pointer-events-none absolute left-1/2 top-3 z-30 -translate-x-1/2 rounded-full border border-border bg-popover/95 px-3.5 py-1 text-xs font-medium text-foreground shadow-md">
        {connectFromId
          ? "Click a target card to complete the arrow (Esc to cancel)"
          : "Click a source card to start drawing a connector arrow"}
      </div>
    ) : null
  );
}

export function ContextToolbar({ c }: { c: CanvasController }) {
  const {
    notesById,
    nodes,
    connectors,
    setConnectors,
    selectedConnectorId,
    setScheduleNote,
    promoteStickyToNoteMutation,
    commitCanvasChange,
    deleteSelection,
    duplicateSelection,
    handleGiveNodeToAgent,
    primarySelectedNode,
  } = c;
  return (
    primarySelectedNode ? (
      <div className="pointer-events-auto absolute left-1/2 top-3 z-30 flex -translate-x-1/2 flex-wrap items-center gap-1.5 rounded-xl border border-border bg-popover/95 px-2.5 py-1.5 shadow-lg backdrop-blur-xs">
        <div className="flex items-center gap-1">
          {CANVAS_NODE_COLORS.map((c) => {
            const theme = CANVAS_COLOR_THEMES[c];
            return (
              <button
                key={c}
                type="button"
                aria-label={`Color ${theme.label}`}
                title={theme.label}
                onClick={() =>
                  commitCanvasChange(
                    nodes.map((n) => (n.id === primarySelectedNode.id ? { ...n, color: c } : n)),
                    connectors,
                  )
                }
                className={cn(
                  "size-4 rounded-full transition-transform",
                  theme.swatch,
                  primarySelectedNode.color === c
                    ? "scale-110 ring-2 ring-foreground/60 ring-offset-1 ring-offset-background"
                    : "opacity-75 hover:opacity-100",
                )}
              />
            );
          })}
        </div>

        {primarySelectedNode.kind === "shape" ? (
          <>
            <div className="h-4 w-px bg-border" />
            <div className="flex items-center gap-1 text-[11px]">
              {(["rect", "pill", "diamond"] as CanvasShapeVariant[]).map((variant) => (
                <button
                  key={variant}
                  type="button"
                  onClick={() =>
                    commitCanvasChange(
                      nodes.map((n) =>
                        n.id === primarySelectedNode.id ? { ...n, shape: variant } : n,
                      ),
                      connectors,
                    )
                  }
                  className={cn(
                    "rounded px-1.5 py-0.5 capitalize transition-colors",
                    (primarySelectedNode.shape ?? "rect") === variant
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:bg-accent",
                  )}
                >
                  {variant}
                </button>
              ))}
            </div>
          </>
        ) : null}

        <div className="h-4 w-px bg-border" />

        <Button
          type="button"
          size="xs"
          onClick={() => handleGiveNodeToAgent(primarySelectedNode)}
        >
          <Send className="size-3" />
          {primarySelectedNode.kind === "frame" ? "Delegate frame" : "Give to agent"}
        </Button>

        {primarySelectedNode.kind === "note" && primarySelectedNode.noteId && notesById.get(primarySelectedNode.noteId) ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => setScheduleNote(notesById.get(primarySelectedNode.noteId!) ?? null)}
          >
            <CalendarClock className="size-3 text-amber-500" />
            Schedule
          </Button>
        ) : null}

        {primarySelectedNode.kind === "sticky" ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={promoteStickyToNoteMutation.isPending}
            onClick={() => promoteStickyToNoteMutation.mutate(primarySelectedNode)}
            title="Save this sticky as a full Personal Note"
          >
            <Sparkles className="size-3 text-violet-500" />
            Promote to Note
          </Button>
        ) : null}

        <div className="h-4 w-px bg-border" />

        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          title="Duplicate (⌘D)"
          aria-label="Duplicate"
          onClick={duplicateSelection}
        >
          <Copy className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          title="Delete (⌫)"
          aria-label="Delete"
          onClick={deleteSelection}
        >
          <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
        </Button>
      </div>
    ) : selectedConnectorId ? (
      <div className="pointer-events-auto absolute left-1/2 top-3 z-30 flex -translate-x-1/2 items-center gap-2 rounded-xl border border-border bg-popover/95 px-3 py-1.5 shadow-lg">
        <input
          type="text"
          placeholder="Arrow label…"
          value={connectors.find((c) => c.id === selectedConnectorId)?.label ?? ""}
          onChange={(e) => {
            const label = e.target.value;
            setConnectors((prev) =>
              prev.map((c) => (c.id === selectedConnectorId ? { ...c, label } : c)),
            );
          }}
          className="h-6 w-36 rounded border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-ring"
        />
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() => {
            commitCanvasChange(
              nodes,
              connectors.map((c) =>
                c.id === selectedConnectorId ? { ...c, dashed: !c.dashed } : c,
              ),
            );
          }}
        >
          Dashed
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Delete connector"
          onClick={deleteSelection}
        >
          <Trash2 className="size-3.5 text-destructive" />
        </Button>
      </div>
    ) : null
  );
}
