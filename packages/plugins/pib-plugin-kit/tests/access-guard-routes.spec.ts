import { describe, expect, it } from "vitest";
import type { PluginApiRequestInput, PluginApiResponse, PluginContext } from "@paperclipai/plugin-sdk";
import { createAccessGuard, routeCaller, type AccessCheck, type AccessTable } from "../src/access/guard.js";
import { isRefusal } from "../src/access/refusal.js";
import { noteAccessReceived } from "../src/access/cache.js";
import { ACCESS_ME_ACTION, PLUGIN_AREAS, areaKeys } from "../src/access/me.js";
import { GUARDED_PLUGINS } from "../src/guarded-plugins.js";
import { PERMISSION_CATALOG } from "../src/permissions.js";

const CO = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const PLUGIN = "partnersinbiz.ads";
const TABLE: AccessTable = {
  "api:report": { resource: "ads.work", action: "view" },
  "api:grant": { resource: "ads.work", action: "view" },
};
const ADS_VIEW = { allow: ["ads.work:view"], scopeOverrides: { ads: "all" } };

/** A plugin context with the switch row, members, grants and runs; every core read is counted. */
function fake(mode: "off" | "report" | "enforce" | null) {
  const state = new Map<string, unknown>();
  if (mode) state.set("company", { mode, rev: 1, userIds: [], receivedAt: new Date().toISOString() });
  const members: Array<{ principalType: string; principalId: string; status: string; membershipRole: string }> = [];
  let run: { responsible_user_id: string | null; status: string } | null = null;
  let membersFail = false;
  const n = { members: 0, runs: 0 };
  const emitted: Array<{ name: string; payload: unknown }> = [];
  const actions = new Map<string, (p: Record<string, unknown>, c: unknown) => Promise<unknown>>();
  const ctx = {
    state: { get: async (s: { stateKey: string }) => state.get(s.stateKey) ?? null },
    access: {
      members: {
        list: async () => {
          n.members++;
          if (membersFail) throw new Error("members read failed");
          return members;
        },
      },
    },
    db: { query: async () => (n.runs++, run ? [run] : []) },
    events: { on: () => undefined, emit: async (name: string, _c: string, payload: unknown) => void emitted.push({ name, payload }) },
    actions: { register: (k: string, h: (p: Record<string, unknown>, c: unknown) => Promise<unknown>) => void actions.set(k, h) },
    tools: { register: () => undefined },
    logger: { info: () => undefined },
  } as unknown as PluginContext;
  const seen: AccessCheck[] = [];
  const guard = createAccessGuard(ctx, { pluginKey: PLUGIN, table: TABLE });
  guard.apiRoute("report", async (_i, check) => (seen.push(check), { status: 200, body: { route: "report" } }));
  const fallback = async (input: PluginApiRequestInput): Promise<PluginApiResponse> => ({ status: 200, body: { fallback: input.routeKey } });
  return {
    ctx, n, emitted, seen, guard,
    member: (id: string, role: string, grant?: object) => {
      members.push({ principalType: "user", principalId: id, status: "active", membershipRole: role });
      if (grant) state.set(`u:${id}`, grant);
    },
    setRun: (r: typeof run) => {
      run = r;
      noteAccessReceived(ctx, CO); // drops the cached run
    },
    failMembers: () => void (membersFail = true),
    route: (routeKey: string, actor: Record<string, unknown> | null, opts: { fallback?: boolean; companyId?: string } = {}) =>
      guard.handleApiRequest(
        { routeKey, method: "GET", path: `/${routeKey}`, params: {}, query: {}, body: null, actor, companyId: opts.companyId ?? CO, headers: {} } as unknown as PluginApiRequestInput,
        opts.fallback ? fallback : undefined,
      ),
    me: (actor: Record<string, unknown> | null, companyId: string | null = CO) =>
      actions.get(ACCESS_ME_ACTION)!({}, actor ? { actor: { companyId, ...actor }, companyId } : { companyId }),
  };
}

const userA = (userId: string) => ({ actorType: "user", actorId: userId, userId, agentId: null, runId: null });
const agentA = (runId: string | null = RUN) => ({ actorType: "agent", actorId: AGENT, agentId: AGENT, userId: null, runId });
const refused = (r: PluginApiResponse) => r.status === 403 && isRefusal(r.body) && (r.body as { code: string }).code === "PERMISSION_DENIED";
const ok = { status: 200, body: { route: "report" } };

