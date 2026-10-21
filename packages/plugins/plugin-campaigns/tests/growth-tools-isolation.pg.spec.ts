/**
 * Campaigns growth tools, two scopes in one company (Postgres, migration 015
 * tables): a call with scope A neither returns nor writes scope B's rows, and
 * every program is stored on the `campaigns` channel (not Social's).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { parseClientParam, runGrowthTool, type GrowthActor, type GrowthToolName, type GrowthToolsHost } from "@partnersinbiz/pib-plugin-kit";
import { campaignsGrowthEnv, campaignsGrowthHandlers, type CampaignsGrowthEnv } from "../src/growth-host.js";
import { NAMESPACE } from "../src/namespace.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const available = await embeddedAvailable();
const KNOWN = new Set(["company:a", "company:b"]);
const A = "client:company:a";
const B = "client:company:b";
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
  const companyId = `co-${(n += 1)}`;
  const ctx = {
    db: {
      namespace: NAMESPACE,
      query: async (sql: string, params?: unknown[]) => (await pg.client.query(sql, params)).rows,
      execute: async (sql: string, params?: unknown[]) => ({ rowCount: (await pg.client.query(sql, params)).rowCount ?? 0 }),
    },
    logger: { info: () => {}, warn: () => {} },
    events: { emit: vi.fn(async () => {}) },
  } as unknown as PluginContext;
  const env = (): CampaignsGrowthEnv => ({
    ...campaignsGrowthEnv(ctx),
    now: () => new Date("2026-10-21T08:00:00Z"),
    scopes: {
      fromParams: async (_company, params) => {
        const value = typeof params.client === "string" ? params.client : null;
        if (!value) return { scope: null, client: null };
        const scope = parseClientParam(value);
        if (!scope || !KNOWN.has(value)) throw new Error(`Unknown client ${value}`);
        return { scope, client: { name: `Client ${scope.id}` } };
      },
      toParam: (scope) => (scope ? `${scope.kind}:${scope.id}` : "own"),
    },
    issuePort: () => ({ createApproval: async () => ({ id: "issue-1" }), isOpen: async () => true, setStatus: async () => {}, comment: async () => {} }),
    buildApprovalInput: async () => ({}),
  });
  const actor: GrowthActor = { companyId, userId: null, agentId: "agent1", isAgent: true };
  const host: GrowthToolsHost = { kinds: ["own", "client"], actor: async () => actor, handlers: campaignsGrowthHandlers(env) };
  const call = async (name: GrowthToolName, params: Record<string, unknown>): Promise<any> => {
    const result = await runGrowthTool(host, name, params, { companyId, agentId: "agent1", runId: "r1" } as unknown as ToolRunContext);
    if (result.error) throw new Error(result.error);
    return result.data;
  };
  const store = env().store;
  const setup = async () => {
    const ids = { a: (await call("get-playbook", { scope: A })).programId as string, b: (await call("get-playbook", { scope: B })).programId as string };
    for (const id of Object.values(ids)) await store.updateProgram(companyId, id, { autopilot: "full" });
    return ids;
  };
  const proposal = { hypothesis: "A question lifts replies", hypothesisType: "hook:question", variable: "Opening line", arms: [{ key: "control", description: "statement" }, { key: "variant", description: "question" }] };
  return { companyId, call, store, setup, proposal };
}

describe.skipIf(!available)("campaigns growth tools: two-scope isolation", () => {
  it("get-playbook: scopes have their own program on the campaigns channel", async () => {
    const w = world();
    const { a, b } = await w.setup();
    const own = await w.call("get-playbook", { scope: "own" });
    expect(new Set([a, b, own.programId]).size).toBe(3);
    const rows = (await pg.client.query(`SELECT DISTINCT channel FROM ${NAMESPACE}.growth_programs WHERE company_id = $1`, [w.companyId])).rows;
    expect(rows).toEqual([{ channel: "campaigns" }]);
    await w.call("propose-playbook-change", { scope: A, text: "Only for A", section: "rules", reason: "r" });
    expect((await w.call("get-playbook", { scope: A })).pendingChanges).toHaveLength(1);
    expect((await w.call("get-playbook", { scope: B })).pendingChanges).toEqual([]);
    expect((await w.call("get-playbook", { scope: "own" })).pendingChanges).toEqual([]);
  });

  it("an unknown client and a product scope are refused and create no program", async () => {
    const w = world();
    await expect(w.call("get-playbook", { scope: "client:company:ghost" })).rejects.toThrow(/Unknown client/);
    await expect(w.call("get-playbook", { scope: "product:p1" })).rejects.toThrow(/does not run product scopes/);
    const count = (await pg.client.query(`SELECT count(*)::int AS c FROM ${NAMESPACE}.growth_programs WHERE company_id = $1`, [w.companyId])).rows[0] as { c: number };
    expect(count.c).toBe(0);
  });

  it("performance-review: A shows only A's experiments and changes", async () => {
    const w = world();
    const { b } = await w.setup();
    await w.call("propose-playbook-change", { scope: B, text: "B rule", section: "rules", reason: "r" });
    await w.call("propose-experiment", { scope: B, ...w.proposal });
    const reviewA = await w.call("performance-review", { scope: A });
    expect(reviewA.pendingChanges).toEqual([]);
    expect([...reviewA.runningExperiments, ...reviewA.proposedExperiments]).toEqual([]);
    const reviewB = await w.call("performance-review", { scope: B });
    expect(reviewB.program.programId).toBe(b);
    expect(reviewB.pendingChanges).toHaveLength(1);
    expect(reviewB.runningExperiments).toHaveLength(1);
  });

  it("propose, list, approve and decide act on one scope and leave the other alone", async () => {
    const w = world();
    const { a, b } = await w.setup();
    const changeA = await w.call("propose-playbook-change", { scope: A, text: "A rule", section: "rules", reason: "r" });
    const changeB = await w.call("propose-playbook-change", { scope: B, text: "B rule", section: "rules", reason: "r" });
    expect(await w.call("decide-playbook-change", { changeId: changeA.changeId, decision: "keep" })).toMatchObject({ status: "kept" });
    expect(((await w.store.getChange(w.companyId, changeB.changeId)) as any).status).toBe("pending");
    expect(((await w.store.getProgram(w.companyId, b)) as any).playbookVersion).toBe(1);

    const exp = await w.call("propose-experiment", { scope: A, ...w.proposal });
    expect((await w.store.listExperiments(w.companyId, a)).length).toBe(1);
    expect(await w.store.listExperiments(w.companyId, b)).toEqual([]);
    expect((await w.call("list-experiments", { scope: A })).experiments.map((e: any) => e.experimentId)).toContain(exp.experimentId);
    expect((await w.call("list-experiments", { scope: B })).experiments).toEqual([]);
    expect(exp.status).toBe("running");
  });
});
