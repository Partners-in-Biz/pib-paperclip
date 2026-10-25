import type { PluginContext } from "@paperclipai/plugin-sdk";
import { describe, expect, it } from "vitest";
import { adsAdapter, ADS_CHANNEL, judgeAdsExperiment, MAX_ROWS, measureAdsExperiment, readAdDaily, summariseAds, WINDOW_DAYS, MIN_IMPRESSIONS_PER_ARM, MIN_CONVERSIONS_PER_ARM } from "../src/growth-adapter.js";
import type { AdDailyRow } from "../src/variants.js";

const TODAY = "2026-10-21";
const daysAgo = (d: number): string => new Date(new Date(TODAY).getTime() - d * 86_400_000).toISOString().slice(0, 10);
const row = (adId: string, day = TODAY, spend = 100, impr = 1000, conv = 10, clicks = 0, freq = 0, account = "acc1", campaign = "camp1"): AdDailyRow =>
  ({ account_id: account, campaign_external_id: campaign, ad_external_id: adId, day, spend_minor: spend, impressions: impr, clicks, conversions: conv, frequency: freq });

// Fake ctx builder: stores rows keyed by company, filters by query params
const fakeCtx = (companiesMap: Map<string, AdDailyRow[]>) => {
  const captured: Array<{ sql: string; params: unknown[] }> = [];
  const ctx = {
    db: {
      namespace: "plugin_test",
      async query(sql: string, params: unknown[]) {
        captured.push({ sql, params });
        if (!sql.includes("ad_daily")) return [];
        const [companyId, accountId, campaignId, sinceDay] = params;
        const rows = companiesMap.get(String(companyId)) || [];
        return rows.filter((r) => r.account_id === accountId && r.campaign_external_id === campaignId && r.day >= String(sinceDay).slice(0, 10))
          .map((r) => ({ account_id: r.account_id, campaign_external_id: r.campaign_external_id, ad_external_id: r.ad_external_id, day: r.day, spend_minor: r.spend_minor, impressions: r.impressions, clicks: r.clicks, conversions: r.conversions, frequency: r.frequency }));
      },
    },
  } as unknown as PluginContext;
  return { ctx, captured };
};

