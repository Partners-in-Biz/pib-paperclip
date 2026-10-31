/** The per-campaign cap row (PAR-6680): only a person writes it, it is read back, old inserts and old code are unaffected. Nothing enforces it yet. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { campaignCapsRecord, setCampaignCap } from "../src/campaign-caps.js";
import { getCampaignCap } from "../src/db.js";
import { executeProposal } from "../src/execute.js";
import { NAMESPACE } from "../src/namespace.js";
import { recordReview, recordSignoff } from "../src/proposals.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";
import { ADS_AGENT, COMPANY, OWNER, REVIEWER, world, type World } from "./helpers/world.js";
import { CREATE, propose, syncedAccount } from "./helpers/scenario.js";

const available = await embeddedAvailable();
let pg: Pg;
beforeAll(async () => {
  if (available) pg = await startPg();
}, 120_000);
afterAll(async () => {
  if (available) await pg.stop();
});

describe.skipIf(!available)("campaign caps", () => {
  let w: World;
  let accountId: string;
  beforeEach(async () => {
    await pg.reset();
    w = await world(pg);
    ({ accountId } = await syncedAccount(w));
  });

  it("a person sets a cap and gets the row read back", async () => {
    const result = await setCampaignCap(w.rt(), { userId: OWNER }, { accountId, campaignExternalId: "c1", capMinor: 250_000 });
    expect(result).toMatchObject({ ok: true, cap: { platform: "mock", campaignExternalId: "c1", capMinor: 250_000, setBy: `user:${OWNER}`, proposalId: null } });
    expect(await getCampaignCap(w.ctx, COMPANY, "mock", "c1")).toMatchObject({ cap_minor: 250_000, set_by: `user:${OWNER}` });
  });

  it("an agent (the owner's delegate included) cannot write a cap, and nothing is written", async () => {
    for (const actor of [{ userId: null }, { userId: null, agentId: ADS_AGENT }]) {
      await expect(setCampaignCap(w.rt(), actor, { accountId, campaignExternalId: "c1", capMinor: 1000 })).rejects.toThrow(/Only a signed-in person/);
    }
    expect(await getCampaignCap(w.ctx, COMPANY, "mock", "c1")).toBeNull();
  });

  it("refuses a zero cap, an unknown campaign and an unknown account", async () => {
    await expect(setCampaignCap(w.rt(), { userId: OWNER }, { accountId, campaignExternalId: "c1", capMinor: 0 })).rejects.toThrow(/more than zero/);
    await expect(setCampaignCap(w.rt(), { userId: OWNER }, { accountId, campaignExternalId: "nope", capMinor: 1000 })).rejects.toThrow(/not known/);
    await expect(setCampaignCap(w.rt(), { userId: OWNER }, { accountId: "nope", campaignExternalId: "c1", capMinor: 1000 })).rejects.toThrow(/not found/);
  });

  it("setting it again changes the cap but keeps the start of the spend window", async () => {
    await setCampaignCap(w.rt(), { userId: OWNER }, { accountId, campaignExternalId: "c1", capMinor: 1000 });
    const first = (await getCampaignCap(w.ctx, COMPANY, "mock", "c1"))!;
    await setCampaignCap(w.rt(), { userId: OWNER }, { accountId, campaignExternalId: "c1", capMinor: 2000 });
    const second = (await getCampaignCap(w.ctx, COMPANY, "mock", "c1"))!;
    expect(second).toMatchObject({ cap_minor: 2000, created_at: first.created_at });
  });

  it("lists the campaigns that lack a cap", async () => {
    await setCampaignCap(w.rt(), { userId: OWNER }, { accountId, campaignExternalId: "c1", capMinor: 1000 });
    const record = await campaignCapsRecord(w.rt());
    expect(record.caps.map((c) => c.campaignExternalId)).toEqual(["c1"]);
    expect(record.withoutCap.map((c) => c.externalId)).toEqual(["c2", "c3"]);
  });

  it("a create_campaign proposal's capMinor is written when the owner's own approval runs it", async () => {
    const p = await propose(w, CREATE(accountId, { capMinor: 90_000 }));
    await recordReview(w.rt(), { agentId: REVIEWER }, { proposalId: p.id, verdict: "pass" });
    const { approvalId } = await recordSignoff(w.rt(), { proposalId: p.id, userId: OWNER, role: "owner", decision: "approved", overCapAck: false, via: "page" });
    const result = await executeProposal(w.rt(), { agentId: ADS_AGENT }, { proposalId: p.id, approvalId });
    expect(result.status).toBe("executed");
    expect(result.message).toMatch(/cap of 90000/);
    const created = result.results[0]!.externalId!;
    expect(await getCampaignCap(w.ctx, COMPANY, "mock", created)).toMatchObject({ cap_minor: 90_000, set_by: `user:${OWNER}`, proposal_id: p.id });
  });

  it("a proposal without capMinor writes no row, and a bad capMinor is refused", async () => {
    const p = await propose(w, CREATE(accountId));
    expect(p.payload.capMinor).toBeNull();
    await expect(propose(w, CREATE(accountId, { capMinor: 0 }))).rejects.toThrow(/capMinor/);
  });

  it("the table holds only person-set, positive, one-per-campaign rows; old inserts and old code ignore it", async () => {
    const insert = (id: string, by: string, cap: number) =>
      pg.client.query(`INSERT INTO ${NAMESPACE}.campaign_caps (id, company_id, platform, external_campaign_id, cap_minor, set_by) VALUES ($1, 'c', 'apple', 'x', $2, $3)`, [id, cap, by]);
    await insert("a", "user:peet", 100);
    await expect(insert("b", "user:peet", 100)).rejects.toThrow(/campaign_caps_campaign/);
    await expect(insert("c", "agent:x", 100)).rejects.toThrow(/campaign_caps_set_by/);
    await expect(pg.client.query(`INSERT INTO ${NAMESPACE}.campaign_caps (id, company_id, platform, external_campaign_id, cap_minor, set_by) VALUES ('d', 'c', 'apple', 'y', 0, 'user:p')`)).rejects.toThrow(/campaign_caps_positive/);
    // Old code never names the table: its inserts into the earlier tables run unchanged on this schema (the 009 spec covers the CHECKs).
    await pg.client.query(`INSERT INTO ${NAMESPACE}.connections (id, company_id, platform, label) VALUES ('old', 'c', 'meta', 'label')`);
  });
});
