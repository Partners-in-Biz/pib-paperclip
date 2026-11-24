import { describe, expect, it } from "vitest";
import { elementToItem } from "./legacy-bridge";

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
