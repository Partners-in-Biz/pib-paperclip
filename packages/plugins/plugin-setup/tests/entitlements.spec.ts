import { describe, expect, it } from "vitest";
import { entitledModules, planModules, PLANS, type EntitlementRow } from "../src/entitlements.js";
import { MODULE_KEYS, SETUP_EVENTS, type ModuleKey } from "../src/kit-setup.js";
import { JOBS } from "../src/manifest.js";
import { effectiveModules, ForbiddenError, normalizeEntitledModules } from "../src/modules.js";
import { handleApiRoute, registerSetup } from "../src/register.js";
import { backfillEntitlements, reemitModules, saveModules, setEntitlements } from "../src/service.js";
import { fakeCtx, fixedClock } from "./helpers/fake-ctx.js";

const PAR = "company-par";
const CLIENT = "company-client";
const OTHER = "company-other";
const clock = fixedClock("2026-10-24T08:00:00.000Z");
const companies = { [PAR]: { name: "Partners in Biz" }, [CLIENT]: { name: "Client" }, [OTHER]: { name: "Other" } };
const members = {
  [PAR]: [
    { principalId: "peet", membershipRole: "owner" },
    { principalId: "ops-member", membershipRole: "member" },
    { principalId: "ops-gone", membershipRole: "admin", status: "suspended" },
  ],
  [CLIENT]: [
    { principalId: "client-owner", membershipRole: "owner" },
    { principalId: "client-admin", membershipRole: "admin" },
    { principalId: "client-member", membershipRole: "member" },
    { principalId: "client-viewer", membershipRole: "viewer" },
  ],
};
const user = (userId: string) => ({ companyId: CLIENT, actor: { type: "user", userId, agentId: null } });
const on = (modules: Record<ModuleKey, boolean>) => MODULE_KEYS.filter((key) => modules[key]).sort();

function setup() {
  const env = fakeCtx({ companies, members, savedConfigs: { [PAR]: { ownerCompany: true }, [CLIENT]: { weeklyIssue: true }, [OTHER]: {} } });
  registerSetup(env.ctx);
  return env;
}
const apiInput = (companyId: string) => ({ routeKey: "modules", companyId }) as never;

describe("plans", () => {
  it("maps each tier to its modules plus cockpit and the Company wiki", () => {
    expect(PLANS).toEqual(["starter", "growth", "business", "pib"]);
    expect(planModules("starter").sort()).toEqual(["cockpit", "crm", "mailbox", "memory"]);
    expect(planModules("growth").sort()).toEqual(["campaigns", "cockpit", "crm", "mailbox", "memory", "seo", "social"]);
    expect(planModules("business").sort()).toEqual(["billing", "campaigns", "cockpit", "crm", "mailbox", "memory", "seo", "social"]);
    expect(planModules("pib").sort()).toEqual([...MODULE_KEYS].sort());
  });
});

describe("entitledModules", () => {
  const row = (module: ModuleKey, state: EntitlementRow["state"], until: string | null = null) => ({ module, state, until });
  const now = new Date("2026-10-24T08:00:00.000Z");

  it("entitles nothing but cockpit and the wiki when there are no rows", () => {
    expect(on(entitledModules([], now))).toEqual(["cockpit", "memory"]);
  });
  it("counts a trial until its end, and honours off (except for cockpit)", () => {
    const result = entitledModules([row("seo", "trial", "2026-10-25T00:00:00.000Z"), row("social", "trial", "2026-10-23T00:00:00.000Z"), row("memory", "off"), row("cockpit", "off"), row("crm", "entitled")], now);
    expect(on(result)).toEqual(["cockpit", "crm", "seo"]);
  });
});

