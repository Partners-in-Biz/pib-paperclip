import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { experimentsMigration, experimentsScopeAlterMigration } from "../src/experiments.js";
import { createGrowthStore, type GrowthDb, type KitExperiment, type KitProgram } from "../src/growth/store.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";

const available = await embeddedAvailable();
const SOCIAL_NS = "plugin_social_e70c4e79f2";
const SOCIAL_MIGRATIONS = new URL("../../plugin-social/migrations/", import.meta.url);
let pg: Pg;

beforeAll(async () => {
  if (available) pg = await startPg();
}, 120_000);

afterAll(async () => {
  if (available) await pg.stop();
});

function dbOf(): GrowthDb {
  return {
    query: async (sql, params) => (await pg.client.query(sql, params)).rows as never,
    execute: async (sql, params) => ({ rowCount: (await pg.client.query(sql, params)).rowCount ?? 0 }),
  };
}

const NEW_PROGRAM = (id: string, companyId: string, over: Record<string, unknown> = {}) => ({
  id, companyId, clientKind: null, clientRef: null, clientName: null, channel: "social", objective: "o", metric: "m", constraints: {}, playbook: "# P",
  playbookVersion: 1, autopilot: "reviewed", scoreboard: {}, featureQuestions: [], ownerUserId: null, ...over,
});
const NEW_EXPERIMENT = (id: string, companyId: string, programId: string) => ({
  id, companyId, programId, hypothesis: "h", hypothesisType: "hook:question", variable: "v",
  arms: [{ key: "control", description: "a" }, { key: "variant", description: "b" }], metric: "m", minPerArm: 3, windowDays: 7, status: "proposed", proposedBy: "agent:a",
});

const SCHEMAS: Array<{ name: string; ns: string; approval: boolean; setup: (ns: string) => Promise<void> }> = [
  {
    name: "fresh v2 schema",
    ns: "test_growth_store_v2",
    approval: false,
    setup: async (ns) => {
      await pg.client.query(experimentsMigration(ns));
    },
  },
  {
    name: "Social 001-012 plus the scope alter",
    ns: SOCIAL_NS,
    approval: true,
    setup: async (ns) => {
      for (const f of readdirSync(SOCIAL_MIGRATIONS).sort().filter((n) => n <= "012_social.sql")) {
        await pg.client.query(readFileSync(new URL(f, SOCIAL_MIGRATIONS), "utf8"));
      }
      await pg.client.query(experimentsScopeAlterMigration(ns));
    },
  },
];

