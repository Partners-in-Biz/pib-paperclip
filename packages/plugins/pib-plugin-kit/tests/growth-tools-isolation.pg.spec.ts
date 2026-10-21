/**
 * Growth tools, two scopes in one company (Postgres): every scoped tool called
 * with scope A neither returns nor writes scope B's rows. The id-only tools
 * (decide, approve, reject) take no scope, so they are checked the other way:
 * acting on A's id leaves B's row untouched. Runs the kit lifecycle on the real
 * kit store over the v2 schema, through the factory.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";
import { experimentsMigration, starterPlaybook } from "../src/experiments.js";
import { parseClientParam } from "../src/client-ref.js";
import {
  approveExperiment, decidePlaybookChange, listExperimentsRecord, programForParams, proposeExperiment, proposePlaybookChange, rejectExperiment, getPlaybookRecord,
  type GrowthActor,
} from "../src/growth/service.js";
import { createGrowthStore, type GrowthDb } from "../src/growth/store.js";
import { runGrowthTool, type GrowthToolName, type GrowthToolsHost } from "../src/growth/tools.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";

const available = await embeddedAvailable();
const NS = "test_growth_tools_isolation";
const KNOWN = new Set(["company:a", "company:b"]);
const A = "client:company:a";
const B = "client:company:b";
const RUN = { companyId: "co", agentId: "agent1", runId: "r1" } as unknown as ToolRunContext;
let pg: Pg;
let n = 0;

beforeAll(async () => {
  if (!available) return;
  pg = await startPg();
  await pg.client.query(`CREATE SCHEMA ${NS}`);
  await pg.client.query(experimentsMigration(NS));
}, 120_000);
afterAll(async () => {
  if (available) await pg.stop();
});

const db = (): GrowthDb => ({
  query: async (sql, params) => (await pg.client.query(sql, params)).rows as never,
  execute: async (sql, params) => ({ rowCount: (await pg.client.query(sql, params)).rowCount ?? 0 }),
});

/** A fresh company per test, so one test's rows never feed another. */
function world() {
  const companyId = `co-${(n += 1)}`;
  const kitStore = createGrowthStore<any>({ db: db(), table: (name) => `${NS}.${name}` });
  const store: any = { ...kitStore, experimentPosts: async () => [], setPostExperiment: async () => true };
  const env: any = {
    ctx: { logger: { info: () => {} }, events: { emit: vi.fn(async () => {}) } },
    store,
    now: () => new Date("2026-10-21T08:00:00Z"),
    scopes: {
      fromParams: async (_company: string, params: Record<string, unknown>) => {
        const value = typeof params.client === "string" ? params.client : null;
        if (!value) return { scope: null, client: null };
        const scope = parseClientParam(value);
        if (!scope || !KNOWN.has(value)) throw new Error(`Unknown client ${value}`);
        return { scope, client: { name: `Client ${scope.id}` } };
      },
    },
    issuePort: () => ({ createApproval: async () => ({ id: "issue-1" }), isOpen: async () => true, setStatus: async () => {}, comment: async () => {} }),
    buildApprovalInput: async () => ({}),
    starterPlaybook: (target: { scope: { id: string } | null }) => starterPlaybook(target.scope ? `Client ${target.scope.id}` : "Own"),
    programOut: (p: any) => ({ programId: p.id, client: p.clientRef ? `${p.clientKind}:${p.clientRef}` : null, playbookVersion: p.playbookVersion }),
    experimentOut: (e: any) => ({ experimentId: e.id, programId: e.programId, status: e.status }),
    changeOut: (c: any) => ({ changeId: c.id, programId: c.programId, status: c.status }),
    experimentLines: () => ["experiment"],
    changeLines: () => ["change"],
    actorLabel: () => "the agent",
    timezone: () => "UTC",
  };
  const actor: GrowthActor = { companyId, userId: null, agentId: "agent1", isAgent: true };
  // The review is channel code; this stand-in reads only through the scope's program.
  const performanceReview = async (e: any, a: GrowthActor, p: Record<string, unknown>) => {
    const program = await programForParams(e, a, p);
    return {
      programId: program.id,
      experiments: (await e.store.listExperiments(a.companyId, program.id)).map((x: any) => x.id),
      pendingChanges: (await e.store.listChanges(a.companyId, program.id, "pending")).map((x: any) => x.id),
    };
  };
  const host: GrowthToolsHost = {
    actor: async () => actor,
    handlers: {
      "performance-review": (a, p) => performanceReview(env, a, p),
      "get-playbook": (a, p) => getPlaybookRecord(env, a, p),
      "propose-playbook-change": (a, p) => proposePlaybookChange(env, a, p),
      "decide-playbook-change": (a, p) => decidePlaybookChange(env, a, p),
      "list-experiments": (a, p) => listExperimentsRecord(env, a, p),
      "propose-experiment": (a, p) => proposeExperiment(env, a, p),
      "approve-experiment": (a, p) => approveExperiment(env, a, p),
      "reject-experiment": (a, p) => rejectExperiment(env, a, p),
    },
  };
  const call = async (name: GrowthToolName, params: Record<string, unknown>): Promise<any> => {
    const result = await runGrowthTool(host, name, params, { ...RUN, companyId });
    if (result.error) throw new Error(result.error);
    return result.data;
  };
  const programId = async (scope: string) => (await call("get-playbook", { scope })).programId as string;
  /** Full autopilot so an agent may decide; programs are created on first use. */
  const setup = async () => {
    const ids = { a: await programId(A), b: await programId(B) };
    for (const id of Object.values(ids)) await store.updateProgram(companyId, id, { autopilot: "full" });
    return ids;
  };
  const experiment = (id: string, programId: string) => ({
    id: `${companyId}-${id}`, companyId, programId, hypothesis: "h", hypothesisType: "hook:question", variable: "v",
    arms: [{ key: "control", description: "a" }, { key: "variant", description: "b" }], metric: "m", minPerArm: 3, windowDays: 7, status: "proposed", proposedBy: "agent:a",
  });
  const proposal = { hypothesis: "Questions lift replies", hypothesisType: "hook:question", variable: "Opening line", arms: [{ key: "control", description: "statement" }, { key: "variant", description: "question" }] };
  const eid = (id: string) => `${companyId}-${id}`;
  return { companyId, store, call, setup, experiment, proposal, eid };
}

