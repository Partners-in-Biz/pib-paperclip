import { describe, expect, it } from "vitest";
import { PREVIEW_RENDER_URL } from "../src/service/preview-links.js";

// PAR-10040: the setup file keeps every test off the live preview render service (see tests/setup/no-live-render.ts).
describe("tests and the live preview render service", () => {
  it("a fetch to the render URL fails at once, as an unreachable service does", async () => {
    const started = Date.now();
    await expect(fetch(PREVIEW_RENDER_URL, { method: "POST", body: "{}" })).rejects.toThrow("fetch failed");
    await expect(fetch(new URL("/health", PREVIEW_RENDER_URL))).rejects.toThrow("fetch failed");
    expect(Date.now() - started).toBeLessThan(500);
  });
});
