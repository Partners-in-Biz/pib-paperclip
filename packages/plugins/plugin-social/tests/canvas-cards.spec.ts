import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { readFileSync } from "node:fs";

describe("canvas post card wiring", () => {
  it("declares the card-post slot with search and related", () => {
    const slot = manifest.ui?.slots?.find((s) => s.id === "card-post");
    expect(slot).toMatchObject({ type: "canvasNode", exportName: "SocialPostCard", entityCard: { kind: "card-post", search: true, related: true } });
  });

  it("registers the actions through registerCanvasCards with ctx.actions.register itself", () => {
    const worker = readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");
    expect(worker).toMatch(/registerCanvasCards\(\{ register: \(key, handler\) => ctx\.actions\.register\(key, handler\), kinds: \[createPostCardKind\(ctx\)\] \}\)/);
  });
});
