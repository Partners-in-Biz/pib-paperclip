/**
 * The per-campaign hard cap (PAR-6682), through createProposal and executeProposal on embedded Postgres and the mock platform.
 * c1 has spent 8000 a day on 2026-10-09..14 (48_000 in all); c2 is paused and has spent nothing. No live endpoint is called.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AdsError } from "../src/domain.js";
import { executeProposal } from "../src/execute.js";
import { ProviderError } from "../src/providers/http.js";
import { recordReview, recordSignoff } from "../src/proposals.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";
import { ADS_AGENT, COMPANY, OWNER, REVIEWER, world, type World } from "./helpers/world.js";
import { CHANGE_BUDGET, CREATE, PAUSE, propose, seedCampaignCap, syncedAccount } from "./helpers/scenario.js";
import { table } from "../src/db.js";

const available = await embeddedAvailable();
let pg: Pg;
beforeAll(async () => {
  if (available) pg = await startPg();
}, 120_000);
afterAll(async () => {
  if (available) await pg.stop();
});

const agent = { agentId: ADS_AGENT };
const RESUME = (accountId: string, id = "c2") => ({ kind: "resume_campaign", scopeKey: "own", targets: [{ accountId, campaignExternalId: id }], reason: "Sale starts" });

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AdsError) return error.code;
    throw error;
  }
  return "ran";
}

async function approved(w: World, input: Record<string, unknown>) {
  const p = await propose(w, input);
  await recordReview(w.rt(), { agentId: REVIEWER }, { proposalId: p.id, verdict: "pass" });
  const { approvalId } = await recordSignoff(w.rt(), { proposalId: p.id, userId: OWNER, role: "owner", decision: "approved", overCapAck: false, via: "page" });
  return { id: p.id, approvalId };
}

async function dropCap(w: World, id: string) {
  await w.ctx.db.execute(`DELETE FROM ${table(w.ctx, "campaign_caps")} WHERE company_id = $1 AND external_campaign_id = $2`, [COMPANY, id]);
}

describe.skipIf(!available)("the per-campaign cap", () => {
  let w: World;
  let accountId: string;
  beforeEach(async () => {
    await pg.reset();
    w = await world(pg);
    ({ accountId } = await syncedAccount(w));
  });

  describe("createProposal", () => {
    it("refuses a spend-raising change on a campaign with no cap row", async () => {
      await dropCap(w, "c2");
      expect(await code(propose(w, RESUME(accountId)))).toBe("no_campaign_cap");
      await dropCap(w, "c1");
      expect(await code(propose(w, CHANGE_BUDGET(accountId, "c1", 11_000)))).toBe("no_campaign_cap");
    });

    it("refuses when spend since the row plus what the change adds is over the cap, and allows it at the cap", async () => {
      await seedCampaignCap(w, "mock", "c1", 59_000);
      expect(await code(propose(w, CHANGE_BUDGET(accountId, "c1", 11_001)))).toBe("over_campaign_cap");
      expect(await code(propose(w, CHANGE_BUDGET(accountId, "c1", 11_000)))).toBe("ran");
    });

    it("counts only spend from the row's day on (same-day spend before the row counts)", async () => {
      // Row made late on 2026-10-14: only that day's 8000 is inside the window.
      await seedCampaignCap(w, "mock", "c1", 20_000, "2026-10-14T20:00:00Z");
      expect(await code(propose(w, CHANGE_BUDGET(accountId, "c1", 12_000)))).toBe("ran");
      expect(await code(propose(w, CHANGE_BUDGET(accountId, "c1", 12_001)))).toBe("over_campaign_cap");
    });

    it("refuses when the spend read fails", async () => {
      w.mock.failNext.insights = new ProviderError("Rate limit (HTTP 429)", { retryable: true, status: 429 });
      expect(await code(propose(w, CHANGE_BUDGET(accountId, "c1", 11_000)))).toBe("campaign_spend_unread");
    });

    it("treats an empty insights body as a failed read for a campaign that has spent before", async () => {
      w.mock.insightRows["ext-1"] = [];
      expect(await code(propose(w, CHANGE_BUDGET(accountId, "c1", 11_000)))).toBe("campaign_spend_unread");
      // c2 never spent, so an empty body is a real zero for it.
      expect(await code(propose(w, RESUME(accountId)))).toBe("ran");
    });

    it("always allows a pause, with no cap row and a broken read", async () => {
      await dropCap(w, "c1");
      w.mock.failNext.insights = new ProviderError("down", { status: 500 });
      expect(await code(propose(w, PAUSE("own", accountId, "c1")))).toBe("ran");
    });

    it("a new campaign (created paused) may come without a cap; a cap it carries covers at least one day of its budget", async () => {
      expect(await code(propose(w, CREATE(accountId)))).toBe("ran");
      expect(await code(propose(w, CREATE(accountId, { capMinor: 4999 })))).toBe("over_campaign_cap");
      expect(await code(propose(w, CREATE(accountId, { capMinor: 5000 })))).toBe("ran");
    });
  });

  describe("executeProposal (checked again on a fresh read)", () => {
    it("refuses when the cap row went away after approval", async () => {
      const { id, approvalId } = await approved(w, RESUME(accountId));
      await dropCap(w, "c2");
      expect(await code(executeProposal(w.rt(), agent, { proposalId: id, approvalId }))).toBe("no_campaign_cap");
      expect(w.mock.writes).toEqual([]);
    });

    it("refuses when spend since approval takes it over the cap", async () => {
      await seedCampaignCap(w, "mock", "c1", 60_000);
      const { id, approvalId } = await approved(w, CHANGE_BUDGET(accountId, "c1", 11_000));
      w.mock.insightRows["ext-1"]!.push({ campaignExternalId: "c1", campaignName: "Campaign c1", day: "2026-10-15", spendMinor: 2000, impressions: 1, clicks: 0, conversions: 0, valueMinor: 0 });
      expect(await code(executeProposal(w.rt(), agent, { proposalId: id, approvalId }))).toBe("over_campaign_cap");
      expect(w.mock.writes).toEqual([]);
    });

    it("refuses on a failed read and on an empty body", async () => {
      const first = await approved(w, CHANGE_BUDGET(accountId, "c1", 11_000));
      w.mock.failNext.insights = new ProviderError("down", { status: 500 });
      expect(await code(executeProposal(w.rt(), agent, { proposalId: first.id, approvalId: first.approvalId }))).toBe("campaign_spend_unread");
      const second = await approved(w, CHANGE_BUDGET(accountId, "c1", 12_000));
      w.mock.insightRows["ext-1"] = [];
      expect(await code(executeProposal(w.rt(), agent, { proposalId: second.id, approvalId: second.approvalId }))).toBe("campaign_spend_unread");
      expect(w.mock.writes).toEqual([]);
    });

    it("runs a pause with no cap row, and a capped change inside its cap", async () => {
      await dropCap(w, "c1");
      const pause = await approved(w, PAUSE("own", accountId, "c1"));
      expect(await executeProposal(w.rt(), agent, { proposalId: pause.id, approvalId: pause.approvalId })).toMatchObject({ status: "executed" });
      const resume = await approved(w, RESUME(accountId));
      expect(await executeProposal(w.rt(), agent, { proposalId: resume.id, approvalId: resume.approvalId })).toMatchObject({ status: "executed" });
      expect(w.mock.writes.map((x) => [x.op, x.campaignExternalId])).toEqual([["status", "c1"], ["status", "c2"]]);
    });
  });
});
