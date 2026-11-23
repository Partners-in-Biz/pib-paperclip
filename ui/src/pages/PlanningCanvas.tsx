import { useRef } from "react";
import { ScheduleNoteHandoffDialog } from "@/components/ScheduleNoteHandoffDialog";
import { ConnectorsLayer, MarqueeOverlay } from "@/components/planning-canvas/canvas/CanvasOverlays";
import { CanvasRefsContext, useCanvasRefs } from "@/components/planning-canvas/nodes/canvas-refs";
import { CanvasRefContext } from "@/components/planning-canvas/nodes/canvas-context";
import { NodesLayer } from "@/components/planning-canvas/nodes/NodeView";
import { PanelSlot } from "@/components/planning-canvas/panels/panel-slots";
import { useCanvasController } from "@/components/planning-canvas/state/useCanvasController";
import { cn } from "@/lib/utils";

/**
 * Planning Canvas page shell (PAR-13933). State lives in `components/planning-canvas/state`,
 * panels register in `panels/panel-slots.tsx` and node kinds in `nodes/node-renderers.tsx`.
 */
export function PlanningCanvas() {
  const c = useCanvasController();
  const latest = useRef(c);
  latest.current = c;
  const linkRefs = useCanvasRefs(c.selectedCompanyId, c.activeBoard?.id, c.opStore.linkMeta, c.opStore.saveState);
  const {
    selectedCompanyId,
    canvasRef,
    tool,
    spacePressed,
    viewport,
    handleCanvasMouseDown,
    handleCanvasWheel,
    scheduleNote,
    setScheduleNote,
    agents,
    projects,
  } = c;

  if (!selectedCompanyId) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        Select a company to open the Planning Canvas.
      </div>
    );
  }

  return (
    <CanvasRefContext.Provider value={latest}>
      <CanvasRefsContext.Provider value={linkRefs}>
      <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background select-none">
        <PanelSlot id="top" c={c} />

        {/* Main Infinite Canvas Area */}
        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          <PanelSlot id="left" c={c} />
          <PanelSlot id="floating" c={c} />

          {/* Infinite Canvas Viewport */}
          <div
            ref={canvasRef}
            data-testid="planning-canvas-viewport"
            onMouseDown={handleCanvasMouseDown}
            onWheel={handleCanvasWheel}
            className={cn(
              "relative flex-1 overflow-hidden",
              tool === "hand" || spacePressed
                ? "cursor-grab active:cursor-grabbing"
                : tool === "select"
                  ? "cursor-default"
                  : "cursor-crosshair",
            )}
            style={{
              backgroundImage:
                "radial-gradient(circle, color-mix(in oklab, var(--border) 85%, transparent) 1.25px, transparent 1.25px)",
              backgroundSize: `${24 * viewport.zoom}px ${24 * viewport.zoom}px`,
              backgroundPosition: `${viewport.x}px ${viewport.y}px`,
            }}
          >
            {/* Transformed World Container */}
            <div
              className="pointer-events-none absolute left-0 top-0 origin-top-left"
              style={{
                transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.zoom})`,
              }}
            >
              <ConnectorsLayer
                connectors={c.connectors}
                strokes={c.strokes}
                setSelectedNodeIds={c.setSelectedNodeIds}
                selectedConnectorId={c.selectedConnectorId}
                setSelectedConnectorId={c.setSelectedConnectorId}
                dragConnect={c.dragConnect}
                activeStroke={c.activeStroke}
                nodeById={c.nodeById}
              />
              <MarqueeOverlay c={c} />
              <NodesLayer c={c} />
            </div>
          </div>

          <PanelSlot id="right" c={c} />
          <PanelSlot id="bottomRight" c={c} />
        </div>

        {/* Schedule Handoff Dialog for linked Personal Notes on Canvas */}
        <ScheduleNoteHandoffDialog
          open={scheduleNote !== null}
          onOpenChange={(open) => {
            if (!open) setScheduleNote(null);
          }}
          companyId={selectedCompanyId}
          note={scheduleNote}
          agents={agents}
          projects={projects}
        />
      </div>
      </CanvasRefsContext.Provider>
    </CanvasRefContext.Provider>
  );
}
