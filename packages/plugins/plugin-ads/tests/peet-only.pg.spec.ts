/**
 * PAR-6684: every kind that can raise spend is the owner's (a person's) alone, whatever the amount; the Account Manager (the owner's delegate) is
 * refused at proposal time (recordSignoff) and at run time (executeProposal). Pause and a true budget decrease keep the role route. Every create
 * request is sent PAUSED, and a payload asking for ACTIVE is refused. Fixtures only: the mock platform records every write it is asked for.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getProposal, insertApproval, table } from "../src/db.js";
import { AdsError } from "../src/domain.js";
import { executeProposal } from "../src/execute.js";
import { routeFromImpact } from "../src/owner-route.js";
import { assertPlatformCapsFor } from "../src/platformCaps.js";
import { SPEND_KINDS, type ProposalKind } from "../src/platforms.js";
import { createProposal, recordReview, recordSignoff } from "../src/proposals.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";
import { ADS_AGENT, AM_AGENT, COMPANY, OWNER, REVIEWER, world, type World } from "./helpers/world.js";
import { CHANGE_BUDGET, CREATE, CREATE_AD, CREATE_AD_SET, propose, syncedAccount } from "./helpers/scenario.js";

const available = await embeddedAvailable();
let pg: Pg;
beforeAll(async () => { if (available) pg = await startPg(); }, 120_000);
afterAll(async () => { if (available) await pg.stop(); });

const agent = { agentId: ADS_AGENT };
type Platform = "mock" | "meta" | "google";
const RSA = (accountId: string) => ({ kind: "create_responsive_search_ad", scopeKey: "own", accountId, adGroupExternalId: "ag-1", headlines: ["Luxury shoes", "Free delivery", "Shop the sale"], descriptions: ["Hand made shoes for every day.", "Order today, delivered in 3 days."], finalUrl: "https://example.com/shoes?utm_source=google&utm_medium=cpc&utm_campaign=shoes", path1: "shoes", reason: "Search ad for the shoe range." });

/** Each Peet-only kind, the platform it runs on, and a valid input. Amounts are small on purpose: under the 50,000 threshold. */
const PEET_ONLY: Array<[ProposalKind, Platform, (accountId: string) => Record<string, unknown>]> = [
  ["create_campaign", "mock", (a) => CREATE(a, { dailyBudgetMinor: 100, startDate: "2026-10-20", endDate: "2026-10-21" })],
  ["create_ad_set", "meta", (a) => CREATE_AD_SET(a, { lifetimeBudgetMinor: 100 })],
  ["resume_campaign", "mock", (a) => ({ kind: "resume_campaign", scopeKey: "own", targets: [{ accountId: a, campaignExternalId: "c2" }], reason: "Sale starts" })],
  ["change_budget", "mock", (a) => CHANGE_BUDGET(a, "c1", 10_100)],
  ["create_ad", "meta", (a) => CREATE_AD(a)],
  ["create_ad_group", "google", (a) => ({ kind: "create_ad_group", scopeKey: "own", accountId: a, campaignExternalId: "c1", name: "Brand", cpcBidMinor: 10, reason: "Structure." })],
  ["add_keywords", "google", (a) => ({ kind: "add_keywords", scopeKey: "own", accountId: a, adGroupExternalId: "ag-1", keywords: [{ text: "shoes", matchType: "exact" }], reason: "Terms." })],
  ["create_responsive_search_ad", "google", (a) => RSA(a)],
];
const CREATES = PEET_ONLY.filter(([kind]) => kind !== "resume_campaign" && kind !== "change_budget");

async function refusal(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AdsError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("expected a refusal");
}

async function account(w: World, platform: Platform): Promise<string> {
  return (await syncedAccount(w, platform === "mock" ? {} : { platform, connectionPlatform: "mock" })).accountId;
}

