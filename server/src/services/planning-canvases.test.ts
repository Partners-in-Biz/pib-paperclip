import { describe, expect, it } from "vitest";
import {
  createPlanningCanvasSchema,
  updatePlanningCanvasSchema,
} from "@paperclipai/shared";

describe("planning canvas schemas", () => {
  it("validates board creation with nodes, connectors, and strokes", () => {
    const parsed = createPlanningCanvasSchema.parse({
      title: "  Q4 Strategy Board  ",
      data: {
        nodes: [
          {
            id: "sticky_1",
            kind: "sticky",
            x: 100,
            y: 120,
            width: 240,
            height: 150,
            zIndex: 2,
            color: "yellow",
            title: "Launch campaign",
            content: "Coordinate SEO + Social",
          },
        ],
        connectors: [
          {
            id: "conn_1",
            fromNodeId: "sticky_1",
            toNodeId: "sticky_2",
            label: "feeds",
            color: "blue",
          },
        ],
        strokes: [
          {
            id: "stroke_1",
            points: [
              { x: 10, y: 20 },
              { x: 30, y: 40 },
            ],
            color: "rose",
            width: 4,
            highlighter: false,
          },
        ],
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    });

    expect(parsed.title).toBe("Q4 Strategy Board");
    expect(parsed.data?.nodes).toHaveLength(1);
    expect(parsed.data?.connectors).toHaveLength(1);
    expect(parsed.data?.strokes).toHaveLength(1);
  });

  it("allows partial board updates", () => {
    const patch = updatePlanningCanvasSchema.parse({ title: "Renamed Board" });
    expect(patch).toEqual({ title: "Renamed Board" });
  });
});
