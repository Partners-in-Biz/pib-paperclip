import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { readFileSync } from "node:fs";

describe("canvas post card wiring", () => {
  it("declares the card-post slot with search and related", () => {
    const slot = manifest.ui?.slots?.find((s) => s.id === "card-post");
    expect(slot).toMatchObject({ type: "canvasNode", exportName: "SocialPostCard", entityCard: { kind: "card-post", search: true, related: true } });
  });

  it("registers the actions through registerCanvasCards through the access guard's action", () => {
    const worker = readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");
    expect(worker).toMatch(/registerCanvasCards\(\{ register: g\.action, kinds: \[createPostCardKind\(ctx\)\] \}\)/);
  });
});
