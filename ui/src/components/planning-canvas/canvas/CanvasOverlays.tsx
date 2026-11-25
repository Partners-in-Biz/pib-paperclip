import { memo } from "react";
import { type CanvasController } from "@/components/planning-canvas/state/useCanvasController";
import { CANVAS_COLOR_THEMES, computeConnectorPath, strokePointsToSvgPath } from "@/lib/planning-canvas-helpers";

type ConnectorsLayerProps = Pick<
  CanvasController,
  | "connectors"
  | "strokes"
  | "setSelectedNodeIds"
  | "selectedConnectorId"
  | "setSelectedConnectorId"
  | "dragConnect"
  | "activeStroke"
  | "nodeById"
>;

/** Memoized: a pan or zoom changes none of these, so the connector paths are not recomputed. */
export const ConnectorsLayer = memo(function ConnectorsLayer({
  connectors,
  strokes,
  setSelectedNodeIds,
  selectedConnectorId,
  setSelectedConnectorId,
  dragConnect,
  activeStroke,
  nodeById,
}: ConnectorsLayerProps) {
  return (
    <svg
      className="pointer-events-none absolute left-0 top-0 overflow-visible"
      width={1}
      height={1}
    >
      <defs>
        <marker
          id="canvas-arrowhead"
          markerWidth="10"
          markerHeight="7"
          refX="9"
          refY="3.5"
          orient="auto"
        >
          <polygon points="0 0, 10 3.5, 0 7" fill="currentColor" />
        </marker>
      </defs>
      {connectors.map((conn) => {
        const from = nodeById.get(conn.fromNodeId);
        const to = nodeById.get(conn.toNodeId);
        if (!from || !to) return null;
        const geom = computeConnectorPath(from, to);
        const isSelected = selectedConnectorId === conn.id;
        const stroke = CANVAS_COLOR_THEMES[conn.color ?? "slate"].strokeHex;
        return (
          <g
            key={conn.id}
            className="pointer-events-auto cursor-pointer"
            style={{ color: isSelected ? "#3b82f6" : stroke }}
            onClick={(e) => {
              e.stopPropagation();
              setSelectedConnectorId(conn.id);
              setSelectedNodeIds([]);
            }}
          >
            <path d={geom.path} fill="none" stroke="transparent" strokeWidth={14} />
            <path
              d={geom.path}
              fill="none"
              stroke="currentColor"
              strokeWidth={isSelected ? 3 : 2}
              strokeDasharray={conn.dashed ? "6 4" : undefined}
              markerEnd="url(#canvas-arrowhead)"
            />
            {conn.label ? (
              <g transform={`translate(${geom.midX}, ${geom.midY})`}>
                <rect
                  x={-Math.max(24, conn.label.length * 3.8 + 8)}
                  y={-11}
                  width={Math.max(48, conn.label.length * 7.6 + 16)}
                  height={22}
                  rx={6}
                  className="fill-background stroke-border"
                  strokeWidth={1}
                />
                <text
                  textAnchor="middle"
                  dominantBaseline="central"
                  className="fill-foreground text-[11px] font-medium"
                >
                  {conn.label}
                </text>
              </g>
            ) : null}
          </g>
        );
      })}

      {/* Freehand Pen & Highlighter Strokes */}
      {[...strokes, ...(activeStroke ? [activeStroke] : [])].map((stroke) => (
        <path
          key={stroke.id}
          d={strokePointsToSvgPath(stroke.points)}
          fill="none"
          stroke={CANVAS_COLOR_THEMES[stroke.color]?.strokeHex ?? "#3b82f6"}
          strokeWidth={stroke.width}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeOpacity={stroke.highlighter ? 0.35 : 0.9}
        />
      ))}

      {/* Live rubber-band arrow when dragging from a Miro blue handle */}
      {dragConnect ? (
        <line
          x1={dragConnect.startX}
          y1={dragConnect.startY}
          x2={dragConnect.currX}
          y2={dragConnect.currY}
          stroke="#3b82f6"
          strokeWidth={2.5}
          strokeDasharray="6 4"
          markerEnd="url(#canvas-arrowhead)"
          style={{ color: "#3b82f6" }}
        />
      ) : null}
    </svg>
  );
});

export function MarqueeOverlay({ c }: { c: CanvasController }) {
  const {
    marqueeRect,
  } = c;
  return (
    marqueeRect && (marqueeRect.width > 4 || marqueeRect.height > 4) ? (
      <div
        style={{
          left: marqueeRect.x,
          top: marqueeRect.y,
          width: marqueeRect.width,
          height: marqueeRect.height,
          zIndex: 9999,
        }}
        className="pointer-events-none absolute rounded border border-blue-500 bg-blue-500/12"
      />
    ) : null
  );
}
