/** Hourly sweeper, per-campaign hard cap (PAR-6683): pauses ACTIVE campaigns at or over cap_minor; a failed read alerts per account. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getCampaign, listAlerts, upsertCampaignCap } from "../src/db.js";
import { sweepCaps } from "../src/sweeper.js";
import { syncAccount } from "../src/sync.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";
import { COMPANY, world, type World } from "./helpers/world.js";
import { campaign as mkCampaign, syncedAccount } from "./helpers/scenario.js";

const available = await embeddedAvailable();
let pg: Pg;
beforeAll(async () => { if (available) pg = await startPg(); }, 120_000);
afterAll(async () => { if (available) await pg.stop(); });

/** Cap rows are dated here, so the cap read is the only insights call with this `since`. */
const CAP_DAY = "2026-10-02";

describe.skipIf(!available)("sweepCaps: per-campaign cap", () => {
  let w: World;
  beforeEach(async () => { await pg.reset(); w = await world(pg); });

  /** Seeds ACTIVE campaigns through the mock provider, syncs, and writes cap rows dated CAP_DAY. */
  const seed = async (campaigns: { id: string; spend: number; cap?: number }[]) => {
    const { accountId } = await syncedAccount(w);
    const acct = (await w.ctx.db.query(`SELECT * FROM ${w.ctx.db.namespace}.ad_accounts WHERE id = $1`, [accountId]))[0] as Record<string, unknown>;
    const extId = String(acct.external_id);
    await w.ctx.db.execute(`DELETE FROM ${w.ctx.db.namespace}.campaigns WHERE account_id = $1`, [accountId]);
    w.mock.campaigns[extId] = campaigns.map((c) => mkCampaign(c.id, "active", 10_000));
    w.mock.insightRows[extId] = campaigns.map((c) => ({ campaignExternalId: c.id, campaignName: `Campaign ${c.id}`, day: "2026-10-15", spendMinor: c.spend, impressions: 2000, clicks: 80, conversions: 3, valueMinor: 30_000 }));
    await (syncAccount(w.rt(), acct as any) as Promise<any>);
    for (const c of campaigns) {
      if (c.cap === undefined) continue;
      await upsertCampaignCap(w.ctx, COMPANY, { platform: String(acct.platform), externalCampaignId: c.id, capMinor: c.cap, setBy: "user:owner", proposalId: null });
    }
    await w.ctx.db.execute(`UPDATE ${w.ctx.db.namespace}.campaign_caps SET created_at = $1::timestamptz WHERE company_id = $2`, [`${CAP_DAY}T12:00:00Z`, COMPANY]);
    return { accountId, extId, connectionId: String(acct.connection_id) };
  };
  const statusWrites = () => w.mock.writes.filter((x) => x.op === "status").length;
  const alertsLike = async (prefix: string) => (await listAlerts(w.ctx, COMPANY, { scopeKey: "own" })).filter((a) => a.dedupe_key.startsWith(prefix));
  /** Makes only the cap read (since CAP_DAY) misbehave; the sweeper's other insights reads still work. */
  const breakCapRead = (how: () => Promise<any>) => {
    const orig = w.mock.insights.bind(w.mock);
    w.mock.insights = (async (env: any, token: any, account: any, range: { since: string; until: string }) => (range.since === CAP_DAY ? how() : orig(env, token, account, range))) as any;
  };

  it("(q) through the mock provider: over and at cap are paused; under cap and no cap row stay active", async () => {
    const { accountId } = await seed([
      { id: "over", spend: 30_000, cap: 25_000 },
      { id: "at", spend: 20_000, cap: 20_000 },
      { id: "under", spend: 10_000, cap: 100_000 },
      { id: "nocap", spend: 90_000 },
    ]);
    const result = await sweepCaps(w.rt());
    expect(result.paused).toBe(2);
    expect(result.errors).toBe(0);
    expect((await getCampaign(w.ctx, COMPANY, accountId, "over"))?.status).toBe("paused");
    expect((await getCampaign(w.ctx, COMPANY, accountId, "at"))?.status).toBe("paused");
    expect((await getCampaign(w.ctx, COMPANY, accountId, "under"))?.status).toBe("active");
    expect((await getCampaign(w.ctx, COMPANY, accountId, "nocap"))?.status).toBe("active");
    expect(w.mock.writes.filter((x) => x.op === "status").map((x: any) => x.campaignExternalId).sort()).toEqual(["at", "over"]);
    const pausedAlerts = await alertsLike("sweep-paused:");
    expect(pausedAlerts).toHaveLength(2);
    for (const a of pausedAlerts as any[]) {
      expect(a.kind).toBe("spend_spike");
      expect(a.detail).toMatchObject({ campaignCap: true });
    }
    expect((pausedAlerts as any[]).find((a) => a.detail.campaignExternalId === "over")?.detail).toMatchObject({ capMinor: 25_000, spentMinor: 30_000 });
  });

  it("(r) unreadable cap read: error counted, one alert per account, no pause, no write", async () => {
    const { accountId } = await seed([{ id: "c1", spend: 30_000, cap: 25_000 }, { id: "c2", spend: 30_000, cap: 25_000 }]);
    breakCapRead(async () => { throw new Error("HTTP 500 from platform"); });
    const before = statusWrites();
    const result = await sweepCaps(w.rt());
    expect(result.errors).toBe(1);
    expect(result.paused).toBe(0);
    expect(statusWrites() - before).toBe(0);
    expect((await getCampaign(w.ctx, COMPANY, accountId, "c1"))?.status).toBe("active");
    const unread = await alertsLike("sweep-cap-unread:");
    expect(unread).toHaveLength(1);
    expect((unread[0] as any).kind).toBe("spend_spike");
    expect((unread[0] as any).detail).toMatchObject({ campaignCap: true, campaigns: 2 });
    await sweepCaps(w.rt());
    expect(await alertsLike("sweep-cap-unread:")).toHaveLength(1);
  });

  it("(s) empty cap read for a campaign that has spent before is a failure, not zero", async () => {
    const { accountId } = await seed([{ id: "c1", spend: 30_000, cap: 25_000 }]);
    breakCapRead(async () => []);
    const result = await sweepCaps(w.rt());
    expect(result.errors).toBe(1);
    expect(result.paused).toBe(0);
    expect((await getCampaign(w.ctx, COMPANY, accountId, "c1"))?.status).toBe("active");
    expect(await alertsLike("sweep-cap-unread:")).toHaveLength(1);
  });

  it("(t) revoked connection (PAR-3756): over-cap campaign is not paused, no write, account alert", async () => {
    const { accountId, connectionId } = await seed([{ id: "c1", spend: 30_000, cap: 25_000 }]);
    await w.ctx.db.execute(`UPDATE ${w.ctx.db.namespace}.connections SET status = $1 WHERE id = $2`, ["needs_reconnect", connectionId]);
    const before = statusWrites();
    const result = await sweepCaps(w.rt());
    expect(result.errors).toBeGreaterThanOrEqual(1);
    expect(result.paused).toBe(0);
    expect(statusWrites() - before).toBe(0);
    expect((await getCampaign(w.ctx, COMPANY, accountId, "c1"))?.status).toBe("active");
    const unreachable = await alertsLike(`cannot-reach-account:${accountId}`);
    expect(unreachable).toHaveLength(1);
    expect((unreachable[0] as any).kind).toBe("spend_spike");
  });
});
