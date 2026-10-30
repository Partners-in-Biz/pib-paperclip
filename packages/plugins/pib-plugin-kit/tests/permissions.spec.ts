import { describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  PERMISSION_ACTIONS,
  PERMISSION_CATALOG,
  PRESETS,
  assertCan,
  can,
  canSeeCompany,
  clearGrant,
  decideAccess,
  describePermissions,
  isPermissionKey,
  listAccess,
  loadGrant,
  permissionKey,
  resolveAccess,
  saveGrant,
  scopeCompanyIds,
  scopeRows,
  type Access,
  type AccessGrant,
} from "../src/permissions.js";

const CO = "co-1";
type Member = { principalType: string; principalId: string; status: string; membershipRole: string };

function fake(members: Member[], opts: { failMembers?: boolean } = {}) {
  const store = new Map<string, unknown>();
  const logs: Array<Record<string, unknown>> = [];
  const k = (s: { scopeId?: string; namespace?: string; stateKey: string }) => `${s.scopeId}|${s.namespace}|${s.stateKey}`;
  const ctx = {
    state: {
      get: async (s: never) => store.get(k(s)) ?? null,
      set: async (s: never, v: unknown) => void store.set(k(s), v),
      delete: async (s: never) => void store.delete(k(s)),
    },
    access: {
      members: {
        list: async () => {
          if (opts.failMembers) throw new Error("boom");
          return members;
        },
      },
    },
    activity: { log: async (e: Record<string, unknown>) => void logs.push(e) },
    logger: { info: () => undefined },
  } as unknown as PluginContext;
  return { ctx, store, logs };
}

const member = (id: string, role = "member", status = "active"): Member => ({ principalType: "user", principalId: id, status, membershipRole: role });
const user = (userId: string) => ({ type: "user", userId });
const grantFor = (over: Partial<AccessGrant> = {}): Access => ({
  userId: "u1",
  bypass: false,
  grant: { userId: "u1", preset: null, allow: [], deny: [], linkedCompanyIds: [], scopeOverrides: {}, updatedBy: null, updatedAt: "", ...over },
});

describe("catalog", () => {
  it("has unique resource ids, valid actions and a view action everywhere", () => {
    const ids = PERMISSION_CATALOG.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const res of PERMISSION_CATALOG) {
      expect(res.actions).toContain("view");
      for (const a of res.actions) expect(PERMISSION_ACTIONS).toContain(a);
    }
  });
  it("every preset permission exists in the catalog", () => {
    for (const p of Object.values(PRESETS)) for (const key of p.permissions) expect(isPermissionKey(key), `${p.id}: ${key}`).toBe(true);
  });
  it("covers every plugin area", () => {
    const areas = new Set(PERMISSION_CATALOG.map((x) => x.area));
    for (const a of ["crm", "billing", "accounting", "payroll", "social", "mailbox", "seo", "campaigns", "partners", "cockpit", "setup"]) expect(areas).toContain(a);
  });
});

describe("decide: allow/deny matrix", () => {
  it("denies by default", () => {
    expect(can({ userId: "u1", bypass: false, grant: null }, "crm.contacts", "view")).toBe(false);
    expect(can(grantFor(), "crm.contacts", "view")).toBe(false);
  });
  it("salesperson sees CRM and invoices but not the financial areas", () => {
    const sp = grantFor({ preset: "salesperson" });
    expect(can(sp, "crm.deals", "edit")).toBe(true);
    expect(can(sp, "billing.invoices", "view")).toBe(true);
    expect(can(sp, "billing.invoices", "edit")).toBe(false);
    expect(can(sp, "billing.reports", "view")).toBe(false);
    for (const res of PERMISSION_CATALOG.filter((x) => ["accounting", "payroll"].includes(x.area))) {
      for (const a of res.actions) expect(can(sp, res.id, a), `${res.id}:${a}`).toBe(false);
    }
  });
  it("allow adds, deny wins over preset and allow", () => {
    expect(can(grantFor({ preset: "viewer", allow: [permissionKey("billing.reports", "view")] }), "billing.reports", "view")).toBe(true);
    const k = permissionKey("crm.contacts", "view");
    expect(can(grantFor({ preset: "viewer", deny: [k] }), "crm.contacts", "view")).toBe(false);
    expect(can(grantFor({ allow: [k], deny: [k] }), "crm.contacts", "view")).toBe(false);
  });
  it("can view invoices without the financial section", () => {
    const g = grantFor({ allow: [permissionKey("billing.invoices", "view")] });
    expect(can(g, "billing.invoices", "view")).toBe(true);
    expect(can(g, "billing.reports", "view")).toBe(false);
    expect(can(g, "accounting.reports", "view")).toBe(false);
  });
  it("no preset reaches payroll or accounting settings except accountant (accounting only)", () => {
    for (const id of ["salesperson", "client", "viewer", "manager"] as const) {
      const g = grantFor({ preset: id });
      expect(can(g, "payroll.payruns", "view"), id).toBe(false);
      expect(can(g, "accounting.reports", "view"), id).toBe(false);
    }
    expect(can(grantFor({ preset: "accountant" }), "accounting.reports", "view")).toBe(true);
    expect(can(grantFor({ preset: "accountant" }), "payroll.payruns", "approve")).toBe(false);
  });
  it("denies unknown resources and actions, even to bypass", () => {
    expect(decideAccess({ userId: null, bypass: true, grant: null }, "nope.thing", "view").allowed).toBe(false);
    expect(decideAccess({ userId: null, bypass: true, grant: null }, "crm.settings", "delete").allowed).toBe(false);
  });
  it("assertCan throws a PERMISSION_DENIED error", () => {
    expect(() => assertCan(grantFor(), "crm.deals", "view")).toThrow(/permission/);
  });
});