async function reviewed(w: World, input: Record<string, unknown>) {
  const p = await propose(w, input);
  await recordReview(w.rt(), { agentId: REVIEWER }, { proposalId: p.id, verdict: "pass" });
  return p;
}

/** An Account Manager approval written straight to the table (as if it had slipped past recordSignoff), and the proposal marked approved. */
async function forgedDelegateApproval(w: World, proposalId: string): Promise<string> {
  const p = (await getProposal(w.ctx, COMPANY, proposalId))!;
  const approvalId = await insertApproval(w.ctx, { companyId: COMPANY, proposalId, role: "owner", decision: "approved", decidedBy: `agent:${AM_AGENT}`, contentHash: p.content_hash, overCapAck: false, note: null, evidenceRef: null, expiresAt: "2026-10-17T10:00:00Z" });
  await w.ctx.db.execute(`UPDATE ${table(w.ctx, "proposals")} SET status = 'approved' WHERE id = $1`, [proposalId]);
  return approvalId;
}

const amSignoff = (w: World, proposalId: string) => recordSignoff(w.rt(), { proposalId, userId: null, agentId: AM_AGENT, role: "owner", decision: "approved", via: "tool" });
const ownerSignoff = (w: World, proposalId: string) => recordSignoff(w.rt(), { proposalId, userId: OWNER, role: "owner", decision: "approved", via: "page" });
const setPayload = (w: World, id: string, patch: Record<string, unknown>) => w.ctx.db.execute(`UPDATE ${table(w.ctx, "proposals")} SET payload = payload || $2::jsonb WHERE id = $1`, [id, JSON.stringify(patch)]);
const nullCampaignBudget = (w: World, accountId: string, id: string) => w.ctx.db.execute(`UPDATE ${table(w.ctx, "campaigns")} SET daily_budget_minor = NULL WHERE company_id = $1 AND account_id = $2 AND external_id = $3`, [COMPANY, accountId, id]);

describe.skipIf(!available)("Peet-only set: spend-raising kinds", () => {
  let w: World;
  beforeEach(async () => { await pg.reset(); w = await world(pg); });

  for (const [kind, platform, input] of PEET_ONLY) {
    it(`${kind}: owner_required at creation, the delegate is refused at proposal time and at run time`, async () => {
      const accountId = await account(w, platform);
      const p = await reviewed(w, input(accountId));
      expect(routeFromImpact(p.impact)?.route).toBe("owner_required");
      expect(await refusal(amSignoff(w, p.id))).toMatchObject({ code: "owner_required", message: expect.stringContaining("raise spend") });
      const approvalId = await forgedDelegateApproval(w, p.id);
      expect(await refusal(executeProposal(w.rt(), agent, { proposalId: p.id, approvalId }))).toMatchObject({ code: "owner_required" });
      expect(w.mock.writes).toEqual([]);
    });
  }

  for (const [kind, platform, input] of CREATES) {
    it(`${kind}: a payload asking for ACTIVE is refused at proposal time and at run time; the owner's run sends PAUSED`, async () => {
      const accountId = await account(w, platform);
      expect(await refusal(createProposal(w.rt(), agent, { ...input(accountId), status: "ACTIVE" }))).toMatchObject({ code: "not_paused" });
      const p = await reviewed(w, input(accountId));
      const { approvalId } = await ownerSignoff(w, p.id);
      await setPayload(w, p.id, { status: "ACTIVE" });
      expect(await refusal(executeProposal(w.rt(), agent, { proposalId: p.id, approvalId }))).toMatchObject({ code: "not_paused" });
      expect(w.mock.writes).toEqual([]);
      await w.ctx.db.execute(`UPDATE ${table(w.ctx, "proposals")} SET payload = payload - 'status' WHERE id = $1`, [p.id]);
      expect(await executeProposal(w.rt(), agent, { proposalId: p.id, approvalId })).toMatchObject({ status: "executed" });
      expect(w.mock.createStatuses).toEqual([{ op: expect.any(String), status: "PAUSED" }]);
    });
  }
});

