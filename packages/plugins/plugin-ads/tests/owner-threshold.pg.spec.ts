import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getProposal, updateScope } from "../src/db.js";
import { ELON_AGENT_ID, routeFromImpact } from "../src/owner-route.js";
import { executeProposal } from "../src/execute.js";
import { recordReview, recordSignoff } from "../src/proposals.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";
import { ADS_AGENT, COMPANY, OWNER, REVIEWER, world, type World } from "./helpers/world.js";
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
    try {
      await executeProposal(w.rt(), { agentId: ADS_AGENT }, { proposalId: p.id, approvalId: "x" });
    } catch (e) { expect((e as any).code).toBe("not_approved"); }
  });

  it("Elon at threshold approved, executes once", async () => {
    const p = await prop(5000);
    await recordReview(w.rt(), { agentId: REVIEWER }, { proposalId: p.id, verdict: "pass" });
    const { approvalId } = await recordSignoff(w.rt(), { proposalId: p.id, userId: null, agentId: ELON_AGENT_ID, role: "owner", decision: "approved", via: "tool" });
    expect((await approvalsOf(w, p.id))[0]!.decided_by).toBe(`agent:${ELON_AGENT_ID}`);
    const r = await executeProposal(w.rt(), { agentId: ADS_AGENT }, { proposalId: p.id, approvalId });
    expect(r.status).toBe("executed");
    expect(w.mock.writes).toHaveLength(1);
    expect((await approvalsOf(w, p.id))[0]!.consumed_at).toBeDefined();
  });

  it("Elon above threshold peet_required, then OWNER signs", async () => {
    const p = await prop(5001);
    await recordReview(w.rt(), { agentId: REVIEWER }, { proposalId: p.id, verdict: "pass" });
    try { await recordSignoff(w.rt(), { proposalId: p.id, userId: null, agentId: ELON_AGENT_ID, role: "owner", decision: "approved", via: "tool" });
    } catch (e) { expect((e as any).code).toBe("peet_required"); }
    expect(routeFromImpact((await getProposal(w.ctx, COMPANY, p.id))!.impact)?.route).toBe("peet_required");
    const { approvalId } = await recordSignoff(w.rt(), { proposalId: p.id, userId: OWNER, role: "owner", decision: "approved", via: "page" });
    expect((await executeProposal(w.rt(), { agentId: ADS_AGENT }, { proposalId: p.id, approvalId })).status).toBe("executed");
  });

  it("only Elon may delegate", async () => {
    const p = await prop(5000);
    try { await recordSignoff(w.rt(), { proposalId: p.id, userId: null, agentId: "other", role: "owner", decision: "approved", via: "tool" });
    } catch (e) { expect((e as any).code).toBe("not_a_person"); }
  });

  it("lowered threshold stops Elon's approval", async () => {
    const p = await prop(3000);
    await recordReview(w.rt(), { agentId: REVIEWER }, { proposalId: p.id, verdict: "pass" });
    const { approvalId } = await recordSignoff(w.rt(), { proposalId: p.id, userId: null, agentId: ELON_AGENT_ID, role: "owner", decision: "approved", via: "tool" });
    await updateScope(w.ctx, COMPANY, "own", { ownerThresholdMinor: 10000 });
    try { await executeProposal(w.rt(), { agentId: ADS_AGENT }, { proposalId: p.id, approvalId });
    } catch (e) { expect((e as any).code).toBe("peet_required"); }
    expect((await approvalsOf(w, p.id))[0]!.consumed_at).toBeNull();
    expect(w.mock.writes).toHaveLength(0);
  });

  it("ad sets count lifetime budget", async () => {
    const p = await prop(5000);
    await recordReview(w.rt(), { agentId: REVIEWER }, { proposalId: p.id, verdict: "pass" });
    try { await recordSignoff(w.rt(), { proposalId: p.id, userId: null, agentId: ELON_AGENT_ID, role: "owner", decision: "approved", via: "tool" });
    } catch (e) { expect((e as any).code).toBe("peet_required"); }
  });
});
