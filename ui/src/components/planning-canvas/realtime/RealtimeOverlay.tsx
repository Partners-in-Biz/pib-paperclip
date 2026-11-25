import { useSyncExternalStore } from "react";
import { MousePointer2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { peerColor } from "@/components/planning-canvas/realtime/realtime-view";
import type { CanvasController } from "@/components/planning-canvas/state/useCanvasController";

/** Above every node: node z-indexes grow with each "bring to front". */
const OVERLAY_Z = 1_000_000;
const LABEL_CLASS = "block max-w-48 truncate whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-medium text-white shadow-sm";

/**
 * Others on the board, drawn in world coordinates inside the transformed layer
 * (C15): their selections as coloured rings, their cursors with a name, and a
 * 2 s highlight with the agent's name on nodes an agent just changed. Labels
 * and cursors are counter-scaled so they keep their size at any zoom.
 */
export function RealtimeOverlay({ c }: { c: CanvasController }) {
  const { view, labelFor } = c.realtime;
  const { peers, flashes } = useSyncExternalStore(view.subscribe, view.getSnapshot, view.getSnapshot);
  if (peers.length === 0 && flashes.size === 0) return null;
  const { nodeById } = c;
  const inverse = 1 / c.viewport.zoom;

  return (
    <div className="pointer-events-none absolute left-0 top-0" style={{ zIndex: OVERLAY_Z }} data-testid="planning-canvas-realtime-overlay">
      {peers.flatMap((peer) =>
        peer.selection.map((key) => {
          const node = nodeById.get(key);
          if (!node) return null;
          return (
            <div
              key={`${peer.clientId}:${key}`}
              data-testid="planning-canvas-remote-selection"
              className={cn("absolute rounded-lg ring-2 ring-offset-2 ring-offset-background", peerColor(peer.actor).ring)}
              style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
            />
          );
        }),
      )}
      {[...flashes].map(([key, flash]) => {
        const node = nodeById.get(key);
        if (!node) return null;
        const color = peerColor(flash.actor);
        return (
          <div
            key={`flash:${key}`}
            data-testid="planning-canvas-agent-flash"
            data-node-id={key}
            className={cn("absolute rounded-lg ring-4 motion-safe:animate-pulse", color.ring)}
            style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
          >
            <span className="absolute bottom-full left-0 origin-bottom-left pb-1" style={{ transform: `scale(${inverse})` }}>
              <span className={cn(LABEL_CLASS, color.solid)}>{labelFor(flash.actor)}</span>
            </span>
          </div>
        );
      })}
      {peers.map((peer) => {
        if (!peer.cursor) return null;
        const color = peerColor(peer.actor);
        return (
          <div
            key={`cursor:${peer.clientId}`}
            data-testid="planning-canvas-remote-cursor"
            className="absolute left-0 top-0 origin-top-left transition-transform duration-75 ease-linear motion-reduce:transition-none"
            style={{ transform: `translate3d(${peer.cursor.x}px, ${peer.cursor.y}px, 0) scale(${inverse})` }}
          >
            <MousePointer2 aria-hidden className={cn("size-4 fill-current", color.text)} />
            <span className={cn(LABEL_CLASS, "ml-3", color.solid)}>{labelFor(peer.actor)}</span>
          </div>
        );
      })}
    </div>
  );
}
