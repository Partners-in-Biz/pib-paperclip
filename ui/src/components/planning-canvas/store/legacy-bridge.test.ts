import { describe, expect, it } from "vitest";
import { PLANNING_CANVAS_NODE_KINDS } from "@paperclipai/shared";
import { nodeRenderer, NODE_RENDERERS } from "../nodes/node-renderers";
import { elementToItem, itemToElement } from "./legacy-bridge";

const fields = { kind: "hologram", x: 0, y: 0, width: 200, height: 100, zIndex: 1, color: "slate", title: "", content: "" };

describe("elementToItem for an unknown kind", () => {
  it("sends geometry only, never colour or content", () => {
    const element = { id: "u1", kind: "hologram", x: 5, y: 6, width: 210, height: 110, zIndex: 2, color: "red", title: "t", content: "c" };
    const item = elementToItem("node", element as never, { itemType: "node", fields } as never);
    expect(item.fields).toMatchObject({ kind: "hologram", x: 5, y: 6, width: 210, height: 110, zIndex: 2, color: "slate", title: "" });
  });

  it("still sends colour for a known typed kind", () => {
    const prev = { itemType: "node", fields: { ...fields, kind: "table" } } as never;
    const element = { id: "t1", kind: "note", x: 0, y: 0, width: 200, height: 100, zIndex: 1, color: "red", title: "", content: "" };
    expect(elementToItem("node", element as never, prev).fields).toMatchObject({ kind: "table", color: "red" });
  });
});

describe("weblink rollback (PAR-14389 D1a)", () => {
  const weblink = {
    itemType: "node",
    fields: { ...fields, kind: "weblink", title: "w1", data: { url: "https://youtu.be/dQw4w9WgXcQ" } },
  } as never;

  it("with weblink removed from the kinds list, a stored web link draws as the placeholder card and moves by geometry only", () => {
    const mutable = PLANNING_CANVAS_NODE_KINDS as unknown as string[];
    const index = mutable.indexOf("weblink");
    mutable.splice(index, 1);
    try {
      const element = itemToElement("w1", weblink, new Map()) as { kind: string; title: string };
      expect(element).toMatchObject({ id: "w1", kind: "weblink", title: "weblink", content: "" });
      expect(Object.values(NODE_RENDERERS)).not.toContain(nodeRenderer(element.kind));
      const moved = elementToItem("node", { ...element, x: 40, y: 50, color: "red", title: "x" } as never, weblink);
      expect(moved.fields).toMatchObject({ kind: "weblink", x: 40, y: 50, color: "slate", title: "w1", data: { url: "https://youtu.be/dQw4w9WgXcQ" } });
    } finally {
      mutable.splice(index, 0, "weblink");
    }
  });
});