describe.skipIf(!available).each(SCHEMAS)("generic growth store on $name", ({ ns, approval, setup }) => {
  const store = () =>
    createGrowthStore<{
      program: KitProgram; newProgram: unknown; programPatch: unknown; version: unknown; experiment: KitExperiment; experimentStatus: string;
      newExperiment: unknown; experimentPatch: unknown; item: unknown; change: unknown; changeStatus: string; newChange: unknown; changePatch: unknown;
    }>({ db: dbOf(), table: (name) => `${ns}.${name}`, programApproval: approval });

  beforeAll(async () => {
    await pg.client.query(`DROP SCHEMA IF EXISTS ${ns} CASCADE`);
    await pg.client.query(`CREATE SCHEMA ${ns}`);
    await setup(ns);
  }, 60_000);

  it("writes scope_key next to the legacy columns", async () => {
    const s = store();
    await s.insertProgram(NEW_PROGRAM("own1", "co"));
    await s.insertProgram(NEW_PROGRAM("cli1", "co", { clientKind: "company", clientRef: "acme", clientName: "Acme" }));
    await s.insertProgram(NEW_PROGRAM("ct1", "co", { clientKind: "contact", clientRef: "jo" }));
    const rows = (await pg.client.query(`SELECT id, scope_key, client_kind, client_ref FROM ${ns}.growth_programs ORDER BY id`)).rows;
    expect(rows).toEqual([
      { id: "cli1", scope_key: "client:company:acme", client_kind: "company", client_ref: "acme" },
      { id: "ct1", scope_key: "client:contact:jo", client_kind: "contact", client_ref: "jo" },
      { id: "own1", scope_key: "own", client_kind: null, client_ref: null },
    ]);
  });

  it("finds a program by scope and never another scope's (two-scope isolation)", async () => {
    const s = store();
    expect((await s.findProgram("co", "social", null))?.id).toBe("own1");
    expect((await s.findProgram("co", "social", { kind: "company", id: "acme" }))?.id).toBe("cli1");
    expect((await s.findProgram("co", "social", { kind: "contact", id: "jo" }))?.id).toBe("ct1");
    expect(await s.findProgram("co", "social", { kind: "company", id: "other" })).toBeNull();
    expect(await s.findProgram("co", "social", { kind: "contact", id: "acme" })).toBeNull();
    expect(await s.findProgram("co2", "social", null)).toBeNull();
    expect(await s.findProgram("co", "email", null)).toBeNull();
  });

  it("does not write one scope's program over another's", async () => {
    const s = store();
    await s.insertProgram(NEW_PROGRAM("own-dup", "co"));
    expect((await s.findProgram("co", "social", null))?.id).toBe("own1");
    await s.updateProgram("co", "cli1", { objective: "new" });
    expect((await s.getProgram("co", "own1"))?.objective).toBe("o");
    expect((await s.getProgram("co", "cli1"))?.objective).toBe("new");
    await s.updateProgram("co2", "cli1", { objective: "hijack" });
    expect((await s.getProgram("co", "cli1"))?.objective).toBe("new");
  });

  it("finds a legacy row written without scope_key", async () => {
    if (ns !== SOCIAL_NS) return;
    await pg.client.query(`INSERT INTO ${ns}.growth_programs (id, company_id, client_kind, client_ref, channel, objective, metric) VALUES ('legacy', 'co', 'company', 'old', 'social', 'o', 'm')`);
    const found = await store().findProgram("co", "social", { kind: "company", id: "old" });
    expect(found?.id).toBe("legacy");
    expect(found?.scopeKey).toBe("client:company:old");
  });

  it("round-trips program fields, the playbook version guard and versions", async () => {
    const s = store();
    await s.updateProgram("co", "own1", { autopilot: "safe", constraints: { topics: ["a"] }, ownerUserId: "u1", scoreboard: { "hook:question": { wins: 1 } }, featureQuestions: [{ key: "k" }], ...(approval ? { approvalIssueId: "iss", approvalWeek: "2026-W40" } : {}) });
    const p = (await s.getProgram("co", "own1"))!;
    expect(p).toMatchObject({ autopilot: "safe", constraints: { topics: ["a"] }, ownerUserId: "u1", featureQuestions: [{ key: "k" }], approvalIssueId: approval ? "iss" : null, approvalWeek: approval ? "2026-W40" : null });
    expect(await s.savePlaybook("co", "own1", 1, "# P2")).toBe(true);
    expect(await s.savePlaybook("co", "own1", 1, "# stale")).toBe(false);
    await s.insertPlaybookVersion({ programId: "own1", version: 2, playbook: "# P2", reason: "r", experimentId: null, createdBy: "user:u" });
    await s.insertPlaybookVersion({ programId: "own1", version: 2, playbook: "# dup", reason: "r", experimentId: null, createdBy: null });
    const versions = (await s.listPlaybookVersions("own1", 10)) as Array<{ version: number; playbook: string }>;
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: 2, playbook: "# P2" });
  });

  it("runs the experiment lifecycle, scoped by company", async () => {
    const s = store();
    await s.insertExperiment(NEW_EXPERIMENT("e1", "co", "own1"));
    await s.insertExperiment(NEW_EXPERIMENT("e2", "co", "cli1"));
    expect(await s.getExperiment("co2", "e1")).toBeNull();
    expect((await s.listExperiments("co", "own1")).map((e) => e.id)).toEqual(["e1"]);
    expect(await s.updateExperiment("co", "e1", ["running"], { status: "measured" })).toBe(false);
    const now = new Date().toISOString();
    expect(await s.updateExperiment("co", "e1", ["proposed"], { status: "running", startedAt: now, approvedBy: "user:u", measureAfter: now })).toBe(true);
    expect(await s.updateExperiment("co2", "e2", null, { status: "running" })).toBe(false);
    expect(await s.companiesWithRunningExperiments()).toEqual(["co"]);
    expect((await s.runningExperiments("co")).map((e) => e.id)).toEqual(["e1"]);
    expect(await s.runningExperiments("co2")).toEqual([]);
    expect((await s.listExperiments("co", "own1", ["running"]))[0]).toMatchObject({ status: "running", approvedBy: "user:u" });
  });

  it("keeps items and playbook changes", async () => {
    const s = store();
    await s.upsertItem("e1", "control", "post1", null);
    await s.upsertItem("e1", "variant", "post1", 0.25);
    await s.upsertItem("e1", "control", "post2", 0.1);
    await s.deleteItem("e1", "post2");
    expect(await s.listItems("e1")).toMatchObject([{ experimentId: "e1", arm: "variant", postId: "post1", value: 0.25 }]);
    await s.insertChange({ id: "ch1", companyId: "co", programId: "own1", experimentId: "e1", op: "add", section: "rules", body: "b", diff: "d", reason: "r", baseVersion: 1, proposedBy: "agent:a" });
    expect(await s.getChange("co2", "ch1")).toBeNull();
    expect(await s.updateChange("co2", "ch1", { status: "kept" }, true)).toBe(false);
    expect(await s.updateChange("co", "ch1", { status: "kept", decidedBy: "user:u", resultVersion: 3 }, true)).toBe(true);
    expect(await s.updateChange("co", "ch1", { status: "discarded" }, true)).toBe(false);
    expect(await s.listChanges("co", "own1", "pending")).toEqual([]);
    expect(await s.listChanges("co", "own1", "kept")).toMatchObject([{ id: "ch1", status: "kept", decidedBy: "user:u", resultVersion: 3 }]);
  });
});
