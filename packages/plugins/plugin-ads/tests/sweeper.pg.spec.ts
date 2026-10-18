/** Hourly sweeper: pauses campaigns at lifetime/scope monthly caps, retries, raises alerts. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getCampaign, listAlerts, table, findAlert, setAlertState } from "../src/db.js";
import { sweepCaps } from "../src/sweeper.js";
import { syncAccount, syncCompany } from "../src/sync.js";
import { AdsError } from "../src/domain.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";
import { COMPANY, world, type World } from "./helpers/world.js";
import { campaign as mkCampaign, syncedAccount } from "./helpers/scenario.js";

const available = await embeddedAvailable();
let pg: Pg;
beforeAll(async () => { if (available) pg = await startPg(); }, 120_000);
afterAll(async () => { if (available) await pg.stop(); });

describe.skipIf(!available)("sweepCaps", () => {
  let w: World;
  beforeEach(async () => { await pg.reset(); w = await world(pg); });

  const seedCampaigns = async (campaigns: { id: string; status: "active" | "paused"; spend: number; lifetime?: number; scope?: boolean }[], insights?: { id: string; spend: number; day: string }[]) => {
    const { accountId } = await syncedAccount(w);
    const acct = (await w.ctx.db.query(`SELECT * FROM ${w.ctx.db.namespace}.ad_accounts WHERE id = $1`, [accountId]))[0] as Record<string, unknown>;
    const extId = String(acct.external_id);
    await w.ctx.db.execute(`DELETE FROM ${w.ctx.db.namespace}.campaigns WHERE account_id = $1`, [accountId]);
    w.mock.campaigns[extId] = campaigns.map((c) => ({ ...mkCampaign(c.id, c.status, c.spend), ...(c.lifetime && { lifetimeBudgetMinor: c.lifetime }) }));
    if (insights) w.mock.insightRows[extId] = insights.map((i) => ({ campaignExternalId: i.id, campaignName: `Campaign ${i.id}`, day: i.day, spendMinor: i.spend, impressions: 2000, clicks: 80, conversions: 3, valueMinor: 30_000 }));
    if (campaigns.some((c) => c.scope)) await w.ctx.db.execute(`UPDATE ${w.ctx.db.namespace}.scopes SET monthly_cap_minor = 50000 WHERE company_id = $1`, [COMPANY]);
    await (syncAccount(w.rt(), (await w.ctx.db.query(`SELECT * FROM ${w.ctx.db.namespace}.ad_accounts WHERE id = $1`, [accountId]))[0] as any) as Promise<any>);
    return { accountId, extId };
  };

  it("(a) lifetime cap: sync down then fresh insights breach", async () => {
    const { accountId, extId } = await seedCampaigns([{ id: "c1", status: "active", spend: 10_000, lifetime: 50_000 }], [{ id: "c1", spend: 20_000, day: "2026-10-15" }]);
    // Clear ledger to start fresh: ledger should be stale and under cap when sync fails
    await w.ctx.db.execute(`DELETE FROM ${w.ctx.db.namespace}.spend_ledger WHERE account_id = $1`, [accountId]);
    // Update mock to have breaching insights for the fresh call after sync fails
    w.mock.insightRows[extId] = [{ campaignExternalId: "c1", campaignName: "Campaign c1", day: "2026-10-15", spendMinor: 55_000, impressions: 2000, clicks: 80, conversions: 3, valueMinor: 30_000 }];
    w.mock.failNext.insights = new AdsError("sync");
    await syncCompany(w.rt()).catch(() => {});
    const ledger = await w.ctx.db.query<{ total: string }>(`SELECT COALESCE(SUM(delta_minor), 0)::text AS total FROM ${w.ctx.db.namespace}.spend_ledger WHERE account_id = $1 AND campaign_external_id = $2`, [accountId, "c1"]);
    expect(Number(ledger[0]?.total ?? 0)).toBe(0); // Ledger is empty (stale, sync failed)
    await sweepCaps(w.rt());
    expect((await getCampaign(w.ctx, COMPANY, accountId, "c1"))?.status).toBe("paused");
  });

  it("(b) retry on failure: pauses don't stick, critical alert", async () => {
    const { accountId, extId } = await seedCampaigns([{ id: "c1", status: "active", spend: 10_000, lifetime: 50_000 }], [{ id: "c1", spend: 55_000, day: "2026-10-15" }]);
    w.mock.setCampaignStatus = async () => { w.mock.writes.push({ op: "status", accountExternalId: extId, campaignExternalId: "c1", status: "paused" }); };
    const before = w.mock.writes.filter((x) => x.op === "status").length;
    const result = await sweepCaps(w.rt());
    expect(result.critical).toBe(1);
    expect((await listAlerts(w.ctx, COMPANY, { scopeKey: "own" })).some((a) => a.severity === "bad")).toBe(true);
    expect(w.mock.writes.filter((x) => x.op === "status").length - before).toBe(2);
  });

  it("(c) disapproved ads: warn alert, no pause", async () => {
    const { accountId, extId } = await seedCampaigns([{ id: "c1", status: "active", spend: 10_000 }], [{ id: "c1", spend: 10_000, day: "2026-10-15" }]);
    (w.mock as any).campaignHealth = async (_: any, __: any, ___: any, ids: string[]) => ids.map((id) => ({ campaignExternalId: id, status: "active", rawStatus: "ACTIVE", disapprovedAds: id === "c1" ? 2 : 0 })) as any;
    const result = await sweepCaps(w.rt());
    expect(result.disapprovedAlerts).toBe(1);
    expect(result.paused).toBe(0);
    expect((await getCampaign(w.ctx, COMPANY, accountId, "c1"))?.status).toBe("active");
  });

  it("(d) skip paused campaign", async () => {
    const { accountId } = await seedCampaigns([{ id: "c1", status: "paused", spend: 10_000, lifetime: 50_000 }], [{ id: "c1", spend: 55_000, day: "2026-10-15" }]);
    const result = await sweepCaps(w.rt());
    expect(result.paused).toBe(0);
    expect((await getCampaign(w.ctx, COMPANY, accountId, "c1"))?.status).toBe("paused");
  });

  it("(e) under-cap campaign: no alerts", async () => {
    const { accountId } = await seedCampaigns([{ id: "c1", status: "active", spend: 10_000 }], [{ id: "c1", spend: 10_000, day: "2026-10-15" }]);
    const result = await sweepCaps(w.rt());
    expect(result.paused + result.disapprovedAlerts + result.critical).toBe(0);
    expect((await getCampaign(w.ctx, COMPANY, accountId, "c1"))?.status).toBe("active");
  });

  it("(f) scope cap: fresh insights breach, pause all", async () => {
    const { accountId } = await seedCampaigns([
      { id: "c1", status: "active", spend: 5_000, scope: true },
      { id: "c2", status: "active", spend: 5_000, scope: true },
    ], [
      { id: "c1", spend: 35_000, day: "2026-10-15" },
      { id: "c2", spend: 20_000, day: "2026-10-15" },
    ]);
    const result = await sweepCaps(w.rt());
    expect(result.paused).toBe(2);
    expect((await getCampaign(w.ctx, COMPANY, accountId, "c1"))?.status).toBe("paused");
    expect((await getCampaign(w.ctx, COMPANY, accountId, "c2"))?.status).toBe("paused");
  });

  it("(g) both caps: single pause, single write", async () => {
    const { accountId, extId } = await seedCampaigns([{ id: "c1", status: "active", spend: 10_000, lifetime: 30_000, scope: true }], [{ id: "c1", spend: 60_000, day: "2026-10-15" }]);
    const before = w.mock.writes.filter((x) => x.op === "status").length;
    const result = await sweepCaps(w.rt());
    expect(result.paused).toBe(1);
    expect(w.mock.writes.filter((x) => x.op === "status").length - before).toBe(1);
    expect((await getCampaign(w.ctx, COMPANY, accountId, "c1"))?.status).toBe("paused");
  });

  it("(h) insights fail: error counted, no pause, no throw", async () => {
    const { accountId } = await seedCampaigns([{ id: "c1", status: "active", spend: 10_000, lifetime: 50_000 }]);
    w.mock.failNext.insights = new AdsError("net");
    const result = await sweepCaps(w.rt());
    expect(result.errors).toBeGreaterThanOrEqual(1);
    expect(result.paused).toBe(0);
    expect((await getCampaign(w.ctx, COMPANY, accountId, "c1"))?.status).toBe("active");
  });

  it("(i) ledger fallback: insights fail, ledger MTD >= cap, pause from ledger", async () => {
    const { accountId } = await seedCampaigns([{ id: "c1", status: "active", spend: 10_000, scope: true }], [{ id: "c1", spend: 60_000, day: "2026-10-15" }]);
    w.mock.failNext.insights = new AdsError("net");
    const result = await sweepCaps(w.rt());
    expect(result.errors).toBeGreaterThanOrEqual(1);
    expect(result.paused).toBe(1);
    expect((await getCampaign(w.ctx, COMPANY, accountId, "c1"))?.status).toBe("paused");
  });

  it("(j) lifetime cap: fresh lifetime insights with earlier spend, daily table empty", async () => {
    const { accountId, extId } = await seedCampaigns([{ id: "c1", status: "active", spend: 10_000, lifetime: 30_000 }], [{ id: "c1", spend: 10_000, day: "2026-10-15" }]);
    // Clear ledger; update mock to include earlier month rows for the fresh lifetime insights call
    await w.ctx.db.execute(`DELETE FROM ${w.ctx.db.namespace}.spend_ledger WHERE account_id = $1`, [accountId]);
    w.mock.insightRows[extId] = [{ campaignExternalId: "c1", campaignName: "Campaign c1", day: "2026-09-15", spendMinor: 20_000, impressions: 2000, clicks: 80, conversions: 3, valueMinor: 30_000 }, { campaignExternalId: "c1", campaignName: "Campaign c1", day: "2026-10-15", spendMinor: 10_000, impressions: 2000, clicks: 80, conversions: 3, valueMinor: 30_000 }];
    await w.ctx.db.execute(`DELETE FROM ${w.ctx.db.namespace}.daily WHERE campaign_external_id = $1`, ["c1"]);
    const ledger = await w.ctx.db.query<{ total: string }>(`SELECT COALESCE(SUM(delta_minor), 0)::text AS total FROM ${w.ctx.db.namespace}.spend_ledger WHERE account_id = $1 AND campaign_external_id = $2`, [accountId, "c1"]);
    expect(Number(ledger[0]?.total ?? 0)).toBe(0); // Ledger is empty; fresh insights with since='2000-01-01' will return 30_000 total
    const result = await sweepCaps(w.rt());
    expect(result.paused).toBe(1);
    expect((await getCampaign(w.ctx, COMPANY, accountId, "c1"))?.status).toBe("paused");
  });

  it("(k) missing campaignHealth row: pause fails verification, retry, critical alert", async () => {
    const { accountId, extId } = await seedCampaigns([{ id: "c1", status: "active", spend: 10_000, lifetime: 50_000 }], [{ id: "c1", spend: 55_000, day: "2026-10-15" }]);
    w.mock.setCampaignStatus = async () => { w.mock.writes.push({ op: "status", accountExternalId: extId, campaignExternalId: "c1", status: "paused" }); };
    (w.mock as any).campaignHealth = async () => [] as any;
    const result = await sweepCaps(w.rt());
    expect(result.critical).toBe(1);
    expect((await listAlerts(w.ctx, COMPANY, { scopeKey: "own" })).some((a) => a.severity === "bad")).toBe(true);
  });

  it("(l) disapproved dedupe: resolved alert triggers new alert", async () => {
    const { accountId } = await seedCampaigns([{ id: "c1", status: "active", spend: 10_000 }], [{ id: "c1", spend: 10_000, day: "2026-10-15" }]);
    (w.mock as any).campaignHealth = async (_: any, __: any, ___: any, ids: string[]) => ids.map((id) => ({ campaignExternalId: id, status: "active", rawStatus: "ACTIVE", disapprovedAds: 2 })) as any;
    await sweepCaps(w.rt());
    const alert = await findAlert(w.ctx, COMPANY, `sweep-disapproved:${accountId}:c1`);
    await setAlertState(w.ctx, COMPANY, alert!.id, "resolved", null);
    expect((await sweepCaps(w.rt())).disapprovedAlerts).toBe(1);
  });
});
