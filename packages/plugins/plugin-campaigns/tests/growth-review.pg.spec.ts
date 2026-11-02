/**
 * The Weekly review tab's actions (Postgres, migration 015 tables): with autopilot
 * `safe` an agent cannot approve, a signed-in person can, and the approval issue is
 * commented on and closed once everything on it is decided.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PluginContext, PluginPerformActionContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { runGrowthTool, type GrowthActor, type GrowthToolName, type GrowthToolsHost } from "@partnersinbiz/pib-plugin-kit";
import { campaignsGrowthEnv, campaignsGrowthHandlers, type CampaignsGrowthEnv } from "../src/growth-host.js";
import { growthApproveExperiment, growthDecideChange, growthRejectExperiment, growthReviewLoad } from "../src/growth-review.js";
import { NAMESPACE } from "../src/namespace.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const available = await embeddedAvailable();
let pg: PgHarness;
let n = 0;

beforeAll(async () => {
  if (!available) return;
  pg = await startPg();
}, 120_000);
afterAll(async () => {
  if (available) await pg.stop();
});

function world() {
  const companyId = `co-review-${(n += 1)}`;
  const comments: string[] = [];
  const updates: Array<Record<string, unknown>> = [];
  const ctx = {
    db: {
      namespace: NAMESPACE,
      query: async (sql: string, params?: unknown[]) => (await pg.client.query(sql, params)).rows,
      execute: async (sql: string, params?: unknown[]) => ({ rowCount: (await pg.client.query(sql, params)).rowCount ?? 0 }),
    },
    logger: { info: () => {}, warn: () => {} },
    events: { emit: vi.fn(async () => {}) },
    issues: {
      get: async () => ({ status: "in_review" }),
      update: async (_id: string, patch: Record<string, unknown>) => void updates.push(patch),
      createComment: async (_id: string, body: string) => void comments.push(body),
    },
  } as unknown as PluginContext;
  // Agent side (proposing) runs on a fixed approval issue; the review actions use the real env on `ctx`.
  const agentEnv = (): CampaignsGrowthEnv => ({
    ...campaignsGrowthEnv(ctx),
    issuePort: () => ({ createApproval: async () => ({ id: "issue-1" }), isOpen: async () => true, setStatus: async () => {}, comment: async () => {} }),
    buildApprovalInput: async () => ({}),
  });
  const agent: GrowthActor = { companyId, userId: null, agentId: "agent1", isAgent: true };
  const host: GrowthToolsHost = { kinds: ["own", "client"], actor: async () => agent, handlers: campaignsGrowthHandlers(agentEnv) };
  const call = async (name: GrowthToolName, params: Record<string, unknown>): Promise<any> => {
    const result = await runGrowthTool(host, name, params, { companyId, agentId: "agent1", runId: "r1" } as unknown as ToolRunContext);
    if (result.error) throw new Error(result.error);
    return result.data;
  };
  const person = (userId: string | null): PluginPerformActionContext =>
    ({ companyId, actor: userId ? { type: "user", userId } : { type: "agent", agentId: "agent1" } }) as unknown as PluginPerformActionContext;
  const proposal = {
    hypothesis: "A question hook beats a bold claim",
    hypothesisType: "hook:question",
    variable: "Opening line",
    arms: [{ key: "control", description: "bold claim" }, { key: "variant", description: "question" }],
  };
  return { companyId, ctx, call, person, proposal, comments, updates };
}

describe.skipIf(!available)("campaigns weekly review actions", () => {
  it("lists a proposed experiment and a pending change; a person approves the experiment", async () => {
    const w = world();
    const exp = await w.call("propose-experiment", w.proposal);
    expect(exp.status).toBe("proposed");
    await w.call("propose-playbook-change", { text: "Lead with a question", section: "rules", reason: "r" });

    const view = await growthReviewLoad(w.ctx, w.person("user-1"), {});
    expect(view.autopilot).toBe("safe");
    expect(view.experiments.map((e: any) => [e.experimentId, e.status])).toEqual([[exp.experimentId, "proposed"]]);
    expect(view.changes).toHaveLength(1);

    const approved = await growthApproveExperiment(w.ctx, w.person("user-1"), { experimentId: exp.experimentId });
    expect(approved).toMatchObject({ experimentId: exp.experimentId, status: "running" });
    expect(w.comments.some((c) => c.startsWith("Approved by"))).toBe(true);
    expect((await growthReviewLoad(w.ctx, w.person("user-1"), {})).experiments[0].status).toBe("running");
  });

  it("refuses an agent or an unsigned call, and an agent still cannot approve on safe autopilot", async () => {
    const w = world();
    const exp = await w.call("propose-experiment", w.proposal);
    await expect(growthApproveExperiment(w.ctx, w.person(null), { experimentId: exp.experimentId })).rejects.toThrow(/Sign in as a person/);
    await expect(w.call("approve-experiment", { experimentId: exp.experimentId })).rejects.toThrow(/Only a person approves/);
    expect((await growthReviewLoad(w.ctx, w.person("user-1"), {})).experiments[0].status).toBe("proposed");
  });

  it("the agent reject-experiment tool no longer fails on a Campaigns store (full autopilot)", async () => {
    const w = world();
    const exp = await w.call("propose-experiment", w.proposal);
    const program = (await w.call("get-playbook", {})).programId as string;
    await pg.client.query(`UPDATE ${NAMESPACE}.growth_programs SET autopilot = 'full' WHERE id = $1`, [program]);
    expect(await w.call("reject-experiment", { experimentId: exp.experimentId, reason: "Not now" })).toMatchObject({ status: "rejected" });
  });

  it("another company's person cannot approve, reject or decide it", async () => {
    const w = world();
    const other = world();
    const exp = await w.call("propose-experiment", w.proposal);
    const change = await w.call("propose-playbook-change", { text: "Rule", section: "rules", reason: "r" });
    await expect(growthApproveExperiment(other.ctx, other.person("user-2"), { experimentId: exp.experimentId })).rejects.toThrow();
    await expect(growthRejectExperiment(other.ctx, other.person("user-2"), { experimentId: exp.experimentId, reason: "x" })).rejects.toThrow();
    await expect(growthDecideChange(other.ctx, other.person("user-2"), { changeId: change.changeId, decision: "keep" })).rejects.toThrow();
    expect((await growthReviewLoad(w.ctx, w.person("user-1"), {})).experiments[0].status).toBe("proposed");
  });

  it("a person rejects an experiment with a reason, and keeps or discards a playbook change", async () => {
    const w = world();
    const exp = await w.call("propose-experiment", w.proposal);
    const keep = await w.call("propose-playbook-change", { text: "Rule one", section: "rules", reason: "r" });
    const drop = await w.call("propose-playbook-change", { text: "Rule two", section: "rules", reason: "r" });

    await expect(growthRejectExperiment(w.ctx, w.person("user-1"), { experimentId: exp.experimentId })).rejects.toThrow();
    await pg.client.query(`INSERT INTO ${NAMESPACE}.growth_experiment_items (experiment_id, arm, subject_kind, subject_id) VALUES ($1, 'link', 'campaign_link', 'camp-1')`, [exp.experimentId]);
    expect(await growthRejectExperiment(w.ctx, w.person("user-1"), { experimentId: exp.experimentId, reason: "Too close to last week" })).toMatchObject({ status: "rejected" });
    const links = await pg.client.query(`SELECT 1 FROM ${NAMESPACE}.growth_experiment_items WHERE experiment_id = $1`, [exp.experimentId]);
    expect(links.rows).toHaveLength(0);
    expect(await growthDecideChange(w.ctx, w.person("user-1"), { changeId: keep.changeId, decision: "keep" })).toMatchObject({ status: "kept" });
    expect(await growthDecideChange(w.ctx, w.person("user-1"), { changeId: drop.changeId, decision: "discard" })).toMatchObject({ status: "discarded" });

    const view = await growthReviewLoad(w.ctx, w.person("user-1"), {});
    expect(view.changes).toEqual([]);
    expect(w.updates.some((u) => u.status === "done")).toBe(true);
  });
});
