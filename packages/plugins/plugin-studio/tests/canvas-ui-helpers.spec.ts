import { describe, expect, it } from "vitest";
import { CASCADE_STEP, cascadePosition, labelEdges, resultCards } from "../src/ui/board.js";
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

describe("resultCards (a finished generation becomes cards)", () => {
  const n = (id: string, type: string, x: number, y: number, data: Record<string, string> = {}) => ({ id, type, position: { x, y }, data }) as never;
  let k = 0;
  const mk = (p: string) => `${p}${++k}`;

  it("makes one connected output card per result, next to the source, and never on top of another card", () => {
    const nodes = [n("a", "image", 0, 0), n("blocker", "output", 380, 0)];
    const out = resultCards(nodes, [], "a", ["x1", "x2"], 10, mk);
    expect(out.fills).toEqual([]);
    expect(out.created.map((c) => [c.type, c.data, c.position])).toEqual([
      ["output", { assetId: "x1", generated: "1" }, { x: 380, y: 280 }],
      ["output", { assetId: "x2", generated: "1" }, { x: 380, y: 560 }],
    ]);
    expect(out.edges.map((e) => [e.source, e.target])).toEqual(out.created.map((c) => ["a", c.id]));
  });

  it("fills a wired output card first and only makes cards for the rest; earlier made cards are kept", () => {
    const nodes = [n("a", "image", 0, 0), n("o", "output", 300, 0), n("old", "output", 300, 280, { assetId: "prev", generated: "1" })];
    const edges = [{ source: "a", target: "o" }, { source: "a", target: "old" }];
    const out = resultCards(nodes, edges, "a", ["x1", "x2"], 10, mk);
    expect(out.fills).toEqual([{ id: "o", assetId: "x1" }]);
    expect(out.created).toHaveLength(1);
    expect(out.created[0].data.assetId).toBe("x2");
    expect(resultCards(nodes, edges, "a", ["x1"], 10, mk).created).toEqual([]);
  });

  it("respects the board limit and ignores duplicates and missing cards", () => {
    const nodes = [n("a", "video", 0, 0)];
    expect(resultCards(nodes, [], "a", ["x", "x", "y"], 1, mk).created).toHaveLength(1);
    expect(resultCards(nodes, [], "a", ["x"], 0, mk).created).toEqual([]);
    expect(resultCards(nodes, [], "gone", ["x"], 5, mk).created).toEqual([]);
  });

  it("labels edges into output cards 'generated output' on screen only", () => {
    const nodes = [n("a", "image", 0, 0), n("o", "output", 1, 1), n("v", "video", 2, 2)];
    const edges = [{ id: "e1", source: "a", target: "o" }, { id: "e2", source: "a", target: "v" }];
    expect(labelEdges(nodes, edges).map((e) => e.label)).toEqual(["generated output", undefined]);
  });
});
