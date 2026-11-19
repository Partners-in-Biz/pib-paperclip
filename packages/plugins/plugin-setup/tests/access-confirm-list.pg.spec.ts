/**
 * Before `enforce` (PAR-12578 plan, 4.3): the people who would have no access at
 * all, each with the runs that worked for him in the last 30 days, for the owner
 * to confirm. Runs are seeded in a `heartbeat_runs` table with the core columns.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getAccessSettings, recordAccessSync } from "../src/access-store.js";
import { SWITCH_REFUSALS, noAccessPeople, setAccessSwitch } from "../src/access-switch.js";
import { ACCESS_PEERS } from "../src/access-sync.js";
import { NAMESPACE } from "../src/namespace.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";

const available = await embeddedAvailable();
let pg: Pg;

beforeAll(async () => {
  if (!available) return;
  pg = await startPg({ coreReadTables: ["heartbeat_runs"] });
  // The core columns the run count reads.
  await pg.client.query(`CREATE TABLE public.heartbeat_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, responsible_user_id text, status text NOT NULL, created_at timestamptz NOT NULL)`);
}, 120_000);

afterAll(async () => {
  if (available) await pg.stop();
});

const CO = "0b5e1c7a-1111-4a2b-8c3d-000000000001";
const OTHER = "0b5e1c7a-1111-4a2b-8c3d-000000000002";
const OWNER = { type: "user", userId: "owner" };
const DAY = 86_400_000;

const MEMBERS = [
  { principalType: "user", principalId: "owner", membershipRole: "owner", status: "active" },
  { principalType: "user", principalId: "admin2", membershipRole: "admin", status: "active" },
  { principalType: "user", principalId: "u1", membershipRole: "member", status: "active" }, // no grant
  { principalType: "user", principalId: "u2", membershipRole: "member", status: "active" }, // viewer: has access
  { principalType: "user", principalId: "u3", membershipRole: "viewer", status: "active" }, // a grant that opens nothing
  { principalType: "user", principalId: "u4", membershipRole: "member", status: "suspended" },
  { principalType: "agent", principalId: "agent-1", membershipRole: "member", status: "active" },
  { principalType: "user", principalId: "local-board", membershipRole: "member", status: "active" },
];

function world(opts: { membersFail?: boolean; runsFail?: boolean; members?: typeof MEMBERS } = {}) {
  const activity: Array<{ companyId: string; message: string; metadata: Record<string, unknown> }> = [];
  const state = new Map<string, unknown>([
    [`${CO}:u:u2`, { userId: "u2", preset: "viewer" }],
    [`${CO}:u:u3`, { userId: "u3", allow: ["crm.contacts:view"], deny: ["crm.contacts:view"] }],
  ]);
  const ctx = {
    db: {
      namespace: NAMESPACE,
      query: (sql: string, params?: unknown[]) => {
        if (opts.runsFail && sql.includes("heartbeat_runs")) throw new Error("public.heartbeat_runs not whitelisted");
        return pg.db.query(sql, params);
      },
      execute: (sql: string, params?: unknown[]) => pg.db.execute(sql, params),
    },
    config: { get: async () => ({ modules: {} }) },
    state: { get: async (scope: { scopeId?: string; stateKey: string }) => state.get(`${scope.scopeId}:${scope.stateKey}`) ?? null },
    access: {
      members: {
        list: async () => {
          if (opts.membersFail) throw new Error("members down");
          return opts.members ?? MEMBERS;
        },
      },
    },
    activity: {
      log: async (entry: { companyId: string; message: string; metadata: Record<string, unknown> }) => {
        activity.push(entry);
      },
    },
    events: { emit: async () => undefined },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
  } as unknown as PluginContext;
  return { ctx, activity };
}

async function seedRun(companyId: string, userId: string, status: string, ageMs: number) {
  await pg.client.query(`INSERT INTO public.heartbeat_runs (company_id, responsible_user_id, status, created_at) VALUES ($1, $2, $3, $4)`, [
    companyId,
    userId,
    status,
    new Date(Date.now() - ageMs).toISOString(),
  ]);
}

async function confirmAll(ctx: PluginContext, companyId: string, rev: number, skip: string[] = []) {
  for (const pluginKey of ACCESS_PEERS) {
    if (!skip.includes(pluginKey)) await recordAccessSync(ctx, { companyId, pluginKey, rev, syncedAt: new Date().toISOString() });
  }
}

describe.skipIf(!available)("the enforce confirm list, on a real database", () => {
  beforeEach(async () => {
    await pg.reset();
    await pg.client.query("TRUNCATE public.heartbeat_runs");
  });

describe("the confirm list before enforce", () => {
  beforeEach(async () => {
    // u1: 3 runs that worked in 30 days. Not counted: failed and running runs, one 31 days old, one in another company.
    for (const age of [DAY, 10 * DAY, 29 * DAY]) await seedRun(CO, "u1", "succeeded", age);
    await seedRun(CO, "u1", "failed", DAY);
    await seedRun(CO, "u1", "running", DAY);
    await seedRun(CO, "u1", "succeeded", 31 * DAY);
    await seedRun(OTHER, "u1", "succeeded", DAY);
    // u2 has access, so his runs never show; u3 has none in the window.
    await seedRun(CO, "u2", "succeeded", DAY);
    await seedRun(CO, "u3", "succeeded", 40 * DAY);
  });

  it("names every active person with no access, with the right 30-day count", async () => {
    const { ctx } = world();
    expect(await noAccessPeople(ctx, CO)).toEqual([
      { userId: "u1", role: "member", runsLast30Days: 3 },
      { userId: "u3", role: "viewer", runsLast30Days: 0 },
    ]);
  });

  it("refuses enforce until the owner confirmed the whole list, and writes nothing before", async () => {
    const { ctx, activity } = world();
    await confirmAll(ctx, CO, 0);
    const first = await setAccessSwitch(ctx, { companyId: CO, actor: OWNER }, "enforce");
    expect(first).toEqual({
      ok: false,
      error: SWITCH_REFUSALS.confirmNoAccess,
      noAccess: [
        { userId: "u1", role: "member", runsLast30Days: 3 },
        { userId: "u3", role: "viewer", runsLast30Days: 0 },
      ],
    });
    // Part of the list is not a confirmation.
    expect(await setAccessSwitch(ctx, { companyId: CO, actor: OWNER }, "enforce", ["u1"])).toMatchObject({ ok: false, error: SWITCH_REFUSALS.confirmNoAccess });
    expect(await getAccessSettings(ctx, CO)).toBeNull();
    expect(activity).toEqual([]);

    expect(await setAccessSwitch(ctx, { companyId: CO, actor: OWNER }, "enforce", ["u1", "u3"])).toMatchObject({ ok: true, mode: "enforce", rev: 1 });
  });

  it("asks again when someone joined after the owner saw the list", async () => {
    const joined = [...MEMBERS, { principalType: "user", principalId: "u5", membershipRole: "member", status: "active" }];
    const { ctx } = world({ members: joined });
    await confirmAll(ctx, CO, 0);
    const result = await setAccessSwitch(ctx, { companyId: CO, actor: OWNER }, "enforce", ["u1", "u3"]);
    expect(result).toMatchObject({ ok: false, error: SWITCH_REFUSALS.confirmNoAccess });
    expect(result.ok === false && result.noAccess?.map((p) => p.userId)).toEqual(["u1", "u3", "u5"]);
  });

  it("needs no confirmation when everyone has access", async () => {
    const { ctx } = world({ members: MEMBERS.slice(0, 2) });
    await confirmAll(ctx, CO, 0);
    expect(await setAccessSwitch(ctx, { companyId: CO, actor: OWNER }, "enforce")).toMatchObject({ ok: true, mode: "enforce" });
  });

  it("still names everyone when the runs cannot be read, with the count unknown", async () => {
    const { ctx } = world({ runsFail: true });
    expect(await noAccessPeople(ctx, CO)).toEqual([
      { userId: "u1", role: "member", runsLast30Days: null },
      { userId: "u3", role: "viewer", runsLast30Days: null },
    ]);
  });

  it("refuses enforce when the members cannot be read", async () => {
    const { ctx } = world({ membersFail: true });
    await confirmAll(ctx, CO, 0);
    expect(await setAccessSwitch(ctx, { companyId: CO, actor: OWNER }, "enforce", ["u1", "u3"])).toMatchObject({ ok: false });
    expect(await getAccessSettings(ctx, CO)).toBeNull();
  });

  it("report and off need no confirmation", async () => {
    const { ctx } = world();
    expect(await setAccessSwitch(ctx, { companyId: CO, actor: OWNER }, "report")).toMatchObject({ ok: true, mode: "report" });
    expect(await setAccessSwitch(ctx, { companyId: CO, actor: OWNER }, "off")).toMatchObject({ ok: true, mode: "off" });
  });
});
});