describe("routeCaller: the API-route actor in the guard's form (F26)", () => {
  it.each([
    ["user with userId", userA("u1"), { type: "user", userId: "u1", agentId: null, runId: null }],
    ["user with only actorId", { actorType: "user", actorId: "u2" }, { type: "user", userId: "u2", agentId: null, runId: null }],
    ["user keeps its run header", { actorType: "user", actorId: "u3", userId: "u3", runId: RUN }, { type: "user", userId: "u3", agentId: null, runId: RUN }],
    ["agent with run", agentA(), { type: "agent", userId: null, agentId: AGENT, runId: RUN }],
    ["agent: a userId on the request is ignored", { ...agentA(), userId: "owner" }, { type: "agent", userId: null, agentId: AGENT, runId: RUN }],
    ["agent with no run", agentA(null), { type: "agent", userId: null, agentId: AGENT, runId: null }],
    ["agent with no agentId (actorId is not trusted)", { actorType: "agent", actorId: "unknown-agent", runId: RUN }, { type: "agent", userId: null, agentId: null, runId: RUN }],
    ["unknown actorType is never system", { actorType: "system", actorId: "x", userId: "x" }, { type: "user", userId: null, agentId: null, runId: null }],
    ["no actor", null, { type: "user", userId: null, agentId: null, runId: null }],
  ])("%s", (_name, actor, expected) => {
    expect(routeCaller(actor as never)).toEqual(expected);
  });
});

describe("handleApiRequest under enforce: the caller table of 4.4 on a route", () => {
  it("owner, admin and an agent working for the owner pass; the handler gets the check", async () => {
    const f = fake("enforce");
    f.member("own", "owner");
    f.member("adm", "admin");
    expect(await f.route("report", userA("own"))).toEqual(ok);
    expect(await f.route("report", userA("adm"))).toEqual(ok);
    f.setRun({ responsible_user_id: "own", status: "running" });
    expect(await f.route("report", agentA())).toEqual(ok);
    expect(f.seen.map((c) => c.caller.type)).toEqual(["user", "user", "agent"]);
  });

  it("operator: with the grant passes, without it refused; an agent working for him is held to the same", async () => {
    const f = fake("enforce");
    f.member("op", "operator", ADS_VIEW);
    f.member("bare", "operator");
    expect(await f.route("report", userA("op"))).toEqual(ok);
    expect(refused(await f.route("report", userA("bare")))).toBe(true);
    f.setRun({ responsible_user_id: "op", status: "running" });
    expect(await f.route("report", agentA())).toEqual(ok);
    f.setRun({ responsible_user_id: "bare", status: "running" });
    expect(refused(await f.route("report", agentA()))).toBe(true);
  });

  it("agent with no run, a run with no person, an unknown actor and no company: refused", async () => {
    const f = fake("enforce");
    f.member("own", "owner");
    expect(refused(await f.route("report", agentA(null)))).toBe(true);
    f.setRun({ responsible_user_id: null, status: "running" });
    expect(refused(await f.route("report", agentA()))).toBe(true);
    expect(refused(await f.route("report", { actorType: "system", actorId: "own", userId: "own" }))).toBe(true);
    expect(refused(await f.route("report", userA("own"), { companyId: "" }))).toBe(true);
    expect(f.seen).toEqual([]);
  });

  it("a table key with no registered handler goes to the fallback, else 404", async () => {
    const f = fake("enforce");
    f.member("own", "owner");
    expect(await f.route("grant", userA("own"), { fallback: true })).toEqual({ status: 200, body: { fallback: "grant" } });
    expect(await f.route("grant", userA("own"))).toEqual({ status: 404, body: { error: "Unknown route" } });
  });
});

describe("unknown route key", () => {
  it.each(["report", "enforce"] as const)("%s: refused for every caller, owner included, and reported", async (mode) => {
    const f = fake(mode);
    f.member("own", "owner");
    const r = await f.route("nope", userA("own"), { fallback: true });
    expect(refused(r)).toBe(true);
    expect((r.body as { message: string }).message).toBe("This route is not in the plugin's access table");
    expect(f.n).toEqual({ members: 0, runs: 0 });
    expect(f.emitted.filter((e) => e.name === "access.refusal").map((e) => e.payload)).toEqual([
      { companyId: CO, pluginKey: PLUGIN, userId: "own", key: "api:nope", permission: null, viaAgentId: null },
    ]);
  });

  it.each(["off", null] as const)("switch %s: today's behaviour (the fallback, else 404)", async (mode) => {
    const f = fake(mode);
    expect(await f.route("nope", userA("own"), { fallback: true })).toEqual({ status: 200, body: { fallback: "nope" } });
    expect(await f.route("nope", userA("own"))).toEqual({ status: 404, body: { error: "Unknown route" } });
  });
});

