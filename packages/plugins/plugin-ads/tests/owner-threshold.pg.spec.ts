import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getProposal, updateScope } from "../src/db.js";
import { routeFromImpact } from "../src/owner-route.js";
import { executeProposal } from "../src/execute.js";
import { recordReview, recordSignoff } from "../src/proposals.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";
import { ADS_AGENT, AM_AGENT, COMPANY, OWNER, REVIEWER, world, type World } from "./helpers/world.js";
import { approvalsOf, propose, syncedAccount } from "./helpers/scenario.js";

const available = await embeddedAvailable();
let pg: Pg;
beforeAll(async () => { if (available) pg = await startPg(); }, 120_000);
afterAll(async () => { if (available) await pg.stop(); });

describe.skipIf(!available)("owner threshold", () => {
  let w: World, accountId: string;
  beforeEach(async () => { await pg.reset(); w = await world(pg); ({ accountId } = await syncedAccount(w)); });

  async function prop(daily: number) {
    return propose(w, { kind: "create_campaign", scopeKey: "own", accountId, name: "Campaign", objective: "OUTCOME_LEADS",
      dailyBudgetMinor: daily, startDate: "2026-10-20", endDate: "2026-10-29", reason: "Test" });
  }

  it("unsigned proposal rejected", async () => {
    const p = await prop(5000);
    await expect(
      executeProposal(w.rt(), { agentId: ADS_AGENT }, { proposalId: p.id, approvalId: "x" })
    ).rejects.toMatchObject({ code: "not_approved" });
  });

  it("execution refused without an approved proposal (reviewed but not signed)", async () => {
    const p = await prop(5000);
    await recordReview(w.rt(), { agentId: REVIEWER }, { proposalId: p.id, verdict: "pass" });
    // Proposal is reviewed but has no owner sign-off
    await expect(
      executeProposal(w.rt(), { agentId: ADS_AGENT }, { proposalId: p.id, approvalId: "x" })
    ).rejects.toMatchObject({ code: "not_approved" });
    expect(w.mock.writes).toHaveLength(0);
  });

  it("Account Manager at threshold approved, executes once", async () => {
    const p = await prop(5000);
    await recordReview(w.rt(), { agentId: REVIEWER }, { proposalId: p.id, verdict: "pass" });
    const { approvalId } = await recordSignoff(w.rt(), { proposalId: p.id, userId: null, agentId: AM_AGENT, role: "owner", decision: "approved", via: "tool" });
    expect((await approvalsOf(w, p.id))[0]!.decided_by).toBe(`agent:${AM_AGENT}`);
    const r = await executeProposal(w.rt(), { agentId: ADS_AGENT }, { proposalId: p.id, approvalId });
    expect(r.status).toBe("executed");
    expect(w.mock.writes).toHaveLength(1);
    expect((await approvalsOf(w, p.id))[0]!.consumed_at).not.toBeNull();
    // Second call with same approval must be rejected (proposal is now executed, not approved)
    await expect(
      executeProposal(w.rt(), { agentId: ADS_AGENT }, { proposalId: p.id, approvalId })
    ).rejects.toMatchObject({ code: "not_approved" });
    expect(w.mock.writes).toHaveLength(1);
  });

  it("Account Manager above threshold owner_required, then OWNER signs", async () => {
    const p = await prop(5001);
    await recordReview(w.rt(), { agentId: REVIEWER }, { proposalId: p.id, verdict: "pass" });
    await expect(
      recordSignoff(w.rt(), { proposalId: p.id, userId: null, agentId: AM_AGENT, role: "owner", decision: "approved", via: "tool" })
    ).rejects.toMatchObject({ code: "owner_required" });
    expect(routeFromImpact((await getProposal(w.ctx, COMPANY, p.id))!.impact)?.route).toBe("owner_required");
    const { approvalId } = await recordSignoff(w.rt(), { proposalId: p.id, userId: OWNER, role: "owner", decision: "approved", via: "page" });
    expect((await executeProposal(w.rt(), { agentId: ADS_AGENT }, { proposalId: p.id, approvalId })).status).toBe("executed");
  });

  it("only the Account Manager may delegate", async () => {
    const p = await prop(5000);
    await expect(
      recordSignoff(w.rt(), { proposalId: p.id, userId: null, agentId: "other", role: "owner", decision: "approved", via: "tool" })
    ).rejects.toMatchObject({ code: "not_a_person" });
  });

  it("lowered threshold stops the Account Manager's approval", async () => {
    const p = await prop(3000);
    await recordReview(w.rt(), { agentId: REVIEWER }, { proposalId: p.id, verdict: "pass" });
    const { approvalId } = await recordSignoff(w.rt(), { proposalId: p.id, userId: null, agentId: AM_AGENT, role: "owner", decision: "approved", via: "tool" });
    await updateScope(w.ctx, COMPANY, "own", { ownerThresholdMinor: 10000 });
    await expect(
      executeProposal(w.rt(), { agentId: ADS_AGENT }, { proposalId: p.id, approvalId })
    ).rejects.toMatchObject({ code: "owner_required" });
    expect((await approvalsOf(w, p.id))[0]!.consumed_at).toBeNull();
    expect(w.mock.writes).toHaveLength(0);
  });

  it("the delegate's approval stops covering the change once the agent is no longer the Account Manager", async () => {
    const p = await prop(3000);
    await recordReview(w.rt(), { agentId: REVIEWER }, { proposalId: p.id, verdict: "pass" });
    const { approvalId } = await recordSignoff(w.rt(), { proposalId: p.id, userId: null, agentId: AM_AGENT, role: "owner", decision: "approved", via: "tool" });
    await w.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, namespace: "pib-cockpit", stateKey: "roles" },
      { companyId: COMPANY, operatorAgentId: null, reviewerAgentId: null, reviewOutward: false, ownerUserId: OWNER, team: {}, updatedAt: "2026-10-15T10:00:00Z", receivedAt: "2026-10-15T10:00:00Z" },
    );
    await expect(
      executeProposal(w.rt(), { agentId: ADS_AGENT }, { proposalId: p.id, approvalId })
    ).rejects.toMatchObject({ code: "bad_approval" });
    expect(w.mock.writes).toHaveLength(0);
  });

  it.todo("ad sets count toward the lifetime budget (ad-set payload support not yet implemented)");
});
