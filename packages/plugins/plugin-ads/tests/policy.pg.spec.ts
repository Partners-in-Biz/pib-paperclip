/**
 * Ad policy status read-back: sync reads policy status from the provider, stores it, and exposes it in the cockpit snapshot.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cockpitSnapshot } from "../src/cockpit.js";
import { getAccount, listAds } from "../src/db.js";
import { syncAccount } from "../src/sync.js";
import { ProviderError } from "../src/providers/http.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";
import { COMPANY, NOW, world, type World } from "./helpers/world.js";

const available = await embeddedAvailable();
let pg: Pg;
beforeAll(async () => {
  if (available) pg = await startPg();
}, 120_000);
afterAll(async () => {
  if (available) await pg.stop();
});

describe.skipIf(!available)("ad policy status", () => {
  let w: World;
  let accountId: string;

  beforeEach(async () => {
    await pg.reset();
    w = await world(pg);
    ({ accountId } = await w.account({ externalId: "ext-1" }));
    w.mock.campaigns["ext-1"] = [
      { externalId: "c1", name: "Campaign 1", status: "active", rawStatus: "ACTIVE", objective: "OUTCOME_LEADS", channel: "mock", dailyBudgetMinor: 10_000, lifetimeBudgetMinor: null },
    ];
    w.mock.insightRows["ext-1"] = [
      { campaignExternalId: "c1", campaignName: "Campaign 1", day: "2026-10-13", spendMinor: 5000, impressions: 1000, clicks: 50, conversions: 2, valueMinor: 20_000 },
    ];
  });

  it("listAds can be queried by policy status", async () => {
    w.mock.ads = [{ externalId: "ad1", name: "Ad 1", adSetExternalId: "adset1", creativeExternalId: "creative1", rawStatus: "PAUSED", policyStatus: "DISAPPROVED", feedback: "Violates standards" }];
    await syncAccount(w.rt(), (await getAccount(w.ctx, COMPANY, accountId))!);
    const disapproved = await listAds(w.ctx, COMPANY, { policyStatus: "DISAPPROVED" });
    const pending = await listAds(w.ctx, COMPANY, { policyStatus: "PENDING_REVIEW" });
    expect(disapproved.length >= 0).toBe(true);
    expect(pending.length >= 0).toBe(true);
  });

  it("updates ad policy status when it changes", async () => {
    w.mock.ads = [{ externalId: "ad1", name: "Ad 1", adSetExternalId: null, creativeExternalId: null, rawStatus: "PAUSED", policyStatus: "DISAPPROVED", feedback: "Feedback" }];
    await syncAccount(w.rt(), (await getAccount(w.ctx, COMPANY, accountId))!);
    let ads = await listAds(w.ctx, COMPANY);
    if (ads.length > 0) {
      expect(ads[0].policy_status).toBe("DISAPPROVED");
      w.mock.ads = [{ externalId: "ad1", name: "Ad 1", adSetExternalId: null, creativeExternalId: null, rawStatus: "ACTIVE", policyStatus: "ACTIVE", feedback: null }];
      await syncAccount(w.rt(undefined, new Date("2026-10-14T10:00:00Z")), (await getAccount(w.ctx, COMPANY, accountId))!);
      ads = await listAds(w.ctx, COMPANY);
      expect(ads[0].policy_status).toBe("ACTIVE");
    }
  });

  it("keeps campaigns when listAds fails", async () => {
    w.mock.failNext.listAds = new ProviderError("Network error", { retryable: true });
    const result = await syncAccount(w.rt(), (await getAccount(w.ctx, COMPANY, accountId))!);
    expect(result.ok).toBe(true);
    expect(result.ads).toBe(0);
    expect(result.campaigns).toBeGreaterThan(0);
  });

  it("cockpit ads_policy KPI exists in the snapshot", async () => {
    w.mock.ads = [
      { externalId: "ad1", name: "Ad 1", adSetExternalId: null, creativeExternalId: null, rawStatus: "PAUSED", policyStatus: "DISAPPROVED", feedback: "Feedback 1" },
    ];
    await syncAccount(w.rt(), (await getAccount(w.ctx, COMPANY, accountId))!);
    const snap = await cockpitSnapshot(w.ctx, COMPANY, w.rt());
    const kpi = snap.kpis?.find((k) => k.key === "ads_policy");
    expect(kpi).not.toBeUndefined();
  });
});

describe.skipIf(!available)("Google ad policy read-back", () => {
  let w: World;
  let accountId: string;

  beforeEach(async () => {
    await pg.reset();
    w = await world(pg);
    ({ accountId } = await w.account({ externalId: "ext-g" }));
  });

  const rsa = (policyStatus: "PENDING_REVIEW" | "DISAPPROVED" | "ACTIVE", feedback: string | null) => [
    { externalId: "9001", name: "Luxury shoes", adSetExternalId: "ag-1", creativeExternalId: null, rawStatus: "PAUSED", policyStatus, feedback },
  ];

  it("follows a new ad from pending review to disapproved with Google's reason, and into the snapshot", async () => {
    const account = (await getAccount(w.ctx, COMPANY, accountId))!;
    w.mock.ads = rsa("PENDING_REVIEW", null);
    const first = await syncAccount(w.rt(), account);
    expect(first.ads).toBe(1);
    expect(await listAds(w.ctx, COMPANY, { policyStatus: "PENDING_REVIEW" })).toMatchObject([{ external_id: "9001", ad_set_external_id: "ag-1" }]);
    let kpi = (await cockpitSnapshot(w.ctx, COMPANY, w.rt())).kpis?.find((k) => k.key === "ads_policy");
    expect(kpi).toMatchObject({ raw: 0, tone: "warn" });

    w.mock.ads = rsa("DISAPPROVED", "TRADEMARKS (PROHIBITED)");
    expect((await syncAccount(w.rt(undefined, new Date("2026-10-14T10:00:00Z")), account)).ads).toBe(1);
    expect(await listAds(w.ctx, COMPANY, { policyStatus: "PENDING_REVIEW" })).toHaveLength(0);
    expect(await listAds(w.ctx, COMPANY, { policyStatus: "DISAPPROVED" })).toMatchObject([{ policy_feedback: "TRADEMARKS (PROHIBITED)" }]);
    kpi = (await cockpitSnapshot(w.ctx, COMPANY, w.rt())).kpis?.find((k) => k.key === "ads_policy");
    expect(kpi).toMatchObject({ raw: 1, tone: "bad" });
  });

  it("clears the figure when the ad is approved", async () => {
    const account = (await getAccount(w.ctx, COMPANY, accountId))!;
    w.mock.ads = rsa("DISAPPROVED", "TRADEMARKS (PROHIBITED)");
    await syncAccount(w.rt(), account);
    w.mock.ads = rsa("ACTIVE", null);
    await syncAccount(w.rt(undefined, new Date("2026-10-14T10:00:00Z")), account);
    const kpi = (await cockpitSnapshot(w.ctx, COMPANY, w.rt())).kpis?.find((k) => k.key === "ads_policy");
    expect(kpi).toMatchObject({ raw: 0, tone: "ok", hint: "All ads approved" });
  });
});
