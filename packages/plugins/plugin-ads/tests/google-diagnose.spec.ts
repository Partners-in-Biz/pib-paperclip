/** diagnose-google-campaign (PAR-11049): read-only GAQL, one section per query, a failing section does not sink the rest. */
import { describe, expect, it } from "vitest";
import { diagnoseCampaign, type GaqlRunner } from "../src/providers/google-diagnose.js";

const rows: Record<string, Array<Record<string, any>>> = {
  "Google campaign": [{ campaign: { id: "22905170639", status: "ENABLED", servingStatus: "SERVING", primaryStatus: "LIMITED", primaryStatusReasons: ["BIDDING_STRATEGY_LEARNING"], biddingStrategyType: "MAXIMIZE_CLICKS", startDate: "2026-11-01" } }],
  "Google ad groups": [{ adGroup: { id: "1", name: "AG", status: "ENABLED", primaryStatus: "ELIGIBLE", cpcBidMicros: "1000000" } }],
  "Google ads": [{ adGroup: { id: "1" }, adGroupAd: { ad: { id: "9" }, status: "ENABLED", policySummary: { approvalStatus: "APPROVED_LIMITED", reviewStatus: "REVIEWED", policyTopicEntries: [{ topic: "TRADEMARKS" }] } } }],
  "Google keywords": [{ adGroup: { id: "1" }, adGroupCriterion: { keyword: { text: "software developer", matchType: "PHRASE" }, status: "ENABLED", systemServingStatus: "RARELY_SERVED", approvalStatus: "APPROVED" } }],
  "Google customer status": [{ customer: { id: "7585296111", status: "ENABLED" } }],
  "Google billing setup": [{ billingSetup: { status: "APPROVED", paymentsAccount: "customers/7585296111/paymentsAccounts/x" } }],
  "Google targeting": [{ campaignCriterion: { type: "LOCATION" } }, { campaignCriterion: { type: "LOCATION" } }, { campaignCriterion: { type: "AD_SCHEDULE" } }, { campaignCriterion: { type: "LANGUAGE" } }],
};

describe("diagnoseCampaign", () => {
  it("returns every section, filters by the campaign id, and only issues SELECT queries", async () => {
    const queries: string[] = [];
    const run: GaqlRunner = async (q, label) => {
      queries.push(q);
      return rows[label] ?? [];
    };
    const d = await diagnoseCampaign(run, "758-529-6111", "22905170639");
    expect(queries.every((q) => q.startsWith("SELECT"))).toBe(true);
    expect(queries.filter((q) => q.includes("campaign.id = 22905170639")).length).toBe(5);
    expect(d.customerId).toBe("7585296111");
    expect(d.campaign).toMatchObject({ ok: true, data: { primaryStatusReasons: ["BIDDING_STRATEGY_LEARNING"], servingStatus: "SERVING" } });
    expect(d.adGroups).toMatchObject({ ok: true, data: [{ name: "AG", cpcBidMicros: "1000000" }] });
    expect(d.ads).toMatchObject({ ok: true, data: [{ adGroupId: "1", policySummary: { approvalStatus: "APPROVED_LIMITED" } }] });
    expect(d.keywords).toMatchObject({ ok: true, data: [{ systemServingStatus: "RARELY_SERVED" }] });
    expect(d.billing).toMatchObject({ ok: true, data: { customerStatus: "ENABLED", billingSetups: [{ status: "APPROVED" }] } });
    expect(d.targeting).toEqual({ ok: true, data: { locations: 2, schedules: 1, other: 1 } });
  });

  it("returns a failing section as an error and keeps the rest", async () => {
    const run: GaqlRunner = async (_q, label) => {
      if (label === "Google billing setup") throw new Error("Google billing setup: permission denied");
      return rows[label] ?? [];
    };
    const d = await diagnoseCampaign(run, "7585296111", "22905170639");
    expect(d.billing).toEqual({ ok: false, error: "Google billing setup: permission denied" });
    expect(d.campaign.ok).toBe(true);
    expect(d.keywords.ok).toBe(true);
  });

  it("rejects a campaign id with no digits (no query injection)", async () => {
    await expect(diagnoseCampaign(async () => [], "1", "abc")).rejects.toThrow(/campaignId/);
    const q: string[] = [];
    await diagnoseCampaign(async (s) => (q.push(s), []), "1", "12; DROP");
    expect(q[0]).toContain("campaign.id = 12");
  });
});
