import { useMemo } from "react";
import type { PlanningCanvasBlueprint } from "@paperclipai/shared";
import { CANVAS_COLOR_THEMES } from "@/lib/planning-canvas-helpers";
import { cn } from "@/lib/utils";

type Box = { key: string; kind: string; x: number; y: number; width: number; height: number; color: keyof typeof CANVAS_COLOR_THEMES; title: string };

/** Blueprint nodes with a position, in board units. Connectors are drawn from their two end keys. */
export function blueprintLayout(blueprint: PlanningCanvasBlueprint) {
  const boxes: Box[] = [];
  const links: Array<{ from: string; to: string }> = [];
  for (const item of blueprint.items) {
    if (item.itemType === "node") {
      boxes.push({
        key: item.key,
        kind: item.kind,
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
        color: (item.color ?? "yellow") as Box["color"],
        title: item.title ?? "",
      });
    } else if (item.itemType === "connector" && item.fromKey && item.toKey) {
      links.push({ from: item.fromKey, to: item.toKey });
    }
  }
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.width));
  const maxY = Math.max(...boxes.map((b) => b.y + b.height));
  return { boxes, links, minX, minY, width: maxX - minX, height: maxY - minY };
}

/** A to-scale map of a blueprint. Marked nodes (the ones that can become issues) carry a ring. */
export function BlueprintPreview({ blueprint, issueKeys, className }: { blueprint: PlanningCanvasBlueprint; issueKeys?: ReadonlySet<string>; className?: string }) {
  const layout = useMemo(() => blueprintLayout(blueprint), [blueprint]);
  const marked = issueKeys ?? new Set(blueprint.issueKeys);
  const pct = (value: number, total: number) => `${(value / total) * 100}%`;
  const byKey = new Map(layout.boxes.map((b) => [b.key, b]));
  return (
    <div
      role="img"
      aria-label={`Preview of the ${blueprint.title} blueprint`}
      className={cn("relative w-full overflow-hidden rounded-lg border border-border bg-muted/30", className)}
      style={{ aspectRatio: `${layout.width} / ${layout.height}` }}
    >
      {layout.boxes.map((box) => {
        const theme = CANVAS_COLOR_THEMES[box.color];
        const frame = box.kind === "frame";
        const shape = box.kind === "shape";
        return (
          <div
            key={box.key}
            title={box.title}
            className={cn(
              "absolute rounded-sm border",
              frame ? [theme.frameBg, theme.frameBorder] : shape ? [theme.shapeBg, theme.shapeBorder] : [theme.stickyBg, theme.stickyBorder],
              marked.has(box.key) && "ring-1 ring-ring",
            )}
            style={{
              left: pct(box.x - layout.minX, layout.width),
              top: pct(box.y - layout.minY, layout.height),
              width: pct(box.width, layout.width),
              height: pct(box.height, layout.height),
            }}
          />
        );
      })}
      <svg className="pointer-events-none absolute inset-0 size-full text-muted-foreground" viewBox={`0 0 ${layout.width} ${layout.height}`} preserveAspectRatio="none" aria-hidden>
        {layout.links.map(({ from, to }) => {
          const a = byKey.get(from);
          const b = byKey.get(to);
          if (!a || !b) return null;
          return (
            <line
              key={`${from}-${to}`}
              x1={a.x - layout.minX + a.width / 2}
              y1={a.y - layout.minY + a.height / 2}
              x2={b.x - layout.minX + b.width / 2}
              y2={b.y - layout.minY + b.height / 2}
              stroke="currentColor"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>
    </div>
  );
}
