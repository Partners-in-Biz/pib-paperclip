import { Maximize2, Minus, Plus } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import type { CanvasNode } from "@paperclipai/shared";
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
        className="relative h-24 w-36 cursor-pointer max-md:hidden overflow-hidden rounded-lg border border-border bg-popover/90 p-1.5 shadow-md backdrop-blur-xs"
      >
        <MinimapDots nodes={nodes} />
      </div>
    ) : null
  );
}

/** Minimap size inside its padding (the card is h-24 w-36 with p-1.5). */
const MINIMAP_W = 132;
const MINIMAP_H = 84;

/**
 * One canvas, redrawn only when the node list changes (C17). Thousands of absolutely positioned
 * dots made every pan frame lay all of them out again.
 */
const MinimapDots = memo(function MinimapDots({ nodes }: { nodes: CanvasNode[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = MINIMAP_W * ratio;
    canvas.height = MINIMAP_H * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, MINIMAP_W, MINIMAP_H);
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
    const scale = Math.min((MINIMAP_W - 4) / spanX, (MINIMAP_H - 4) / spanY);
    for (const n of nodes) {
      const color = (CANVAS_COLOR_THEMES[n.color] ?? CANVAS_COLOR_THEMES.amber).strokeHex;
      const x = (n.x - minX) * scale;
      const y = (n.y - minY) * scale;
      const w = Math.max(2, n.width * scale);
      const h = Math.max(1.5, n.height * scale);
      if (n.kind === "frame") {
        ctx.globalAlpha = 0.45;
        ctx.strokeStyle = color;
        ctx.strokeRect(x, y, w, h);
      } else {
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = color;
        ctx.fillRect(x, y, w, h);
      }
    }
    ctx.globalAlpha = 1;
  }, [nodes]);
  return <canvas ref={ref} aria-hidden className="size-full" data-testid="planning-canvas-minimap" />;
});

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
    <div className="pointer-events-auto absolute bottom-3 right-3 z-20 flex flex-col items-end gap-2 md:right-full md:mr-3 max-md:bottom-16 max-md:left-3 max-md:right-auto max-md:items-start">
      {/* Compact Minimap (hidden on a phone: it covered the board and the Chat button) */}
      <Minimap c={c} />
      <ZoomControls c={c} />
    </div>
  );
}
