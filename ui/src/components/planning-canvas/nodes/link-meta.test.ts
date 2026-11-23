import { describe, expect, it } from "vitest";
import type { StoreItem } from "@/components/planning-canvas/store/canvas-op-store";
import { linkedEntityIds, linkMetaOf, patchLinkMeta } from "./link-meta";

const node = (fields: Record<string, unknown>): StoreItem => ({ itemType: "node", fields: { kind: "sticky", ...fields } });

describe("linkMetaOf", () => {
  it("reads ref and links of a linked-entity node", () => {
    expect(linkMetaOf(node({ kind: "issue", ref: { id: "i1" }, links: [{ type: "issue", issueId: "i2" }] }))).toEqual({
      refKind: "issue",
      refId: "i1",
      links: ["i2"],
    });
  });

  it("is null for a plain node and for non-nodes", () => {
    expect(linkMetaOf(node({}))).toBeNull();
    expect(linkMetaOf({ itemType: "stroke", fields: {} })).toBeNull();
    expect(linkMetaOf(undefined)).toBeNull();
  });

  it("keeps every link of a handed-off node", () => {
    const meta = linkMetaOf(node({ links: [{ type: "issue", issueId: "a" }, { type: "issue", issueId: "b" }] }));
    expect(meta).toEqual({ refKind: null, refId: null, links: ["a", "b"] });
  });
});

describe("patchLinkMeta", () => {
  it("keeps identity when nothing changed and drops removed nodes", () => {
    const items = new Map<string, StoreItem>([["n1", node({ kind: "agent", ref: { id: "a1" } })]]);
    const first = patchLinkMeta(new Map(), ["n1"], (k) => items.get(k));
    expect(patchLinkMeta(first, ["n1"], (k) => items.get(k))).toBe(first);
    items.delete("n1");
    expect(patchLinkMeta(first, ["n1"], (k) => items.get(k)).has("n1")).toBe(false);
  });

  it("lists distinct entity ids sorted", () => {
    const meta = new Map([
      ["a", { refKind: "issue" as const, refId: "z", links: ["m"] }],
      ["b", { refKind: null, refId: null, links: ["m", "c"] }],
    ]);
    expect(linkedEntityIds(meta)).toEqual(["c", "m", "z"]);
  });
});
