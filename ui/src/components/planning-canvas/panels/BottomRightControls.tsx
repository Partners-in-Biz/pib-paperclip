import { Maximize2, Minus, Plus } from "lucide-react";
import { clampZoom } from "@/components/planning-canvas/canvas-constants";
import { type CanvasController } from "@/components/planning-canvas/state/useCanvasController";
import { Button } from "@/components/ui/button";
import { CANVAS_COLOR_THEMES } from "@/lib/planning-canvas-helpers";
import { cn } from "@/lib/utils";

export function Minimap({ c }: { c: CanvasController }) {
  const {
    nodes,
    fitToScreen,
  } = c;
  return (
    nodes.length > 0 ? (
      <div
        onClick={fitToScreen}
        title="Click to fit all items in view"
        className="relative h-24 w-36 cursor-pointer overflow-hidden rounded-lg border border-border bg-popover/90 p-1.5 shadow-md backdrop-blur-xs"
      >
        {(() => {
          let minX = Infinity;
          let minY = Infinity;
          let maxX = -Infinity;
          let maxY = -Infinity;
          for (const n of nodes) {
            minX = Math.min(minX, n.x);
            minY = Math.min(minY, n.y);
            maxX = Math.max(maxX, n.x + n.width);
            maxY = Math.max(maxY, n.y + n.height);
          }
          const spanX = Math.max(400, maxX - minX);
          const spanY = Math.max(300, maxY - minY);
          const scale = Math.min(130 / spanX, 82 / spanY);
          return nodes.map((n) => (
            <div
              key={n.id}
              style={{
                left: 6 + (n.x - minX) * scale,
                top: 6 + (n.y - minY) * scale,
                width: Math.max(4, n.width * scale),
                height: Math.max(3, n.height * scale),
              }}
              className={cn(
                "absolute rounded-[2px]",
                n.kind === "frame"
                  ? "border border-muted-foreground/40 bg-muted/30"
                  : CANVAS_COLOR_THEMES[n.color]?.swatch ?? "bg-amber-400",
              )}
            />
          ));
        })()}
      </div>
    ) : null
  );
}

export function ZoomControls({ c }: { c: CanvasController }) {
  const {
    viewport,
    setViewport,
    fitToScreen,
  } = c;
  return (
    <div className="flex items-center gap-1 rounded-xl border border-border bg-popover/95 px-2 py-1 shadow-md backdrop-blur-xs">
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="Zoom out"
        onClick={() => setViewport((v) => ({ ...v, zoom: clampZoom(v.zoom - 0.15) }))}
      >
        <Minus className="size-3.5" />
      </Button>
      <button
        type="button"
        onClick={() => setViewport((v) => ({ ...v, zoom: 1 }))}
        className="min-w-11 rounded px-1.5 py-0.5 text-center font-mono text-xs text-foreground hover:bg-accent"
        title="Reset zoom to 100%"
      >
        {Math.round(viewport.zoom * 100)}%
      </button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="Zoom in"
        onClick={() => setViewport((v) => ({ ...v, zoom: clampZoom(v.zoom + 0.15) }))}
      >
        <Plus className="size-3.5" />
      </Button>
      <div className="mx-0.5 h-4 w-px bg-border" />
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        title="Fit board to screen"
        aria-label="Fit to screen"
        onClick={fitToScreen}
      >
        <Maximize2 className="size-3.5" />
      </Button>
    </div>
  );
}

export function BottomRightControls({ c }: { c: CanvasController }) {
  return (
    <div className="pointer-events-auto absolute bottom-3 right-3 z-20 flex flex-col items-end gap-2">
      {/* Compact Minimap */}
      <Minimap c={c} />
      <ZoomControls c={c} />
    </div>
  );
}