describe("record scoping", () => {
  const rows = [
    { id: "a", company: "c1" },
    { id: "b", company: "c2" },
    { id: "c", company: null },
  ];
  it("client preset sees only linked companies; empty link list sees nothing", () => {
    const d = assertCan(grantFor({ preset: "client", linkedCompanyIds: ["c1"] }), "billing.invoices", "view");
    expect(scopeRows(d, rows, (r) => r.company).map((r) => r.id)).toEqual(["a"]);
    expect(scopeCompanyIds(d)).toEqual(["c1"]);
    expect(canSeeCompany(d, "c2")).toBe(false);
    const none = assertCan(grantFor({ preset: "client" }), "billing.invoices", "view");
    expect(scopeRows(none, rows, (r) => r.company)).toEqual([]);
    expect(scopeCompanyIds(none)).toEqual([]);
  });
  it("all scope returns every row and no filter", () => {
    const d = assertCan(grantFor({ preset: "salesperson" }), "crm.deals", "view");
    expect(scopeRows(d, rows, (r) => r.company)).toHaveLength(3);
    expect(scopeCompanyIds(d)).toBeNull();
  });
  it("per-resource and per-area overrides beat the preset; non-scopable resources ignore scope", () => {
    const g = grantFor({ preset: "salesperson", linkedCompanyIds: ["c1"], scopeOverrides: { "crm.deals": "linked", billing: "linked" } });
    expect(scopeCompanyIds(assertCan(g, "crm.deals", "view"))).toEqual(["c1"]);
    expect(scopeCompanyIds(assertCan(g, "crm.contacts", "view"))).toBeNull();
    expect(scopeCompanyIds(assertCan(g, "billing.invoices", "view"))).toEqual(["c1"]);
    const m = grantFor({ preset: "client", linkedCompanyIds: ["c1"], allow: [permissionKey("mailbox.mail", "view")] });
    expect(scopeCompanyIds(assertCan(m, "mailbox.mail", "view"))).toBeNull();
  });
});

describe("resolveAccess", () => {
  it("owners, admins and the local board bypass", async () => {
    const { ctx } = fake([member("o", "owner"), member("a", "admin")]);
    expect((await resolveAccess(ctx, CO, user("o"))).bypass).toBe(true);
    expect((await resolveAccess(ctx, CO, user("a"))).bypass).toBe(true);
    expect((await resolveAccess(ctx, CO, user("local-board"))).bypass).toBe(true);
  });
  it("a plain member with no grant, a non-member, an inactive member and a missing actor are denied", async () => {
    const { ctx } = fake([member("m"), member("x", "admin", "suspended")]);
    for (const actor of [user("m"), user("nobody"), user("x"), null, { type: "user", userId: "" }]) {
      const a = await resolveAccess(ctx, CO, actor);
      expect(a.bypass).toBe(false);
      expect(can(a, "crm.contacts", "view")).toBe(false);
    }
  });
  it("fails closed when members cannot be read", async () => {
    const { ctx } = fake([member("o", "owner")], { failMembers: true });
    const a = await resolveAccess(ctx, CO, user("o"));
    expect(a.bypass).toBe(false);
    expect(can(a, "crm.contacts", "view")).toBe(false);
  });
  it("agents are not restricted by this layer", async () => {
    const { ctx } = fake([]);
    expect((await resolveAccess(ctx, CO, { type: "agent" })).bypass).toBe(true);
  });
  it("a member picks up their stored grant", async () => {
    const { ctx } = fake([member("m")]);
    await saveGrant(ctx, { companyId: CO, actor: user("local-board") }, { userId: "m", preset: "salesperson" });
    const a = await resolveAccess(ctx, CO, user("m"));
    expect(can(a, "crm.deals", "view")).toBe(true);
    expect(can(a, "accounting.reports", "view")).toBe(false);
  });
});