describe.skipIf(!available)("growth tools: two-scope isolation", () => {
  it("get-playbook: each scope has its own program and playbook", async () => {
    const w = await world();
    const { a, b } = await w.setup();
    const own = await w.call("get-playbook", { scope: "own" });
    expect(new Set([a, b, own.programId]).size).toBe(3);
    await w.call("propose-playbook-change", { scope: A, text: "Only for A", section: "rules", reason: "r" });
    expect((await w.call("get-playbook", { scope: A })).pendingChanges).toHaveLength(1);
    expect((await w.call("get-playbook", { scope: B })).pendingChanges).toEqual([]);
    expect((await w.call("get-playbook", { scope: "own" })).pendingChanges).toEqual([]);
    expect((await w.call("get-playbook", { scope: B })).playbook).not.toContain("Only for A");
  });

  it("get-playbook: an unknown client is refused and creates no program", async () => {
    const w = await world();
    const before = (await pg.client.query(`SELECT count(*)::int AS c FROM ${NS}.growth_programs WHERE company_id = $1`, [w.companyId])).rows as Array<{ c: number }>;
    await expect(w.call("get-playbook", { scope: "client:company:ghost" })).rejects.toThrow(/Unknown client/);
    await expect(w.call("get-playbook", { scope: "product:p1" })).rejects.toThrow(/does not run product scopes/);
    const after = (await pg.client.query(`SELECT count(*)::int AS c FROM ${NS}.growth_programs WHERE company_id = $1`, [w.companyId])).rows as Array<{ c: number }>;
    expect(after[0].c).toBe(before[0].c);
  });

  it("performance-review: scope A shows only A's experiments and changes", async () => {
    const w = await world();
    const { a, b } = await w.setup();
    await w.store.insertExperiment(w.experiment("ea", a));
    await w.store.insertExperiment(w.experiment("eb", b));
    await w.call("propose-playbook-change", { scope: B, text: "B rule", section: "rules", reason: "r" });
    const reviewA = await w.call("performance-review", { scope: A });
    expect(reviewA).toMatchObject({ programId: a, experiments: [w.eid("ea")], pendingChanges: [] });
    const reviewB = await w.call("performance-review", { scope: B });
    expect(reviewB).toMatchObject({ programId: b, experiments: [w.eid("eb")] });
    expect(reviewB.pendingChanges).toHaveLength(1);
  });

  it("propose-playbook-change: writes to A's program only", async () => {
    const w = await world();
    const { a, b } = await w.setup();
    const out = await w.call("propose-playbook-change", { scope: A, text: "Use questions", section: "rules", reason: "evidence" });
    expect(out.programId).toBe(a);
    expect(await w.store.listChanges(w.companyId, a, "pending")).toHaveLength(1);
    expect(await w.store.listChanges(w.companyId, b)).toEqual([]);
    expect(((await w.store.getProgram(w.companyId, b)) as any).playbookVersion).toBe(1);
  });

  it("decide-playbook-change: keeping A's change leaves B's change pending and B's playbook alone", async () => {
    const w = await world();
    const { a, b } = await w.setup();
    const changeA = await w.call("propose-playbook-change", { scope: A, text: "A rule", section: "rules", reason: "r" });
    const changeB = await w.call("propose-playbook-change", { scope: B, text: "B rule", section: "rules", reason: "r" });
    const decided = await w.call("decide-playbook-change", { changeId: changeA.changeId, decision: "keep" });
    expect(decided).toMatchObject({ status: "kept", playbookVersion: 2 });
    expect(((await w.store.getProgram(w.companyId, a)) as any).playbook).toContain("A rule");
    const programB = (await w.store.getProgram(w.companyId, b)) as any;
    expect(programB.playbookVersion).toBe(1);
    expect(programB.playbook).not.toContain("A rule");
    expect((await w.store.getChange(w.companyId, changeB.changeId) as any).status).toBe("pending");
  });

  it("list-experiments: each scope lists only its own", async () => {
    const w = await world();
    const { a, b } = await w.setup();
    await w.store.insertExperiment(w.experiment("ea", a));
    await w.store.insertExperiment(w.experiment("eb", b));
    expect((await w.call("list-experiments", { scope: A })).experiments.map((e: any) => e.experimentId)).toEqual([w.eid("ea")]);
    expect((await w.call("list-experiments", { scope: B })).experiments.map((e: any) => e.experimentId)).toEqual([w.eid("eb")]);
    expect((await w.call("list-experiments", { scope: "own" })).experiments).toEqual([]);
  });

  it("propose-experiment: the experiment belongs to A's program, B has none", async () => {
    const w = await world();
    const { a, b } = await w.setup();
    const out = await w.call("propose-experiment", { scope: A, ...w.proposal });
    expect(out.programId).toBe(a);
    expect(await w.store.listExperiments(w.companyId, a)).toHaveLength(1);
    expect(await w.store.listExperiments(w.companyId, b)).toEqual([]);
  });

  it("approve-experiment: starting A's experiment leaves B's proposed", async () => {
    const w = await world();
    const { a, b } = await w.setup();
    await w.store.insertExperiment(w.experiment("ea", a));
    await w.store.insertExperiment(w.experiment("eb", b));
    expect(await w.call("approve-experiment", { experimentId: w.eid("ea") })).toMatchObject({ status: "running" });
    expect(((await w.store.getExperiment(w.companyId, w.eid("ea"))) as any).status).toBe("running");
    expect(((await w.store.getExperiment(w.companyId, w.eid("eb"))) as any).status).toBe("proposed");
  });

  it("reject-experiment: rejecting A's experiment leaves B's proposed", async () => {
    const w = await world();
    const { a, b } = await w.setup();
    await w.store.insertExperiment(w.experiment("ea", a));
    await w.store.insertExperiment(w.experiment("eb", b));
    expect(await w.call("reject-experiment", { experimentId: w.eid("ea"), reason: "weak" })).toMatchObject({ status: "rejected" });
    expect(((await w.store.getExperiment(w.companyId, w.eid("ea"))) as any).status).toBe("rejected");
    expect(((await w.store.getExperiment(w.companyId, w.eid("eb"))) as any).status).toBe("proposed");
  });

  it("refuses another company's ids (id tools are company-scoped)", async () => {
    const w = await world();
    const other = await world();
    const { a } = await other.setup();
    await other.store.insertExperiment(other.experiment("foreign", a));
    await expect(w.call("approve-experiment", { experimentId: other.eid("foreign") })).rejects.toThrow(/not found/);
    expect(((await other.store.getExperiment(other.companyId, other.eid("foreign"))) as any).status).toBe("proposed");
  });
});
