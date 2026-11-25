// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NODE_RENDERERS, nodeRenderer } from "./node-renderers";

describe("nodeRenderer", () => {
  it("returns the registered renderer for a known kind", () => {
    expect(nodeRenderer("sticky")).toBe(NODE_RENDERERS.sticky);
  });
  it("falls back to one placeholder card for unknown kinds, including prototype names", () => {
    const unknown = nodeRenderer("hologram");
    expect(Object.values(NODE_RENDERERS)).not.toContain(unknown);
    expect(nodeRenderer("constructor")).toBe(unknown);
  });
});
