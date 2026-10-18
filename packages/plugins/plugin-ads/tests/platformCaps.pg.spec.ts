/**
 * Platform-side caps are checked at proposal time and execute time. When a spend-kind change is proposed or executed,
 * the account's spend cap and all ad set lifetime budgets must be set on the platform.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AdsError } from "../src/domain.js";
import { ProviderError } from "../src/providers/http.js";
import { executeProposal } from "../src/execute.js";
import { createProposal, recordReview, recordSignoff } from "../src/proposals.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";
import { ADS_AGENT, COMPANY, OWNER, REVIEWER, world, type World } from "./helpers/world.js";
import { CREATE, CREATE_AD_SET, PAUSE, propose, syncedAccount } from "./helpers/scenario.js";

const available = await embeddedAvailable();
let pg: Pg;
beforeAll(async () => {
  if (available) pg = await startPg();
}, 120_000);
afterAll(async () => {
  if (available) await pg.stop();
});

const agent = { agentId: ADS_AGENT };

async function refusal(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AdsError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("expected the change to be refused, but it succeeded");
}

describe.skipIf(!available)("platform-side cap guards", () => {
  let w: World;
  let accountId: string;

  beforeEach(async () => {
    await pg.reset();
    w = await world(pg);
    ({ accountId } = await syncedAccount(w));
  });

  it("(a) proposes a spend-kind change when cap is null -> no_platform_cap", async () => {
    w.mock.accountCapsData["ext-1"] = { spendCapMinor: null, adSets: [] };
    const err = await refusal(createProposal(w.rt(), agent, CREATE(accountId)));
    expect(err.code).toBe("no_platform_cap");
    expect(err.message).toContain("no platform spend cap");
  });

  it("(b) proposal created while cap existed, cap removed before execute -> refuse no_platform_cap", async () => {
    // Create and approve while cap exists
    w.mock.accountCapsData["ext-1"] = { spendCapMinor: 1_000_000_00, adSets: [] };
    const p = await propose(w, CREATE(accountId));
    await recordReview(w.rt(), { agentId: REVIEWER }, { proposalId: p.id, verdict: "pass" });
    const { approvalId } = await recordSignoff(w.rt(), { proposalId: p.id, userId: OWNER, role: "owner", decision: "approved", via: "page" });

    // Remove cap before execute
    w.mock.accountCapsData["ext-1"] = { spendCapMinor: null, adSets: [] };

    const err = await refusal(executeProposal(w.rt(), agent, { proposalId: p.id, approvalId }));
    expect(err.code).toBe("no_platform_cap");
    expect(w.mock.writes).toHaveLength(0); // No platform write happened
  });

  it("(c) an ad set with no lifetime budget -> adset_no_lifetime_budget at propose", async () => {
    w.mock.accountCapsData["ext-1"] = { spendCapMinor: 1_000_000_00, adSets: [{ externalId: "as-1", campaignExternalId: "c1", lifetimeBudgetMinor: null }] };
    const err = await refusal(createProposal(w.rt(), agent, { kind: "change_budget", scopeKey: "own", accountId, campaignExternalId: "c1", newDailyBudgetMinor: 5000, reason: "test" }));
    expect(err.code).toBe("adset_no_lifetime_budget");
    expect(err.message).toContain("as-1");
  });

  it("(d) failNext.caps makes accountCaps fail -> platform_caps_unverified", async () => {
    w.mock.failNext.caps = new ProviderError("Network error", { status: 500 });
    const err = await refusal(createProposal(w.rt(), agent, CREATE(accountId)));
    expect(err.code).toBe("platform_caps_unverified");
    expect(err.message).toContain("Could not verify");
  });

  it("(e) a pause (non-spend kind) is NOT blocked when cap is null", async () => {
    w.mock.accountCapsData["ext-1"] = { spendCapMinor: null, adSets: [] };
    const p = await propose(w, PAUSE("own", accountId, "c1"));
    // No error; pause does not require platform caps
    expect(p.id).toBeTruthy();
  });

  it("(f) create_ad_set with no platform cap -> no_platform_cap", async () => {
    // create_ad_set requires Meta platform; use mock connection to test with mock provider
    const { accountId: metaAccountId } = await syncedAccount(w, { platform: "meta", connectionPlatform: "mock", externalId: "ext-meta" });
    w.mock.accountCapsData["ext-meta"] = { spendCapMinor: null, adSets: [] };
    const err = await refusal(createProposal(w.rt(), agent, CREATE_AD_SET(metaAccountId)));
    expect(err.code).toBe("no_platform_cap");
  });
});
