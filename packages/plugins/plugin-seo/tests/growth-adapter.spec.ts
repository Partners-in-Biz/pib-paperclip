import { describe, expect, it, vi } from "vitest";
import { createSeoAdapter } from "../src/growth/adapter.js";

describe("SEO channel adapter", () => {
  it("sets constant properties", () => {
    const adapter = createSeoAdapter({ fetchRows: vi.fn().mockResolvedValue(new Map()) });
    expect(adapter.channel).toBe("seo");
    expect(adapter.windowDays).toBe(14);
    expect(adapter.minPerArm).toBe(20);
    expect(adapter.defaultMetric).toBe("clicks");
  });

  it("aggregates duplicate page rows via fetchRows", async () => {
    const fetchRowsMock = vi.fn().mockResolvedValue(
      new Map([
        ["https://example.com/page1", { clicks: 10, impressions: 100 }],
        ["https://example.com/page2", { clicks: 5, impressions: 50 }],
      ]),
    );

    const adapter = createSeoAdapter({ fetchRows: fetchRowsMock });
    const metrics = await adapter.source.fetchMetrics({
      scopeKey: "client:company:test-ref",
      sinceIso: "2026-10-21T00:00:00Z",
      untilIso: "2026-11-04T00:00:00Z",
    });

    expect(fetchRowsMock).toHaveBeenCalledWith("client:company:test-ref", "2026-10-21", "2026-11-04");
    expect(metrics).toHaveLength(2);
    expect(metrics[0]).toMatchObject({
      destinationId: "https://example.com/page1",
      subjectId: "https://example.com/page1",
      accountId: "client:company:test-ref",
      platform: "gsc",
      clicks: 10,
      impressions: 100,
    });
  });

  it("maintains scope isolation: different scopes return different pages", async () => {
    const fetchRowsMock = vi.fn();
    fetchRowsMock.mockImplementation((scopeKey) => {
      if (scopeKey === "scope-a") {
        return Promise.resolve(new Map([["https://example.com/a", { clicks: 10, impressions: 100 }]]));
      }
      if (scopeKey === "scope-b") {
        return Promise.resolve(new Map([["https://example.com/b", { clicks: 5, impressions: 50 }]]));
      }
      return Promise.resolve(new Map());
    });

    const adapter = createSeoAdapter({ fetchRows: fetchRowsMock });

    // Fetch for scope-a
    const metricsA = await adapter.source.fetchMetrics({
      scopeKey: "scope-a",
      sinceIso: "2026-10-21T00:00:00Z",
      untilIso: "2026-11-04T00:00:00Z",
    });

    // Fetch for scope-b
    const metricsB = await adapter.source.fetchMetrics({
      scopeKey: "scope-b",
      sinceIso: "2026-10-21T00:00:00Z",
      untilIso: "2026-11-04T00:00:00Z",
    });

    // Verify scope isolation: different scopes return different pages
    expect(metricsA).toHaveLength(1);
    expect(metricsA[0].accountId).toBe("scope-a");
    expect(metricsA[0].destinationId).toBe("https://example.com/a");

    expect(metricsB).toHaveLength(1);
    expect(metricsB[0].accountId).toBe("scope-b");
    expect(metricsB[0].destinationId).toBe("https://example.com/b");

    // Verify the fetchRows dependency was called with the correct scopeKey
    expect(fetchRowsMock).toHaveBeenCalledWith("scope-a", "2026-10-21", "2026-11-04");
    expect(fetchRowsMock).toHaveBeenCalledWith("scope-b", "2026-10-21", "2026-11-04");
  });

  it("propagates fetchRows errors", async () => {
    const fetchRowsMock = vi.fn().mockRejectedValue(new Error("Network error"));
    const adapter = createSeoAdapter({ fetchRows: fetchRowsMock });

    await expect(
      adapter.source.fetchMetrics({
        scopeKey: "client:company:test-ref",
        sinceIso: "2026-10-21T00:00:00Z",
        untilIso: "2026-11-04T00:00:00Z",
      }),
    ).rejects.toThrow("Network error");
  });

  it("hypothesisCandidates returns non-empty list", () => {
    const adapter = createSeoAdapter({ fetchRows: vi.fn().mockResolvedValue(new Map()) });
    const candidates = adapter.hypothesisCandidates({} as any);

    expect(candidates).toBeDefined();
    expect(Array.isArray(candidates)).toBe(true);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates).toContain("stuck_page:internal-links");
    expect(candidates).toContain("lost_keyword:rebuild");
  });
});