describe("managing grants", () => {
  const members = [member("o", "owner"), member("a", "admin"), member("m"), member("n")];
  it("only an owner or admin can save, clear or list", async () => {
    const { ctx, store } = fake(members);
    for (const actor of [user("m"), user("nobody"), { type: "agent" }, null]) {
      expect((await saveGrant(ctx, { companyId: CO, actor }, { userId: "n", preset: "viewer" })).ok).toBe(false);
      expect((await clearGrant(ctx, { companyId: CO, actor }, "n")).ok).toBe(false);
      expect((await listAccess(ctx, { companyId: CO, actor })).ok).toBe(false);
    }
    expect(store.size).toBe(0);
  });
  it("validates input and writes nothing on a problem", async () => {
    const { ctx, store, logs } = fake(members);
    const act = { companyId: CO, actor: user("a") };
    const bad: Array<Parameters<typeof saveGrant>[2]> = [
      { userId: "m", preset: "god" as never },
      { userId: "m", allow: ["crm.contacts:fly"] },
      { userId: "m", deny: ["nope:view"] },
      { userId: "m", scopeOverrides: { nope: "all" } },
      { userId: "m", scopeOverrides: { crm: "some" as never } },
      { userId: "m", linkedCompanyIds: Array.from({ length: 201 }, (_, i) => `c${i}`) },
      { userId: "stranger", preset: "viewer" },
      { userId: "o", preset: "viewer" },
      { userId: "", preset: "viewer" },
    ];
    for (const input of bad) expect((await saveGrant(ctx, act, input)).ok, JSON.stringify(input).slice(0, 60)).toBe(false);
    expect((await saveGrant(ctx, { actor: user("a") }, { userId: "m", preset: "viewer" })).ok).toBe(false);
    expect(store.size).toBe(0);
    expect(logs).toHaveLength(0);
  });
  it("saves, audits before and after, lists and clears", async () => {
    const { ctx, logs } = fake(members);
    const act = { companyId: CO, actor: user("a") };
    const saved = await saveGrant(ctx, act, { userId: "m", preset: "client", linkedCompanyIds: ["c1", "c1", " c2 "] });
    expect(saved.ok && saved.grant.linkedCompanyIds).toEqual(["c1", "c2"]);
    await saveGrant(ctx, act, { userId: "m", preset: "viewer" });
    expect(logs).toHaveLength(2);
    expect(logs[1]).toMatchObject({ companyId: CO, entityType: "plugin_access", entityId: "m", metadata: { changedBy: "a", before: { preset: "client" }, after: { preset: "viewer" } } });
    const listed = await listAccess(ctx, act);
    expect(listed.ok && listed.rows.map((r) => [r.userId, r.grant?.preset ?? null])).toEqual([["o", null], ["a", null], ["m", "viewer"], ["n", null]]);
    expect((await clearGrant(ctx, act, "m")).ok).toBe(true);
    expect(await loadGrant(ctx, CO, "m")).toBeNull();
    expect(logs).toHaveLength(3);
    expect(logs[2]).toMatchObject({ metadata: { after: null } });
  });
  it("ignores tampered stored rows", async () => {
    const { ctx, store } = fake(members);
    store.set(`${CO}|access|u:m`, { preset: "root", allow: ["crm.contacts:view", "bogus:view", 7], deny: "x", scopeOverrides: { crm: "weird", billing: "linked" } });
    const g = await loadGrant(ctx, CO, "m");
    expect(g).toMatchObject({ preset: null, allow: ["crm.contacts:view"], deny: [], scopeOverrides: { billing: "linked" } });
  });
  it("describePermissions is serializable", () => {
    expect(JSON.parse(JSON.stringify(describePermissions())).presets).toHaveLength(5);
  });
});

