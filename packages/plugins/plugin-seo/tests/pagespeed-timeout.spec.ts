import { afterEach, describe, expect, it, vi } from "vitest";
import { RUN_PAGESPEED_PSI_TIMEOUT_MS, RUN_PAGESPEED_TOOL_TIMEOUT_MS, runPagespeed } from "../src/integrations/pagespeed.js";
import { SEO_TOOLS } from "../src/tools.js";

// PAR-9039: Lighthouse on a heavy page takes over 26 s, and the gateway gave plugin tools 10 s
// unless the caller sent timeoutMs. run-pagespeed now declares its own budget.
describe("run-pagespeed timeout budget", () => {
  afterEach(() => vi.useRealTimers());

  it("declares a 60 s tool timeout (the gateway maximum), above the PSI budget", () => {
    const tool = SEO_TOOLS.find((t) => t.name === "run-pagespeed");
    expect(tool?.timeoutMs).toBe(60_000);
    expect(RUN_PAGESPEED_TOOL_TIMEOUT_MS).toBe(60_000);
    expect(RUN_PAGESPEED_PSI_TIMEOUT_MS).toBeGreaterThanOrEqual(45_000);
    expect(RUN_PAGESPEED_PSI_TIMEOUT_MS).toBeLessThan(RUN_PAGESPEED_TOOL_TIMEOUT_MS);
  });

  it("lets a 40 s Lighthouse run finish with the run-pagespeed budget", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      setTimeout(() => resolve(new Response(JSON.stringify({ lighthouseResult: { categories: { performance: { score: 0.9 } }, audits: {} } }), { status: 200 })), 40_000);
    }));
    const run = runPagespeed(fetchImpl as never, { url: "https://lumenspeeds.com/science", timeoutMs: RUN_PAGESPEED_PSI_TIMEOUT_MS });
    await vi.advanceTimersByTimeAsync(40_000);
    await expect(run).resolves.toMatchObject({ url: "https://lumenspeeds.com/science" });
  });

  it("still aborts once the budget runs out", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const run = runPagespeed(fetchImpl as never, { url: "https://lumenspeeds.com/blog", timeoutMs: RUN_PAGESPEED_PSI_TIMEOUT_MS });
    const settled = expect(run).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(RUN_PAGESPEED_PSI_TIMEOUT_MS + 1);
    await settled;
  });
});
