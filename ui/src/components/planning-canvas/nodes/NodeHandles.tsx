import { type CanvasNode } from "@paperclipai/shared";
import { useLatestCanvas } from "@/components/planning-canvas/nodes/canvas-context";
import { cn } from "@/lib/utils";

export function NodeHandles({
  node,
  isSelected,
  isEditing,
  showConnectHandles,
}: {
  node: CanvasNode;
  isSelected: boolean;
  isEditing: boolean;
  showConnectHandles: boolean;
}) {
  const latest = useLatestCanvas();
  const { setDragConnect, dragConnectRef, resizeDragRef } = latest.current;
  return (
    <>
      {showConnectHandles ? (
        <>
          {(
            [
              { side: "top", cls: "-top-3 left-1/2 -translate-x-1/2", sx: node.x + node.width / 2, sy: node.y },
              { side: "right", cls: "top-1/2 -right-3 -translate-y-1/2", sx: node.x + node.width, sy: node.y + node.height / 2 },
              { side: "bottom", cls: "-bottom-3 left-1/2 -translate-x-1/2", sx: node.x + node.width / 2, sy: node.y + node.height },
              { side: "left", cls: "top-1/2 -left-3 -translate-y-1/2", sx: node.x, sy: node.y + node.height / 2 },
            ] as const
          ).map((handle) => (
            <button
              key={handle.side}
              type="button"
              title="Drag to connect to another card (or drop on empty canvas to spawn a connected sticky)"
              aria-label={`Connect from ${handle.side}`}
              onMouseDown={(e) => {
                e.stopPropagation();
                const initial = {
                  fromNodeId: node.id,
                  startX: handle.sx,
                  startY: handle.sy,
                  currX: handle.sx,
                  currY: handle.sy,
                };
                dragConnectRef.current = initial;
                setDragConnect(initial);
              }}
              className={cn(
                "absolute z-30 size-3 rounded-full border-2 border-background bg-blue-500 shadow-xs transition-transform hover:scale-125",
                handle.cls,
              )}
            />
          ))}
        </>
      ) : null}
      {isSelected ? (
        <div
          onMouseDown={(e) => {
            e.stopPropagation();
            latest.current.opStore.checkpoint();
            resizeDragRef.current = {
              nodeId: node.id,
              startClientX: e.clientX,
              startClientY: e.clientY,
              origW: node.width,
              origH: node.height,
            };
          }}
          className="absolute -bottom-1.5 -right-1.5 size-3.5 cursor-nwse-resize rounded-sm border border-blue-500 bg-background shadow-xs"
        />
      ) : null}
    </>
  );
}