describe("route modes", () => {
  it.each(["off", null] as const)("switch %s: no member or run lookup on the route path", async (mode) => {
    const f = fake(mode);
    f.member("bare", "operator");
    f.setRun({ responsible_user_id: "bare", status: "running" });
    for (const actor of [userA("bare"), agentA(), agentA(null), { actorType: "system" }]) expect(await f.route("report", actor)).toEqual(ok);
    expect(await f.route("nope", agentA(), { fallback: true })).toEqual({ status: 200, body: { fallback: "nope" } });
    expect(f.n).toEqual({ members: 0, runs: 0 });
    expect(f.emitted.filter((e) => e.name === "access.refusal")).toEqual([]);
    expect(f.seen.every((c) => c.mode === "off" && c.decision.scope === "all")).toBe(true);
  });

  it("report: a refused person goes through with no limit, and is reported", async () => {
    const f = fake("report");
    f.member("bare", "operator");
    expect(await f.route("report", userA("bare"))).toEqual(ok);
    expect(f.seen.map((c) => c.decision)).toEqual([{ allowed: true, scope: "all" }]);
    expect(f.emitted.map((e) => e.payload)).toEqual([{ companyId: CO, pluginKey: PLUGIN, userId: "bare", key: "api:report", permission: "ads.work:view", viaAgentId: null }]);
  });

  it("keys() lists the registered routes as api:<routeKey>", () => {
    expect(fake(null).guard.keys()).toEqual(["api:report"]);
  });
});

describe("access.me", () => {
  const all = areaKeys(["ads"]);

  it.each(["off", null, "report"] as const)("switch %s: open with every key of the plugin, no lookup", async (mode) => {
    const f = fake(mode);
    f.member("bare", "operator");
    for (const actor of [{ type: "user", userId: "own" }, { type: "user", userId: "bare" }, { type: "agent", agentId: AGENT, runId: RUN }]) {
      expect(await f.me(actor)).toEqual({ mode: mode ?? "off", open: true, permissions: all });
    }
    expect(f.n).toEqual({ members: 0, runs: 0 });
  });

  it("enforce: owner every key; operator his keys; operator with no grant closed", async () => {
    const f = fake("enforce");
    f.member("own", "owner");
    f.member("op", "operator", ADS_VIEW);
    f.member("bare", "operator");
    f.member("crm", "operator", { allow: ["crm.contacts:view"] });
    expect(await f.me({ type: "user", userId: "own" })).toEqual({ mode: "enforce", open: true, permissions: all });
    expect(await f.me({ type: "user", userId: "op" })).toEqual({ mode: "enforce", open: true, permissions: ["ads.work:view"] });
    expect(await f.me({ type: "user", userId: "bare" })).toEqual({ mode: "enforce", open: false, permissions: [] });
    expect(await f.me({ type: "user", userId: "crm" })).toEqual({ mode: "enforce", open: false, permissions: [] });
    expect(await f.me({ type: "user", userId: "stranger" })).toEqual({ mode: "enforce", open: false, permissions: [] });
  });

  it("enforce: an agent is answered for its run's person; no run is closed", async () => {
    const f = fake("enforce");
    f.member("op", "operator", ADS_VIEW);
    f.setRun({ responsible_user_id: "op", status: "running" });
    expect(await f.me({ type: "agent", agentId: AGENT, runId: RUN })).toEqual({ mode: "enforce", open: true, permissions: ["ads.work:view"] });
    expect(await f.me({ type: "agent", agentId: AGENT, runId: null })).toEqual({ mode: "enforce", open: false, permissions: [] });
  });

  it("enforce: a failed members read keeps the page open with no keys (the guard still refuses behind it)", async () => {
    const f = fake("enforce");
    f.member("own", "owner");
    f.failMembers();
    expect(await f.me({ type: "user", userId: "own" })).toEqual({ mode: "enforce", open: true, permissions: [] });
  });

  it("no company: a person or the host is open, an agent gets the refusal", async () => {
    const f = fake("enforce");
    expect(await f.me({ type: "user", userId: "someone" }, null)).toEqual({ mode: "off", open: true, permissions: all });
    expect(await f.me(null, null)).toEqual({ mode: "off", open: true, permissions: all });
    expect(isRefusal(await f.me({ type: "agent", agentId: AGENT, runId: RUN }, null))).toBe(true);
  });

  it("is not one of the guard's keys", () => {
    expect(fake(null).guard.keys()).not.toContain(ACCESS_ME_ACTION);
  });
});

describe("PLUGIN_AREAS", () => {
  it("every guarded plugin owns at least one area, and every catalog area has exactly one owner", () => {
    expect(Object.keys(PLUGIN_AREAS).sort()).toEqual([...GUARDED_PLUGINS].sort());
    const owned = Object.values(PLUGIN_AREAS).flat();
    expect(new Set(owned).size).toBe(owned.length);
    expect([...new Set(PERMISSION_CATALOG.map((r) => r.area))].sort()).toEqual([...owned].sort());
  });
});
