/** The canary Results fixture against a real Postgres: refuses non-canary clients, seeds once, numbers match the hand count. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { seedCanaryResultsFixture, FIXTURE_REPLY_TEXT } from "../src/canary-fixture.js";
import { stepEventStats } from "../src/db.js";
import { replyList } from "../src/people.js";
import { CO } from "./helpers/harness.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const available = await embeddedAvailable();

describe.skipIf(!available)("canary results fixture (postgres)", () => {
  let h: PgHarness;
  let ctx: PluginContext;
  beforeAll(async () => {
    h = await startPg();
    ctx = h.ctx;
  }, 60_000);
  afterAll(async () => {
    await h?.stop();
  });

  it("refuses a client that is not the canary", async () => {
    await expect(seedCanaryResultsFixture(ctx, CO, { client: "company:3f2a-real" })).rejects.toThrow(/canary client only/);
  });

  it("seeds the hand-counted numbers once and again changes nothing", async () => {
    const first = await seedCanaryResultsFixture(ctx, CO, { client: "company:canary-abc12345" });
    expect(first.created).toBe(true);
    const pick = (step: number) => first.byStep.find((s) => s.stepPosition === step)!;
    expect(pick(1)).toMatchObject({ sent: 6, delivered: 5, opens: 3, clicks: 1, replies: 1, bounces: 1, complaints: 1, unsubscribes: 0 });
    expect(pick(2)).toMatchObject({ sent: 2, delivered: 2, unsubscribes: 1, replies: 0 });
    const v = (step: number, variant: string) => first.byVersion.find((r) => r.stepPosition === step && r.variant === variant)!;
    expect(v(1, "a")).toMatchObject({ sent: 3, delivered: 3, opens: 2, clicks: 1, replies: 1 });
    expect(v(1, "b")).toMatchObject({ sent: 3, delivered: 2, opens: 1, bounces: 1, complaints: 1 });

    const second = await seedCanaryResultsFixture(ctx, CO, { client: "company:canary-abc12345" });
    expect(second.created).toBe(false);
    expect(second.campaignId).toBe(first.campaignId);
    expect(await stepEventStats(ctx, first.campaignId)).toEqual(first.byStep);
  });

  it("keeps the reply text and only canary.invalid addresses", async () => {
    const { campaignId } = await seedCanaryResultsFixture(ctx, CO, { client: "company:canary-abc12345" });
    const replies = await replyList(ctx, CO, campaignId, [{ position: 1, subject: "x" }]);
    expect(JSON.stringify(replies)).toContain(FIXTURE_REPLY_TEXT);
    const rows = await h.client.query(`SELECT email FROM plugin_campaigns_d355219713.suppressions WHERE campaign_id = $1`, [campaignId]);
    expect(rows.rows.length).toBe(2);
    for (const r of rows.rows as Array<{ email: string }>) expect(r.email).toMatch(/@canary\.invalid$/);
  });
});
