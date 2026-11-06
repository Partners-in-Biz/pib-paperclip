import { describe, expect, it } from "vitest";
import { CASCADE_STEP, cascadePosition } from "../src/ui/board.js";
import { clientsWithAssets, type ClientSummary } from "../src/ui/clients.js";

const at = (x: number, y: number) => ({ position: { x, y } });

describe("cascadePosition (new card placement)", () => {
  it("uses the start spot on an empty board, rounded", () => {
    expect(cascadePosition([], { x: 10.4, y: 19.6 })).toEqual({ x: 10, y: 20 });
  });

  it("steps down-right past every card already at the spot, so cards never stack exactly", () => {
    const start = { x: 100, y: 100 };
    const nodes: Array<{ position: { x: number; y: number } }> = [];
    for (let i = 0; i < 8; i++) {
      const p = cascadePosition(nodes, start);
      expect(p).toEqual({ x: 100 + i * CASCADE_STEP, y: 100 + i * CASCADE_STEP });
      for (const n of nodes) expect(n.position).not.toEqual(p);
      nodes.push({ position: p });
    }
  });

  it("treats a card a few pixels off as taken, and a far card as free", () => {
    expect(cascadePosition([at(103, 98)], { x: 100, y: 100 })).toEqual({ x: 124, y: 124 });
    expect(cascadePosition([at(400, 400)], { x: 100, y: 100 })).toEqual({ x: 100, y: 100 });
  });

  it("stops after at most one step per card", () => {
    const nodes = Array.from({ length: 3 }, (_, i) => at(i * CASCADE_STEP, i * CASCADE_STEP));
    expect(cascadePosition(nodes, { x: 0, y: 0 })).toEqual({ x: 3 * CASCADE_STEP, y: 3 * CASCADE_STEP });
  });
});

describe("clientsWithAssets (Studio library client cards)", () => {
  const client = (scopeKey: string, draft: number, approved: number, rejected: number): ClientSummary => ({
    scopeKey,
    name: scopeKey,
    counts: { draft, approved, rejected },
    used: 0,
    monthlyCap: null,
    capSource: "none",
    recentApproved: [],
  });

  it("keeps only clients with at least one asset, in order", () => {
    const list = [client("crm:a", 0, 0, 0), client("crm:b", 1, 0, 0), client("crm:c", 0, 0, 2), client("crm:d", 0, 3, 0), client("crm:e", 0, 0, 0)];
    expect(clientsWithAssets(list).map((c) => c.scopeKey)).toEqual(["crm:b", "crm:c", "crm:d"]);
  });

  it("returns nothing when no client has assets", () => {
    expect(clientsWithAssets([client("crm:a", 0, 0, 0)])).toEqual([]);
    expect(clientsWithAssets([])).toEqual([]);
  });
});