describe("ads growth adapter", () => {
  it("defaults match DEFAULT_VARIANT_CONFIG", () => {
    expect(adsAdapter.channel).toBe(ADS_CHANNEL);
    expect([MIN_IMPRESSIONS_PER_ARM, MIN_CONVERSIONS_PER_ARM, WINDOW_DAYS]).toEqual([1000, 10, 14]);
  });

  it("qualifies ads at the boundary", () => {
    expect(summariseAds([row("a1", TODAY, 99900, 999, 10)], { today: TODAY }).ads[0]?.qualified).toBe(false);
    expect(summariseAds([row("a2", TODAY, 100000, 1000, 9)], { today: TODAY }).ads[0]?.qualified).toBe(false);
    expect(summariseAds([row("a3", TODAY, 100000, 1000, 10)], { today: TODAY }).ads[0]?.qualified).toBe(true);
  });

  it("excludes rows older than 14 days and computes CPA/cpaIndex", () => {
    const rows = [row("a1", daysAgo(15), 1000, 1000, 10), row("a1", TODAY, 1000, 1000, 10)];
    const r = summariseAds(rows, { today: TODAY });
    expect(r.ads[0]?.impressions).toBe(1000);
    expect(r.medianCpaMinor).toBe(100);
    expect(r.ads[0]?.cpaIndex).toBeCloseTo(1);
  });

  it("zero-conversion ad has cpaMinor null and unqualified", () => {
    const r = summariseAds([row("a1", TODAY, 100, 1000, 0)], { today: TODAY });
    expect(r.ads[0]?.cpaMinor).toBeNull();
    expect(r.ads[0]?.qualified).toBe(false);
  });

  it("marks exactly one campaignWinner with lowest CPA", () => {
    const rows = [row("a1", TODAY, 100, 1000, 10), row("a2", TODAY, 150, 1000, 10)];
    const winners = summariseAds(rows, { today: TODAY }).ads.filter((a) => a.campaignWinner);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.adId).toBe("a1");
  });

  it("verdict inconclusive when control unqualified", () => {
    const r = judgeAdsExperiment([row("a1", TODAY, 100, 999, 10)], { control: ["a1"], variant: ["a2"] }, { today: TODAY });
    expect(r.verdict).toBe("inconclusive");
    expect(r.reason).toContain("1000");
  });

  it("two-scope isolation: A and B same ad_ids/account/campaign but different spend; readAdDaily filters by company; different CPAs result", async () => {
    const coMap = new Map<string, AdDailyRow[]>([
      ["coA", [row("c1", TODAY, 1000, 1000, 10), row("v1", TODAY, 500, 1000, 10), row("neutral", TODAY, 1500, 1000, 10)]],
      ["coB", [row("c1", TODAY, 10000, 1000, 10), row("v1", TODAY, 5000, 1000, 10), row("neutral", TODAY, 15000, 1000, 10)]],
    ]);
    const { ctx, captured } = fakeCtx(coMap);

    const rowsA = await readAdDaily(ctx, "coA", "acc1", "camp1", TODAY);
    expect(rowsA).toHaveLength(3);
    const rA = await measureAdsExperiment(ctx, "coA", "acc1", "camp1", { control: ["c1"], variant: ["v1"] }, { today: TODAY });
    expect(rA.verdict).toBe("win");
    expect(rA.campaignMedianCpaMinor).toBe(100); // CPA of v1=50, c1=100, neutral=150; median 100

    const rB = await measureAdsExperiment(ctx, "coB", "acc1", "camp1", { control: ["c1"], variant: ["v1"] }, { today: TODAY });
    expect(rB.campaignMedianCpaMinor).toBe(1000); // 10x larger due to 10x larger spend

    const rC = await measureAdsExperiment(ctx, "coC", "acc1", "camp1", { control: ["c1"], variant: ["v1"] }, { today: TODAY });
    expect(rC.verdict).toBe("inconclusive");

    for (const cap of captured) {
      if (cap.sql.includes("ad_daily")) {
        expect(cap.sql).toContain("company_id = $1");
        expect(cap.sql).not.toMatch(/insert|update|delete/i);
      }
    }
  });

  it("truncated: exactly MAX_ROWS rows -> truncated true; fewer rows -> false", async () => {
    // Simulate MAX_ROWS detection with realistic data: ~20 ads, 14 days
    const mockCtxFull = {
      db: {
        namespace: "plugin_test",
        async query(sql: string, params: unknown[]) {
          if (!sql.includes("ad_daily")) return [];
          // Return exactly MAX_ROWS rows cycling through ~20 ad ids and 14 days
          return Array.from({ length: MAX_ROWS }, (_, i) => ({
            account_id: "acc1",
            campaign_external_id: "camp1",
            ad_external_id: `a${i % 20}`,
            day: daysAgo(i % 14),
            spend_minor: 100,
            impressions: 1000,
            clicks: 0,
            conversions: 10,
            frequency: 0,
          }));
        },
      },
    } as unknown as PluginContext;
    const resultFull = await measureAdsExperiment(mockCtxFull, "co1", "acc1", "camp1", { control: ["a0"], variant: ["a1"] }, { today: TODAY });
    expect(resultFull.truncated).toBe(true);

    // Return one fewer
    const mockCtxFewer = {
      db: {
        namespace: "plugin_test",
        async query(sql: string) {
          if (!sql.includes("ad_daily")) return [];
          return Array.from({ length: MAX_ROWS - 1 }, (_, i) => ({
            account_id: "acc1",
            campaign_external_id: "camp1",
            ad_external_id: `a${i % 20}`,
            day: daysAgo(i % 14),
            spend_minor: 100,
            impressions: 1000,
            clicks: 0,
            conversions: 10,
            frequency: 0,
          }));
        },
      },
    } as unknown as PluginContext;
    const resultFewer = await measureAdsExperiment(mockCtxFewer, "co1", "acc1", "camp1", { control: ["a0"], variant: ["a1"] }, { today: TODAY });
    expect(resultFewer.truncated).toBe(false);
  });

  it("judgeAdsExperiment: clear WIN when variant CPAs are cheaper than control", () => {
    // Control ads: c1 CPA 10, c2 CPA 15 -> median 12.5, indexes 1.25, 0.83
    // Variant ads: v1 CPA 5, v2 CPA 7 -> median 6, indexes 2.5, 1.71
    // Variant median 1.71 > control median 1.04 -> variant wins
    const rows = [
      row("c1", TODAY, 100, 1000, 10), // CPA 10
      row("c2", TODAY, 150, 1000, 10), // CPA 15
      row("v1", TODAY, 50, 1000, 10), // CPA 5
      row("v2", TODAY, 70, 1000, 10), // CPA 7
    ];
    const r = judgeAdsExperiment(rows, { control: ["c1", "c2"], variant: ["v1", "v2"] }, { today: TODAY });
    expect(r.verdict).toBe("win");
    expect(r.winner).toBe("variant");
  });

  it("judgeAdsExperiment: clear LOSS when control CPAs are cheaper than variant", () => {
    // Reverse of above: control has cheaper CPAs
    const rows = [
      row("c1", TODAY, 50, 1000, 10), // CPA 5
      row("c2", TODAY, 70, 1000, 10), // CPA 7
      row("v1", TODAY, 100, 1000, 10), // CPA 10
      row("v2", TODAY, 150, 1000, 10), // CPA 15
    ];
    const r = judgeAdsExperiment(rows, { control: ["c1", "c2"], variant: ["v1", "v2"] }, { today: TODAY });
    expect(r.verdict).toBe("loss");
    expect(r.winner).toBe("control");
  });

  it("judgeAdsExperiment: no winner when CPAs are near-equal", () => {
    // Both arms have similar CPAs: control median 10, variant median 10.5
    const rows = [
      row("c1", TODAY, 100, 1000, 10), // CPA 10
      row("c2", TODAY, 105, 1000, 10), // CPA 10.5
      row("v1", TODAY, 102, 1000, 10), // CPA 10.2
      row("v2", TODAY, 108, 1000, 10), // CPA 10.8
    ];
    const r = judgeAdsExperiment(rows, { control: ["c1", "c2"], variant: ["v1", "v2"] }, { today: TODAY });
    expect(r.winner).toBeNull();
  });
});
