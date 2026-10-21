/**
 * SEO growth tools, two scopes in one company (Postgres, migration 024
 * tables): a call with scope A neither returns nor writes scope B's rows, and
 * every program is stored on the `seo` channel (not Social's or Campaigns').
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { parseScopeKey, runGrowthTool, type ClientScope, type GrowthActor, type GrowthToolName, type GrowthToolsHost } from "@partnersinbiz/pib-plugin-kit";
import { seoGrowthEnv, seoGrowthHandlers, seoScopes, type SeoGrowthEnv } from "../src/growth-host.js";
import { NAMESPACE } from "../src/namespace.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const available = await embeddedAvailable();
const KNOWN = new Set(["client:company:a", "client:company:b"]);
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
    issues: { get: async () => null, createComment: vi.fn(async () => {}) },
  } as unknown as PluginContext;

  // Mock CRM resolver: only "company:a" and "company:b" exist
  const mockCrmResolver = async (_ctx: PluginContext, _namespace: string, _companyId: string, scope: ClientScope) => {
    if (!scope) return null;
    const fullScopeKey = `client:${scope.kind}:${scope.id}`;
    if (!KNOWN.has(fullScopeKey)) return null;
    return { name: `Client ${scope.id}` };
  };

  const env = (): SeoGrowthEnv => ({
    ...seoGrowthEnv(ctx),
    now: () => new Date("2026-10-21T08:00:00Z"),
    scopes: seoScopes(ctx, mockCrmResolver),
    issuePort: () => ({ createApproval: async () => ({ id: "issue-1" }), isOpen: async () => true, setStatus: async () => {}, comment: async () => {} }),
  });
  const actor: GrowthActor = { companyId, userId: null, agentId: "agent1", isAgent: true };
  const host: GrowthToolsHost = { kinds: ["own", "client"], actor: async () => actor, handlers: seoGrowthHandlers(() => env()) as unknown as GrowthToolsHost<GrowthActor>["handlers"] };
  const call = async (name: GrowthToolName, params: Record<string, unknown>): Promise<any> => {
    const result = await runGrowthTool(host, name, params, { companyId, agentId: "agent1", runId: "r1" } as unknown as ToolRunContext);
    if (result.error) throw new Error(result.error);
    return result.data;
  };
  const store = env().store;
  return { companyId, call, store };
}

describe.skipIf(!available)("seo growth tools: two-scope isolation", () => {
  it("performance-review: empty when no program exists", async () => {
    const w = world();
    const reviewA = await w.call("performance-review", { scope: A });
    expect(reviewA.program).toBe(null);
    expect(reviewA.runningExperiments).toEqual([]);
    expect(reviewA.proposedExperiments).toEqual([]);
  });

  it("propose-experiment creates programs and experiments on seo channel", async () => {
    const w = world();
    const proposal = { hypothesis: "Test query improves CTR", hypothesisType: "hook:question", variable: "Opening", arms: [{ key: "control", description: "statement" }, { key: "variant", description: "question" }] };
    const expA = await w.call("propose-experiment", { scope: A, ...proposal });
    expect(expA.experimentId).toBeDefined();
    const expRows = (await pg.client.query(`SELECT COUNT(*)::int AS c FROM ${NAMESPACE}.growth_experiments WHERE company_id = $1`, [w.companyId])).rows[0] as { c: number };
    expect(expRows.c).toBe(1);
    const programs = (await pg.client.query(`SELECT DISTINCT channel FROM ${NAMESPACE}.growth_programs WHERE company_id = $1`, [w.companyId])).rows;
    expect(programs).toEqual([{ channel: "seo" }]);
  });

  it("scope A and B resolve to distinct non-null scope keys", async () => {
    const w = world();
    const proposalA = { hypothesis: "Scope key test A", hypothesisType: "hook:question", variable: "KeyTestA", arms: [{ key: "control", description: "control" }, { key: "variant", description: "variant" }] };
    const proposalB = { hypothesis: "Scope key test B", hypothesisType: "hook:comparison", variable: "KeyTestB", arms: [{ key: "control", description: "control" }, { key: "variant", description: "variant" }] };
    const expA = await w.call("propose-experiment", { scope: A, ...proposalA });
    const expB = await w.call("propose-experiment", { scope: B, ...proposalB });
    // Both experiments should reference different programs (different scope keys)
    const expARow = (await pg.client.query(
      `SELECT program_id FROM ${NAMESPACE}.growth_experiments WHERE id = $1`,
      [expA.experimentId],
    )).rows[0] as { program_id: string };
    const expBRow = (await pg.client.query(
      `SELECT program_id FROM ${NAMESPACE}.growth_experiments WHERE id = $1`,
      [expB.experimentId],
    )).rows[0] as { program_id: string };
    // The program IDs must be different (different scope keys)
    expect(expARow.program_id).not.toBe(expBRow.program_id);
    // And both must be non-"own" (not ${companyId}:seo:own)
    expect(expARow.program_id).not.toBe(`${w.companyId}:seo:own`);
    expect(expBRow.program_id).not.toBe(`${w.companyId}:seo:own`);
  });

  it("list-experiments returns proposed experiments", async () => {
    const w = world();
    const proposal = { hypothesis: "Test query improves CTR", hypothesisType: "hook:question", variable: "Opening", arms: [{ key: "control", description: "statement" }, { key: "variant", description: "question" }] };
    const exp = await w.call("propose-experiment", { scope: A, ...proposal });
    const list = await w.call("list-experiments", { scope: A });
    expect(list.experiments).toHaveLength(1);
    expect(list.experiments[0].experimentId).toBe(exp.experimentId);
  });

  it("performance-review with scope B does not include scope A's program/experiments", async () => {
    const w = world();
    const proposal = { hypothesis: "Test query improves CTR", hypothesisType: "hook:question", variable: "Opening", arms: [{ key: "control", description: "control" }, { key: "variant", description: "variant" }] };
    const expA = await w.call("propose-experiment", { scope: A, ...proposal });
    const reviewB = await w.call("performance-review", { scope: B });
    expect(reviewB.program).toBe(null);
    expect(reviewB.runningExperiments).toEqual([]);
    expect(reviewB.proposedExperiments).toEqual([]);
  });

  it("list-experiments returns only the calling scope's experiments", async () => {
    const w = world();
    const proposalA = { hypothesis: "CTR hypothesis A scope test", hypothesisType: "hook:question", variable: "OpeningA", arms: [{ key: "control", description: "control" }, { key: "variant", description: "variant" }] };
    const proposalB = { hypothesis: "CTR hypothesis B scope test", hypothesisType: "hook:comparison", variable: "OpeningB", arms: [{ key: "control", description: "control" }, { key: "variant", description: "variant" }] };
    const expA = await w.call("propose-experiment", { scope: A, ...proposalA });
    const expB = await w.call("propose-experiment", { scope: B, ...proposalB });
    const listA = await w.call("list-experiments", { scope: A });
    const listB = await w.call("list-experiments", { scope: B });
    expect(listA.experiments.length).toBeGreaterThanOrEqual(1);
    expect(listB.experiments.length).toBeGreaterThanOrEqual(1);
    const expAIds = listA.experiments.map((e: any) => e.experimentId);
    const expBIds = listB.experiments.map((e: any) => e.experimentId);
    // Positive assertions: each list contains its own experiment
    expect(expAIds).toContain(expA.experimentId);
    expect(expBIds).toContain(expB.experimentId);
    // Negative assertions: each list must NOT contain the other scope's experiment
    expect(expAIds).not.toContain(expB.experimentId);
    expect(expBIds).not.toContain(expA.experimentId);
  });

  it("performance-review with both scopes seeded returns only the calling scope's experiments", async () => {
    const w = world();
    const proposalA = { hypothesis: "Review isolation A", hypothesisType: "hook:question", variable: "VarA", arms: [{ key: "control", description: "control" }, { key: "variant", description: "variant" }] };
    const proposalB = { hypothesis: "Review isolation B", hypothesisType: "hook:comparison", variable: "VarB", arms: [{ key: "control", description: "control" }, { key: "variant", description: "variant" }] };
    const expA = await w.call("propose-experiment", { scope: A, ...proposalA });
    const expB = await w.call("propose-experiment", { scope: B, ...proposalB });
    const reviewA = await w.call("performance-review", { scope: A });
    const reviewB = await w.call("performance-review", { scope: B });
    // A's review should not include B's experiment (both proposed in same world)
    const expAIdFromReviewA = reviewA.proposedExperiments.map((e: any) => e.experimentId);
    const expBIdFromReviewB = reviewB.proposedExperiments.map((e: any) => e.experimentId);
    expect(expAIdFromReviewA).not.toContain(expB.experimentId);
    expect(expBIdFromReviewB).not.toContain(expA.experimentId);
  });

  it("propose-experiment writes one program per scope", async () => {
    const w = world();
    const proposalA = { hypothesis: "Program isolation A", hypothesisType: "hook:question", variable: "ProgramVarA", arms: [{ key: "control", description: "control" }, { key: "variant", description: "variant" }] };
    const proposalB = { hypothesis: "Program isolation B", hypothesisType: "hook:comparison", variable: "ProgramVarB", arms: [{ key: "control", description: "control" }, { key: "variant", description: "variant" }] };
    const expA = await w.call("propose-experiment", { scope: A, ...proposalA });
    const expB = await w.call("propose-experiment", { scope: B, ...proposalB });
    // Query the growth_programs table directly
    const programs = (await pg.client.query(
      `SELECT id, scope_key FROM ${NAMESPACE}.growth_programs WHERE company_id = $1 ORDER BY id`,
      [w.companyId],
    )).rows as { id: string; scope_key: string }[];
    // Should have exactly 2 programs with distinct ids
    expect(programs).toHaveLength(2);
    const programIds = programs.map((p) => p.id);
    expect(new Set(programIds).size).toBe(2); // All unique
    // Each program should have the expected scope key
    const expectedScopeKeyA = "client:company:a";
    const expectedScopeKeyB = "client:company:b";
    // Verify scope keys are distinct
    const scopeKeys = programs.map((p) => p.scope_key);
    expect(new Set(scopeKeys).size).toBe(2); // All unique
    expect(scopeKeys).toContain(expectedScopeKeyA);
    expect(scopeKeys).toContain(expectedScopeKeyB);
    // Each experiment should reference its own program (different from the other)
    const expARow = (await pg.client.query(
      `SELECT program_id FROM ${NAMESPACE}.growth_experiments WHERE id = $1`,
      [expA.experimentId],
    )).rows[0] as { program_id: string };
    const expBRow = (await pg.client.query(
      `SELECT program_id FROM ${NAMESPACE}.growth_experiments WHERE id = $1`,
      [expB.experimentId],
    )).rows[0] as { program_id: string };
    // Experiments should reference different programs
    expect(expARow.program_id).not.toBe(expBRow.program_id);
    // Each experiment's program should match one of the created programs
    expect(programIds).toContain(expARow.program_id);
    expect(programIds).toContain(expBRow.program_id);
  });

  it("wrong-scope string is rejected", async () => {
    const w = world();
    let errorThrown = false;
    try {
      await w.call("propose-experiment", { scope: "client:company:zzz", hypothesis: "Bad scope", hypothesisType: "hook:question", variable: "BadVar", arms: [{ key: "control", description: "control" }, { key: "variant", description: "variant" }] });
    } catch {
      errorThrown = true;
    }
    expect(errorThrown).toBe(true);
    // Verify no rows were written
    const expRows = (await pg.client.query(`SELECT COUNT(*)::int AS c FROM ${NAMESPACE}.growth_experiments WHERE company_id = $1`, [w.companyId])).rows[0] as { c: number };
    expect(expRows.c).toBe(0);
  });

  it("approve-experiment rejects scope B on scope A's experiment", async () => {
    const w = world();
    const proposalA = { hypothesis: "Approve scope test A", hypothesisType: "hook:question", variable: "VarApprovalA", arms: [{ key: "control", description: "control" }, { key: "variant", description: "variant" }] };
    const expA = await w.call("propose-experiment", { scope: A, ...proposalA });
    await expect(w.call("approve-experiment", { scope: B, experimentId: expA.experimentId })).rejects.toThrow();
  });

  it("approve-experiment with scope B and A's experiment id must error and leave A's row as proposed", async () => {
    const w = world();
    const proposalA = { hypothesis: "Approval test A", hypothesisType: "hook:question", variable: "VarApprovalA", arms: [{ key: "control", description: "control" }, { key: "variant", description: "variant" }] };
    const expA = await w.call("propose-experiment", { scope: A, ...proposalA });
    await expect(w.call("approve-experiment", { scope: B, experimentId: expA.experimentId })).rejects.toThrow();
    const expRow = (await pg.client.query(
      `SELECT status FROM ${NAMESPACE}.growth_experiments WHERE id = $1`,
      [expA.experimentId],
    )).rows[0] as { status: string };
    expect(expRow.status).toBe("proposed");
  });

  it("approve-experiment happy path in scope A with full autopilot changes status", async () => {
    const w = world();
    const proposalA = { hypothesis: "Approve test", hypothesisType: "hook:question", variable: "VarApproveA", arms: [{ key: "control", description: "control" }, { key: "variant", description: "variant" }] };
    const expA = await w.call("propose-experiment", { scope: A, ...proposalA });
    const progRow = (await pg.client.query(
      `SELECT id FROM ${NAMESPACE}.growth_programs WHERE company_id = $1 AND id = (SELECT program_id FROM ${NAMESPACE}.growth_experiments WHERE id = $2)`,
      [w.companyId, expA.experimentId],
    )).rows[0] as { id: string };
    await pg.client.query(
      `UPDATE ${NAMESPACE}.growth_programs SET autopilot = $1 WHERE id = $2`,
      ["full", progRow.id],
    );
    const approved = await w.call("approve-experiment", { scope: A, experimentId: expA.experimentId });
    expect(approved.experimentId).toBe(expA.experimentId);
    const expRow = (await pg.client.query(
      `SELECT status FROM ${NAMESPACE}.growth_experiments WHERE id = $1`,
      [expA.experimentId],
    )).rows[0] as { status: string };
    expect(["approved", "running"]).toContain(expRow.status);
  });

  it("approve-experiment happy path leaves scope B's experiment untouched", async () => {
    const w = world();
    const proposalA = { hypothesis: "Isolation test A", hypothesisType: "hook:question", variable: "VarIsoA", arms: [{ key: "control", description: "control" }, { key: "variant", description: "variant" }] };
    const proposalB = { hypothesis: "Isolation test B", hypothesisType: "hook:comparison", variable: "VarIsoB", arms: [{ key: "control", description: "control" }, { key: "variant", description: "variant" }] };
    const expA = await w.call("propose-experiment", { scope: A, ...proposalA });
    const expB = await w.call("propose-experiment", { scope: B, ...proposalB });
    const progRowA = (await pg.client.query(
      `SELECT id FROM ${NAMESPACE}.growth_programs WHERE company_id = $1 AND id = (SELECT program_id FROM ${NAMESPACE}.growth_experiments WHERE id = $2)`,
      [w.companyId, expA.experimentId],
    )).rows[0] as { id: string };
    await pg.client.query(
      `UPDATE ${NAMESPACE}.growth_programs SET autopilot = $1 WHERE id = $2`,
      ["full", progRowA.id],
    );
    await w.call("approve-experiment", { scope: A, experimentId: expA.experimentId });
    const expBRow = (await pg.client.query(
      `SELECT status FROM ${NAMESPACE}.growth_experiments WHERE id = $1`,
      [expB.experimentId],
    )).rows[0] as { status: string };
    expect(expBRow.status).toBe("proposed");
  });

  it("reject-experiment with scope B and A's experiment id must error and leave A's row as proposed", async () => {
    const w = world();
    const proposalA = { hypothesis: "Reject test A", hypothesisType: "hook:question", variable: "VarRejectA", arms: [{ key: "control", description: "control" }, { key: "variant", description: "variant" }] };
    const expA = await w.call("propose-experiment", { scope: A, ...proposalA });
    await expect(w.call("reject-experiment", { scope: B, experimentId: expA.experimentId })).rejects.toThrow();
    const expRow = (await pg.client.query(
      `SELECT status FROM ${NAMESPACE}.growth_experiments WHERE id = $1`,
      [expA.experimentId],
    )).rows[0] as { status: string };
    expect(expRow.status).toBe("proposed");
  });

  it("reject-experiment with scope B does not affect scope A", async () => {
    const w = world();
    const proposalA = { hypothesis: "Reject test A", hypothesisType: "hook:question", variable: "VarRejectA", arms: [{ key: "control", description: "control" }, { key: "variant", description: "variant" }] };
    const proposalB = { hypothesis: "Reject test B", hypothesisType: "hook:comparison", variable: "VarRejectB", arms: [{ key: "control", description: "control" }, { key: "variant", description: "variant" }] };
    const expA = await w.call("propose-experiment", { scope: A, ...proposalA });
    const expB = await w.call("propose-experiment", { scope: B, ...proposalB });
    await expect(w.call("reject-experiment", { scope: B, experimentId: expA.experimentId, reason: "Wrong scope" })).rejects.toThrow();
    const listA = await w.call("list-experiments", { scope: A });
    const stillFound = listA.experiments.some((e: any) => e.experimentId === expA.experimentId);
    expect(stillFound).toBe(true);
  });
});
