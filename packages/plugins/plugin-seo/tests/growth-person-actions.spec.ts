/**
 * Person actions for growth experiments (PAR-10100) on a real Postgres with the 024 growth tables.
 * The handlers are called directly (the worker wraps them in requireUser); the agent-refusal test goes through the worker.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

vi.mock("@partnersinbiz/pib-plugin-kit", async (importOriginal) => {
  const original = await importOriginal<typeof import("@partnersinbiz/pib-plugin-kit")>();
  return { ...original, resolveCrmClient: async (_c: unknown, _n: string, _co: string, scope: { id: string }) => ({ name: `Client ${scope.id}` }) };
});

import { growthAbandon, growthApprove, growthExperiments, growthReject } from "../src/growth-actions.js";
import { seoGrowthEnv } from "../src/growth-host.js";
import { insertSprint } from "../src/db.js";
import { createEnv } from "../src/service/common.js";
import { NAMESPACE } from "../src/namespace.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const available = await embeddedAvailable();
let pg: PgHarness;
let n = 0;
const user = { userId: "user-1" };
const arms = [{ key: "control", description: "a" }, { key: "variant", description: "b" }];

beforeAll(async () => {
  if (available) pg = await startPg();
}, 120_000);
afterAll(async () => {
  if (available) await pg.stop();
});

function world(moduleOff = false) {
  const companyId = `co-${(n += 1)}`;
  const ctx = {
    ...pg.ctx,
    state: { get: async () => (moduleOff ? { modules: { seo: false } } : null) },
    events: { emit: async () => {} },
    issues: { get: async () => null, createComment: async () => {} },
  } as unknown as PluginContext;
  const e = createEnv(ctx);
  const sprint = (id: string, clientRef: string | null, clientName: string | null) =>
    insertSprint(ctx.db as never, { id: `${companyId}-${id}`, companyId, name: id, siteUrl: "https://x.co", siteName: id, clientKind: clientRef ? "company" : null, clientRef, clientName, status: "active", startDate: "2026-09-01", templateId: "outrank-90-professional", templateVersion: 5, autopilotMode: "safe", ownerUserId: null, notes: null });
  const genv = seoGrowthEnv(ctx, companyId);
  const seed = async (client: string | null, status: string, hypothesis = "h") => {
    const program = await (await import("@partnersinbiz/pib-plugin-kit")).programForParams(genv, { companyId, userId: "u", agentId: null, isAgent: false }, { client });
    const id = `${companyId}-x${(n += 1)}`;
    await genv.store.insertExperiment({ id, companyId, programId: program.id, hypothesis, hypothesisType: `t${n}`, variable: "v", arms, metric: program.metric, minPerArm: 20, windowDays: 14, status, proposedBy: "agent" } as never);
    return id;
  };
  const status = async (id: string) => ((await pg.client.query(`SELECT status FROM ${NAMESPACE}.growth_experiments WHERE id = $1`, [id])).rows[0] as { status: string } | undefined)?.status;
  const programs = async () => ((await pg.client.query(`SELECT COUNT(*)::int AS c FROM ${NAMESPACE}.growth_programs WHERE company_id = $1`, [companyId])).rows[0] as { c: number }).c;
  return { companyId, e, sprint, seed, status, programs };
}

describe.skipIf(!available)("growth person actions", () => {
  it("lists by scope: own, client, unlinked", async () => {
    const w = world();
    await w.sprint("own", null, null);
    await w.sprint("cl", "crm-1", "Acme");
    await w.sprint("old", null, "Legacy Co");
    const own = await w.seed(null, "proposed");
    const cl = await w.seed("company:crm-1", "proposed");
    const a = await growthExperiments(w.e, w.companyId, user, { sprintId: `${w.companyId}-own` });
    expect(a.scope).toBe("own");
    expect(a.experiments.map((x: any) => x.experimentId)).toEqual([own]);
    const b = await growthExperiments(w.e, w.companyId, user, { sprintId: `${w.companyId}-cl` });
    expect(b.scope).toBe("client");
    expect(b.experiments.map((x: any) => x.experimentId)).toEqual([cl]);
    const before = await w.programs();
    const c = await growthExperiments(w.e, w.companyId, user, { sprintId: `${w.companyId}-old` });
    expect(c).toMatchObject({ scope: "unlinked", legacyClientName: "Legacy Co", experiments: [], programId: null });
    expect(await w.programs()).toBe(before);
  });

  it("counts running from the store, not the truncated list", async () => {
    const w = world();
    await w.sprint("own", null, null);
    const oldest = await w.seed(null, "running");
    for (let i = 0; i < 51; i += 1) await w.seed(null, "abandoned");
    const r = await growthExperiments(w.e, w.companyId, user, { sprintId: `${w.companyId}-own` });
    expect(r.experiments.length).toBe(50);
    expect(r.running).toBe(1);
    expect(oldest).toBeDefined();
  });

  it("a sprint from another company is not found and creates no program", async () => {
    const a = world();
    const b = world();
    await a.sprint("own", null, null);
    await expect(growthExperiments(b.e, b.companyId, user, { sprintId: `${a.companyId}-own` })).rejects.toThrow(/not found/);
    expect(await b.programs()).toBe(0);
  });

  it("approve moves proposed to running on safe autopilot; limit applies", async () => {
    const w = world();
    const id = await w.seed(null, "proposed");
    await growthApprove(w.e, w.companyId, user, { experimentId: id });
    expect(await w.status(id)).toBe("running");
    await w.seed(null, "running");
    await w.seed(null, "running");
    const extra = await w.seed(null, "proposed");
    await expect(growthApprove(w.e, w.companyId, user, { experimentId: extra })).rejects.toThrow(/already running/);
    expect(await w.status(extra)).toBe("proposed");
  });

  it("reject needs a reason; abandon stops a running experiment", async () => {
    const w = world();
    const id = await w.seed(null, "proposed");
    await expect(growthReject(w.e, w.companyId, user, { experimentId: id })).rejects.toThrow(/reason/);
    expect(await w.status(id)).toBe("proposed");
    await growthReject(w.e, w.companyId, user, { experimentId: id, reason: "no" });
    expect(await w.status(id)).toBe("rejected");
    const run = await w.seed(null, "running");
    await growthAbandon(w.e, w.companyId, user, { experimentId: run });
    expect(await w.status(run)).toBe("abandoned");
  });

  it("an experiment from another company is not found", async () => {
    const a = world();
    const b = world();
    const id = await a.seed(null, "proposed");
    for (const fn of [growthApprove, growthAbandon]) await expect(fn(b.e, b.companyId, user, { experimentId: id })).rejects.toThrow(/not found/);
    await expect(growthReject(b.e, b.companyId, user, { experimentId: id, reason: "x" })).rejects.toThrow(/not found/);
    expect(await a.status(id)).toBe("proposed");
  });

  it("all four fail when SEO is switched off", async () => {
    const w = world(true);
    for (const fn of [growthExperiments, growthApprove, growthReject, growthAbandon]) {
      await expect(fn(w.e, w.companyId, user, { sprintId: "s", experimentId: "x", reason: "r" })).rejects.toThrow("SEO is switched off for this company.");
    }
  });
});

describe("worker wiring", () => {
  it("refuses an agent on all four actions", async () => {
    const harness = createTestHarness({ manifest, config: { timezone: "Africa/Johannesburg" } });
    harness.seed({ companies: [{ id: "co-1", issuePrefix: "PIB", name: "PiB" } as never] });
    await plugin.definition.setup(harness.ctx);
    for (const key of ["seo.growth-experiments", "seo.growth-approve-experiment", "seo.growth-reject-experiment", "seo.growth-abandon-experiment"]) {
      await expect(harness.performAction(key, { sprintId: "s", experimentId: "x", reason: "r" }, { companyId: "co-1", actor: { type: "agent", agentId: "a1" } })).rejects.toThrow("This action is for board users");
    }
  });
});

describe("approval text", () => {
  it("names the scope", async () => {
    const { seoGrowthEnv: mk } = await import("../src/growth-host.js");
    const env = mk({} as never, "co-1") as any;
    const base = { companyId: "co-1", id: "p", autopilot: "safe", ownerUserId: null };
    const own = await env.buildApprovalInput({ ...base, clientRef: null }, "w1", []);
    expect(own.description).toContain("any of our own SEO sprints");
    const cl = await env.buildApprovalInput({ ...base, clientRef: "c1", clientName: "Acme" }, "w1", []);
    expect(cl.description).toContain("any SEO sprint for Acme");
  });
});