describe.skipIf(!available)("Peet-only set: change_budget direction", () => {
  let w: World, accountId: string;
  beforeEach(async () => { await pg.reset(); w = await world(pg); accountId = await account(w, "mock"); });

  it("a true decrease keeps the role route: the delegate approves and it runs once", async () => {
    const p = await reviewed(w, CHANGE_BUDGET(accountId, "c1", 5000));
    expect(routeFromImpact(p.impact)?.route).toBe("delegate");
    const { approvalId } = await amSignoff(w, p.id);
    expect(await executeProposal(w.rt(), agent, { proposalId: p.id, approvalId })).toMatchObject({ status: "executed" });
    expect(w.mock.writes).toEqual([expect.objectContaining({ op: "budget", campaignExternalId: "c1", dailyBudgetMinor: 5000 })]);
  });

  it("an increase is the owner's alone", async () => {
    const p = await reviewed(w, CHANGE_BUDGET(accountId, "c1", 10_001));
    expect(await refusal(amSignoff(w, p.id))).toMatchObject({ code: "owner_required" });
    const { approvalId } = await ownerSignoff(w, p.id);
    expect(await executeProposal(w.rt(), agent, { proposalId: p.id, approvalId })).toMatchObject({ status: "executed" });
  });

  it("a decrease whose campaign budget is now null counts as spend-raising, at proposal time and at run time", async () => {
    const p = await reviewed(w, CHANGE_BUDGET(accountId, "c1", 5000));
    const { approvalId } = await amSignoff(w, p.id);
    await nullCampaignBudget(w, accountId, "c1");
    expect(await refusal(executeProposal(w.rt(), agent, { proposalId: p.id, approvalId }))).toMatchObject({ code: "owner_required" });
    const q = await reviewed(w, CHANGE_BUDGET(accountId, "c3", 5000));
    await nullCampaignBudget(w, accountId, "c3");
    expect(await refusal(amSignoff(w, q.id))).toMatchObject({ code: "owner_required" });
    expect(w.mock.writes).toEqual([]);
  });

  it("a decrease whose payload lost newDailyBudgetMinor counts as spend-raising at run time", async () => {
    const p = await reviewed(w, CHANGE_BUDGET(accountId, "c1", 5000));
    const { approvalId } = await amSignoff(w, p.id);
    await setPayload(w, p.id, { newDailyBudgetMinor: null });
    expect(await refusal(executeProposal(w.rt(), agent, { proposalId: p.id, approvalId }))).toMatchObject({ code: "owner_required" });
    expect(w.mock.writes).toEqual([]);
  });
});

describe.skipIf(!available)("assertPlatformCapsFor fails closed", () => {
  let w: World, accountId: string;
  beforeEach(async () => { await pg.reset(); w = await world(pg); accountId = await account(w, "mock"); });

  it("throws for a spend kind it has no branch for (PAR-3765)", async () => {
    expect(await refusal(assertPlatformCapsFor(w.rt(), "create_ad", { accountId }, [...SPEND_KINDS, "create_ad"]))).toMatchObject({ code: "platform_caps_unchecked" });
  });

  it("every SPEND_KINDS kind has a branch, and a missing account refuses instead of skipping", async () => {
    const payloads: Record<string, Record<string, unknown>> = { resume_campaign: { targets: [{ accountId: "gone", campaignExternalId: "c1" }] } };
    for (const kind of SPEND_KINDS) {
      expect(await refusal(assertPlatformCapsFor(w.rt(), kind, payloads[kind] ?? { accountId: "gone", campaignExternalId: "c1" }))).toMatchObject({ code: "no_account" });
      expect(await refusal(assertPlatformCapsFor(w.rt(), kind, kind === "resume_campaign" ? { targets: [] } : {}))).toMatchObject({ code: "no_account" });
    }
  });
});