describe("review fixes (PR 384)", () => {
  const members = [member("o", "owner"), member("a", "admin"), member("m")];
  const act = { companyId: CO, actor: user("a") };

  it("a grant with no preset and linked ids cannot see unlinked rows", () => {
    const g = grantFor({ allow: [permissionKey("crm.contacts", "view")], linkedCompanyIds: ["acme"] });
    const d = assertCan(g, "crm.contacts", "view");
    expect(scopeCompanyIds(d)).toEqual(["acme"]);
    expect(scopeRows(d, [{ c: "acme" }, { c: "other" }], (r) => r.c)).toEqual([{ c: "acme" }]);
  });
  it("no preset, allow and no links sees nothing; an explicit all override still works", () => {
    const allow = [permissionKey("crm.contacts", "view")];
    const none = assertCan(grantFor({ allow }), "crm.contacts", "view");
    expect(scopeRows(none, [{ c: "x" }], (r) => r.c)).toEqual([]);
    const all = assertCan(grantFor({ allow, scopeOverrides: { "crm.contacts": "all" } }), "crm.contacts", "view");
    expect(scopeCompanyIds(all)).toBeNull();
  });
  it("a failed audit write refuses the save and restores the previous grant", async () => {
    const { ctx } = fake(members);
    await saveGrant(ctx, act, { userId: "m", preset: "viewer" });
    (ctx as unknown as { activity: { log: () => Promise<void> } }).activity.log = async () => {
      throw new Error("down");
    };
    const r = await saveGrant(ctx, act, { userId: "m", preset: "manager" });
    expect(r.ok).toBe(false);
    expect((await loadGrant(ctx, CO, "m"))?.preset).toBe("viewer");
    expect((await clearGrant(ctx, act, "m")).ok).toBe(false);
    expect((await loadGrant(ctx, CO, "m"))?.preset).toBe("viewer");
  });
  it("a failed audit on a first grant removes it", async () => {
    const { ctx } = fake(members);
    (ctx as unknown as { activity: { log: () => Promise<void> } }).activity.log = async () => {
      throw new Error("down");
    };
    expect((await saveGrant(ctx, act, { userId: "m", preset: "viewer" })).ok).toBe(false);
    expect(await loadGrant(ctx, CO, "m")).toBeNull();
  });
  it("malformed input returns ok:false instead of throwing", async () => {
    const { ctx, store } = fake(members);
    const bad = [
      { userId: "m", allow: "crm.contacts:view" },
      { userId: "m", deny: [1] },
      { userId: "m", linkedCompanyIds: { a: 1 } },
      { userId: "m", scopeOverrides: [] },
    ];
    for (const input of bad) expect((await saveGrant(ctx, act, input as never)).ok).toBe(false);
    expect((await clearGrant(ctx, act, undefined as never)).ok).toBe(false);
    expect(store.size).toBe(0);
  });
  it("clearGrant trims the user id", async () => {
    const { ctx } = fake(members);
    await saveGrant(ctx, act, { userId: "m", preset: "viewer" });
    expect((await clearGrant(ctx, act, " m ")).ok).toBe(true);
    expect(await loadGrant(ctx, CO, "m")).toBeNull();
  });
  it("loading cleans tampered linked ids: trims, drops empties, dedupes, caps", async () => {
    const { ctx, store } = fake(members);
    const many = Array.from({ length: 300 }, (_, i) => `c${i}`);
    store.set(`${CO}|access|u:m`, { preset: "client", linkedCompanyIds: ["", "  ", " a ", "a", ...many, 5] });
    const g = await loadGrant(ctx, CO, "m");
    expect(g?.linkedCompanyIds[0]).toBe("a");
    expect(g?.linkedCompanyIds).not.toContain("");
    expect(g?.linkedCompanyIds).toHaveLength(200);
    expect(new Set(g?.linkedCompanyIds).size).toBe(200);
  });
});

describe("review fixes round 2 (PR 384)", () => {
  const members = [member("a", "admin"), member("m")];
  const act = { companyId: CO, actor: user("a") };
  const failAudit = (ctx: PluginContext) => {
    (ctx as unknown as { activity: { log: () => Promise<void> } }).activity.log = async () => {
      throw new Error("down");
    };
  };
  it("says so plainly when the rollback itself fails", async () => {
    const { ctx } = fake(members);
    failAudit(ctx);
    (ctx as unknown as { logger: { error: () => void } }).logger.error = () => undefined;
    (ctx as unknown as { state: { delete: () => Promise<void> } }).state.delete = async () => {
      throw new Error("state down");
    };
    const r = await saveGrant(ctx, act, { userId: "m", preset: "viewer" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/was saved but could not be recorded/);
  });
  it("a state read failure returns ok:false instead of rejecting", async () => {
    const { ctx } = fake(members);
    const state = (ctx as unknown as { state: { get: () => Promise<unknown> } }).state;
    state.get = async () => {
      throw new Error("read down");
    };
    expect((await saveGrant(ctx, act, { userId: "m", preset: "viewer" })).ok).toBe(false);
    expect((await clearGrant(ctx, act, "m")).ok).toBe(false);
  });
  it("rejects a non-string preset and writes no audit entry when clearing nothing", async () => {
    const { ctx, logs } = fake(members);
    expect((await saveGrant(ctx, act, { userId: "m", preset: ["viewer"] as never })).ok).toBe(false);
    expect((await clearGrant(ctx, act, "m")).ok).toBe(true);
    expect(logs).toHaveLength(0);
  });
});
