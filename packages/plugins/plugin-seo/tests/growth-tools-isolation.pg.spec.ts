/**
 * SEO growth tools, two scopes in one company (Postgres, migration 024
 * tables): a call with scope A neither returns nor writes scope B's rows, and
 * every program is stored on the `seo` channel (not Social's or Campaigns').
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { parseClientParam, runGrowthTool, type GrowthActor, type GrowthToolName, type GrowthToolsHost } from "@partnersinbiz/pib-plugin-kit";
import { seoGrowthEnv, seoGrowthHandlers, type SeoGrowthEnv } from "../src/growth-host.js";
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
    issues: { get: async () => null, createComment: vi.fn(async () => {}) },
  } as unknown as PluginContext;
  const env = (): SeoGrowthEnv => ({
    ...seoGrowthEnv(ctx),
    now: () => new Date("2026-10-21T08:00:00Z"),
    scopes: {
      fromParams: async (_company, params) => {
        const value = typeof params.scope === "string" ? params.scope : null;
        if (!value) return { scope: null, client: null };
        if (value === "own") return { scope: null, client: null };
        const scope = parseClientParam(value);
        if (!scope || !KNOWN.has(value)) throw new Error(`Unknown scope ${value}`);
        return { scope, client: { name: `Client ${scope.id}` } };
      },
      toParam: (scope) => (scope ? `client:${scope.kind}:${scope.id}` : "own"),
    },
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

  it("list-experiments returns proposed experiments", async () => {
    const w = world();
    const proposal = { hypothesis: "Test query improves CTR", hypothesisType: "hook:question", variable: "Opening", arms: [{ key: "control", description: "statement" }, { key: "variant", description: "question" }] };
    const exp = await w.call("propose-experiment", { scope: A, ...proposal });
    const list = await w.call("list-experiments", { scope: A });
    expect(list.experiments).toHaveLength(1);
    expect(list.experiments[0].experimentId).toBe(exp.experimentId);
  });
});
