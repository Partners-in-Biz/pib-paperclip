import { describe, expect, it, vi } from "vitest";
import { BING_VERIFY_SITE_CALL_TIMEOUT_MS, BING_VERIFY_SITE_TOOL_TIMEOUT_MS, bingVerifySite } from "../src/integrations/bing.js";
import { SEO_TOOLS } from "../src/tools.js";

// PAR-9853: bing-verify-site timed out at the 10 s default plugin tool budget.
describe("bing-verify-site timeout budget", () => {
  it("declares a 60 s tool timeout above the VerifySite call budget", () => {
    expect(SEO_TOOLS.find((t) => t.name === "bing-verify-site")?.timeoutMs).toBe(60_000);
    expect(BING_VERIFY_SITE_CALL_TIMEOUT_MS).toBeGreaterThan(20_000);
    expect(BING_VERIFY_SITE_CALL_TIMEOUT_MS).toBeLessThan(BING_VERIFY_SITE_TOOL_TIMEOUT_MS);
  });

  it("waits through a 30 s VerifySite instead of aborting at 20 s", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(() => new Promise((resolve) => setTimeout(() => resolve({ ok: true, status: 200, text: async () => JSON.stringify({ d: true }) }), 30_000)));
      const run = bingVerifySite(fetchImpl as never, "k", "https://example.com/");
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(run).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