describe("effectiveModules", () => {
  const entitled = entitledModules([{ module: "crm", state: "entitled", until: null }, { module: "mailbox", state: "entitled", until: null }], new Date());
  it("gives a company with no saved choice exactly its entitlements", () => {
    expect(on(effectiveModules(null, entitled))).toEqual(["cockpit", "crm", "mailbox", "memory"]);
  });
  it("is the saved choice AND the entitlement", () => {
    expect(on(effectiveModules({ crm: false, payroll: true }, entitled))).toEqual(["cockpit", "mailbox", "memory"]);
  });
  it("without entitlements keeps the old behaviour (everything on)", () => {
    expect(on(effectiveModules(null))).toEqual([...MODULE_KEYS].sort());
  });
});

describe("normalizeEntitledModules", () => {
  const entitled = entitledModules([{ module: "crm", state: "entitled", until: null }], new Date());
  it("refuses a module that is switched on but not entitled", () => {
    expect(() => normalizeEntitledModules({ payroll: true }, entitled)).toThrow(ForbiddenError);
  });
  it("forces an unmentioned, unentitled module off", () => {
    expect(on(normalizeEntitledModules({}, entitled))).toEqual(["cockpit", "crm", "memory"]);
  });
});

describe("setup.save-modules roles and entitlements", () => {
  async function entitle() {
    const env = setup();
    await setEntitlements(env.ctx, { companyId: CLIENT, plan: "starter", userId: "peet" }, clock);
    await backfillMarker(env);
    return env;
  }
  // setEntitlements rows only count once the backfill marker exists; mark it done without entitling anyone else.
  async function backfillMarker(env: ReturnType<typeof setup>) {
    await env.ctx.state.set({ scopeKind: "instance", namespace: "setup", stateKey: "entitlements-backfilled" }, { at: "x" });
  }

  it("lets a company owner or admin save entitled modules", async () => {
    const env = await entitle();
    const save = env.actions.get("setup.save-modules")!;
    for (const who of ["client-owner", "client-admin"]) {
      const result = (await save({ modules: { mailbox: false } }, user(who))) as { modules: Record<ModuleKey, boolean> };
      expect(on(result.modules)).toEqual(["cockpit", "crm", "memory"]);
    }
  });
  it("refuses a member, a viewer, a stranger, a suspended admin and an agent with 403-type errors", async () => {
    const env = await entitle();
    const save = env.actions.get("setup.save-modules")!;
    for (const who of ["client-member", "client-viewer", "stranger", "ops-gone"]) {
      await expect(save({ modules: {} }, user(who))).rejects.toThrow(ForbiddenError);
    }
    await expect(save({ modules: {} }, { companyId: CLIENT, actor: { type: "agent", userId: null, agentId: "ag" } })).rejects.toThrow(/board user/);
    expect(env.store.module_choices ?? []).toHaveLength(0);
  });
  it("refuses a company admin switching on a module that is not in the plan", async () => {
    const env = await entitle();
    await expect(env.actions.get("setup.save-modules")!({ modules: { payroll: true } }, user("client-admin"))).rejects.toThrow(/not in this company's plan/);
    expect(env.store.module_choices ?? []).toHaveLength(0);
  });
  it("lets an operator-company admin save for a client", async () => {
    const env = await entitle();
    await expect(env.actions.get("setup.save-modules")!({ modules: { crm: true } }, user("peet"))).resolves.toBeTruthy();
  });
  it("stores nothing unentitled even when the page leaves a module out", async () => {
    const env = await entitle();
    const result = await saveModules(env.ctx, { companyId: CLIENT, modules: {}, userId: "client-admin" }, clock);
    expect(on(result.modules)).toEqual(["cockpit", "crm", "mailbox", "memory"]);
  });
});

describe("setup.set-entitlements gate", () => {
  const call = (env: ReturnType<typeof setup>, userId: string | null, params: Record<string, unknown> = { companyId: CLIENT, plan: "growth" }, type = "user") =>
    env.actions.get("setup.set-entitlements")!(params, { companyId: PAR, actor: { type, userId, agentId: type === "agent" ? "ag" : null } });

  it("accepts an owner or admin of the operator company and stores a row per module", async () => {
    const env = setup();
    const result = (await call(env, "peet")) as { plan: string; entitled: Record<ModuleKey, boolean> };
    expect(result.plan).toBe("growth");
    expect(on(result.entitled)).toEqual(planModules("growth").sort());
    expect(env.store.entitlements).toHaveLength(MODULE_KEYS.length);
    expect(env.store.entitlements!.find((row) => row.module === "seo")).toMatchObject({ company_id: CLIENT, state: "entitled", plan: "growth", updated_by: "peet" });
    expect(env.store.entitlements!.find((row) => row.module === "billing")).toMatchObject({ state: "off" });
    expect(env.emitted.some((e) => e.name === SETUP_EVENTS.modulesUpdated && e.companyId === CLIENT)).toBe(true);
  });
  it("refuses an agent", async () => {
    const env = setup();
    await expect(call(env, null, undefined, "agent")).rejects.toThrow(ForbiddenError);
  });
  it("refuses a missing user id", async () => {
    await expect(call(setup(), null)).rejects.toThrow(ForbiddenError);
  });
  it("refuses a client's own owner and admin", async () => {
    const env = setup();
    for (const who of ["client-owner", "client-admin"]) await expect(call(env, who)).rejects.toThrow(ForbiddenError);
    expect(env.store.entitlements ?? []).toHaveLength(0);
  });
  it("refuses a member of the operator company and a suspended operator admin", async () => {
    const env = setup();
    for (const who of ["ops-member", "ops-gone", "stranger"]) await expect(call(env, who)).rejects.toThrow(ForbiddenError);
  });
  it("refuses everyone when no company is marked as the operator company", async () => {
    const env = fakeCtx({ companies, members, savedConfigs: {} });
    registerSetup(env.ctx);
    await expect(call(env, "peet")).rejects.toThrow(ForbiddenError);
  });
  it("fails closed when the membership lookup throws", async () => {
    const env = setup();
    (env.ctx as unknown as { access: { members: { list: () => Promise<never> } } }).access.members.list = async () => {
      throw new Error("access.members.read denied");
    };
    await expect(call(env, "peet")).rejects.toThrow(ForbiddenError);
  });
  it("validates the input", async () => {
    const env = setup();
    await expect(call(env, "peet", { companyId: CLIENT, plan: "gold" })).rejects.toThrow(/plan must be/);
    await expect(call(env, "peet", { companyId: CLIENT })).rejects.toThrow(/plan, a module/);
    await expect(call(env, "peet", { companyId: "nope", plan: "starter" })).rejects.toThrow(/Unknown company/);
    await expect(call(env, "peet", { companyId: CLIENT, modules: { seo: "trial" } })).rejects.toThrow(/until/);
    await expect(call(env, "peet", { companyId: CLIENT, modules: { cockpit: "off" } })).rejects.toThrow(/Cockpit/);
    await expect(call(env, "peet", { companyId: CLIENT, modules: { nonsense: "entitled" } })).rejects.toThrow(/Unknown module/);
  });
  it("still sets a client's entitlements when the host denies the out-of-scope company lookup", async () => {
    const env = setup();
    (env.ctx.companies as { get: unknown }).get = async () => {
      throw new Error("requested company is outside the current invocation scope");
    };
    await expect(call(env, "peet", { companyId: CLIENT, plan: "starter" })).resolves.toMatchObject({ plan: "starter" });
    expect(env.store.entitlements).toHaveLength(MODULE_KEYS.length);
  });
  it("keeps the plan label and applies a per-module trial on top", async () => {
    const env = setup();
    await call(env, "peet", { companyId: CLIENT, plan: "starter" });
    await call(env, "peet", { companyId: CLIENT, modules: { seo: "trial" }, until: "2026-11-01T00:00:00.000Z" });
    const seo = env.store.entitlements!.find((row) => row.module === "seo")!;
    expect(seo).toMatchObject({ state: "trial", plan: "starter" });
    const crm = env.store.entitlements!.find((row) => row.module === "crm")!;
    expect(crm).toMatchObject({ state: "entitled" });
  });
});

async function entitlementsReadyForTest(env: ReturnType<typeof setup>): Promise<boolean> {
  return (await env.ctx.state.get({ scopeKind: "instance", namespace: "setup", stateKey: "entitlements-backfilled" })) != null;
}

describe("backfill (the plan's 1.4)", () => {
  it("entitles every existing company to every module once, without overwriting", async () => {
    const env = setup();
    await setEntitlements(env.ctx, { companyId: OTHER, plan: "starter", userId: "peet" }, clock);
    const first = await backfillEntitlements(env.ctx, clock);
    expect(first).toEqual({ companies: 3, alreadyDone: false });
    const rows = env.store.entitlements!;
    expect(rows.filter((row) => row.company_id === PAR && row.state === "entitled" && row.plan === "pib")).toHaveLength(MODULE_KEYS.length);
    expect(rows.filter((row) => row.company_id === OTHER && row.state === "entitled")).toHaveLength(4);
    expect(await backfillEntitlements(env.ctx, clock)).toEqual({ companies: 0, alreadyDone: true });
  });
  it("completes a company after a part-way failure instead of skipping it", async () => {
    const env = setup();
    const real = env.ctx.db.execute.bind(env.ctx.db);
    let calls = 0;
    (env.ctx.db as { execute: unknown }).execute = async (sql: string, params?: unknown[]) => {
      calls += 1;
      if (calls === 5) throw new Error("db went away");
      return real(sql, params);
    };
    await expect(backfillEntitlements(env.ctx, clock)).rejects.toThrow(/db went away/);
    expect(env.store.entitlements!.length).toBe(4);
    expect(await entitlementsReadyForTest(env)).toBe(false);
    await backfillEntitlements(env.ctx, clock);
    for (const id of [PAR, CLIENT, OTHER]) expect(env.store.entitlements!.filter((row) => row.company_id === id)).toHaveLength(MODULE_KEYS.length);
  });
  it("leaves PAR with all modules on after the backfill, and nothing locked before it", async () => {
    const env = setup();
    // Before the backfill ran: no company is locked, not even one without rows.
    const before = (await handleApiRoute(env.ctx, apiInput(PAR))) as { body: { modules: unknown } };
    expect(before.body.modules).toBeNull();
    await backfillEntitlements(env.ctx, clock);
    const after = (await handleApiRoute(env.ctx, apiInput(PAR))) as { body: { modules: Record<ModuleKey, boolean> } };
    expect(on(after.body.modules)).toEqual([...MODULE_KEYS].sort());
  });
  it("gives a company created after the backfill only cockpit and the wiki, until entitled", async () => {
    const env = setup();
    await backfillEntitlements(env.ctx, clock);
    env.store.entitlements = (env.store.entitlements ?? []).filter((row) => row.company_id !== CLIENT);
    const route = (await handleApiRoute(env.ctx, apiInput(CLIENT))) as { status: number; body: { modules: Record<ModuleKey, boolean>; updatedAt: string | null } };
    expect(route.status).toBe(200);
    expect(on(route.body.modules)).toEqual(["cockpit", "memory"]);
    expect(Object.keys(route.body).sort()).toEqual(["modules", "updatedAt"]);
  });
});

describe("hourly re-send and the job", () => {
  it("re-sends the entitled modules of a company that has entitlements but no saved choice", async () => {
    const env = setup();
    await backfillEntitlements(env.ctx, clock);
    await setEntitlements(env.ctx, { companyId: CLIENT, plan: "starter", userId: "peet" }, clock);
    env.emitted.length = 0;
    const result = await reemitModules(env.ctx);
    expect(result.failed).toBe(0);
    const payload = env.emitted.find((e) => e.name === SETUP_EVENTS.modulesUpdated && e.companyId === CLIENT)!.payload as { modules: Record<ModuleKey, boolean> };
    expect(on(payload.modules)).toEqual(["cockpit", "crm", "mailbox", "memory"]);
  });
  it("retries the backfill from the hourly job", async () => {
    const env = setup();
    await env.jobs.get(JOBS.reemitModules)!();
    expect(env.store.entitlements!.length).toBeGreaterThan(0);
  });
});
