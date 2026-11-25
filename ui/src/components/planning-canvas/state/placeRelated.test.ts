// @vitest-environment node
import { describe, expect, it } from "vitest";
import { placeRelated, type PlaceRelatedNode, type RelatedRecord } from "@/components/planning-canvas/state/placeRelated";

const source: PlaceRelatedNode = { key: "src", kind: "embed", x: 100, y: 100, width: 280, height: 160, data: { plugin: "crm", type: "company", assetId: "c1", props: {} } };
const inv = (id: string): RelatedRecord => ({ relation: "invoice", plugin: "billing", type: "invoice", assetId: id });
const counter = () => { let i = 0; return () => `k${++i}`; };
const rect = (n: { x: number; y: number; width: number; height: number }) => n;
const overlap = (a: ReturnType<typeof rect>, b: ReturnType<typeof rect>) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe("placeRelated", () => {
  it("adds embed nodes with plugin, type, assetId and empty props, plus one labelled connector each", () => {
    const r = placeRelated({ source, nodes: [source], records: [inv("i1"), inv("i2")], newKey: counter() });
    const nodes = r.items.filter((i) => i.itemType === "node");
    const conns = r.items.filter((i) => i.itemType === "connector");
    expect(nodes).toHaveLength(2);
    expect(conns).toHaveLength(2);
    expect((nodes[0] as { data: unknown }).data).toEqual({ plugin: "billing", type: "invoice", assetId: "i1", props: {} });
    expect(conns[0]).toMatchObject({ fromKey: "src", toKey: "k1", label: "invoice" });
  });

  it("adds a ref card for a core entity", () => {
    const r = placeRelated({ source, nodes: [source], records: [{ relation: "subtask", refKind: "issue", refId: "iss1" }], newKey: counter() });
    expect(r.items[0]).toMatchObject({ itemType: "node", kind: "issue", ref: { id: "iss1" } });
  });

  it("connects a record already on the board instead of adding it again", () => {
    const existing: PlaceRelatedNode = { key: "e1", kind: "embed", x: 900, y: 0, width: 280, height: 160, data: { plugin: "billing", type: "invoice", assetId: "i1", props: {} } };
    const r = placeRelated({ source, nodes: [source, existing], records: [inv("i1")], newKey: counter() });
    expect(r.addedNodes).toBe(0);
    expect(r.connectedExisting).toBe(1);
    expect(r.items).toEqual([expect.objectContaining({ itemType: "connector", fromKey: "src", toKey: "e1", label: "invoice" })]);
  });

  it("does not join a pair twice, and ignores a record ticked twice", () => {
    const existing: PlaceRelatedNode = { key: "e1", kind: "issue", x: 900, y: 0, width: 230, height: 150, ref: { id: "iss1" } };
    const rec: RelatedRecord = { relation: "subtask", refKind: "issue", refId: "iss1" };
    const r = placeRelated({ source, nodes: [source, existing], connectors: [{ fromKey: "e1", toKey: "src" }], records: [rec, rec], newKey: counter() });
    expect(r.items).toEqual([]);
    expect(r.alreadyConnected).toBe(1);
  });

  it("adds at most 50 and reports the rest", () => {
    const records = Array.from({ length: 53 }, (_, i) => inv(`i${i}`));
    const r = placeRelated({ source, nodes: [source], records, newKey: counter() });
    expect(r.addedNodes).toBe(50);
    expect(r.skipped).toEqual(records.slice(50));
  });

  it("puts the column beside the source without overlapping the source or nodes in the way", () => {
    const blockers: PlaceRelatedNode[] = [
      { key: "b1", kind: "sticky", x: 420, y: 90, width: 230, height: 150 },
      { key: "b2", kind: "sticky", x: 430, y: 400, width: 230, height: 150 },
    ];
    const nodes = [source, ...blockers];
    const r = placeRelated({ source, nodes, records: Array.from({ length: 6 }, (_, i) => inv(`i${i}`)), newKey: counter() });
    const added = r.items.filter((i) => i.itemType === "node") as unknown as Array<ReturnType<typeof rect>>;
    expect(added.every((a) => a.x >= source.x + source.width)).toBe(true);
    for (const a of added) for (const n of nodes) expect(overlap(a, n)).toBe(false);
    for (let i = 0; i < added.length; i += 1) for (let j = i + 1; j < added.length; j += 1) expect(overlap(added[i], added[j])).toBe(false);
  });

  it("clips a label to 120 characters", () => {
    const r = placeRelated({ source, nodes: [source], records: [{ ...inv("i1"), relation: "x".repeat(300) }], newKey: counter() });
    expect((r.items.find((i) => i.itemType === "connector") as { label: string }).label).toHaveLength(120);
  });

  it("counts only new nodes against the cap: 50 existing plus 5 new adds 5, skips 0", () => {
    const existing: PlaceRelatedNode[] = Array.from({ length: 50 }, (_, i) => ({ key: `e${i}`, kind: "embed", x: 2000, y: i * 200, width: 280, height: 160, data: { plugin: "billing", type: "invoice", assetId: `old${i}`, props: {} } }));
    const records = [...existing.map((_, i) => inv(`old${i}`)), ...Array.from({ length: 5 }, (_, i) => inv(`new${i}`))];
    const r = placeRelated({ source, nodes: [source, ...existing], records, newKey: counter() });
    expect(r.addedNodes).toBe(5);
    expect(r.connectedExisting).toBe(50);
    expect(r.skipped).toEqual([]);
  });
});
