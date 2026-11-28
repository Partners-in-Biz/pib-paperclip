import { describe, expect, it } from "vitest";
import type { PluginContext, ToolResult } from "@paperclipai/plugin-sdk";
import { ADMIN_ONLY, ANY_MEMBER, actionCaller, createAccessGuard, toolCaller, type AccessCheck, type AccessTable } from "../src/access/guard.js";
import { isRefusal } from "../src/access/refusal.js";
import { noteAccessReceived } from "../src/access/cache.js";
import { GROWTH_TOOL_NAMES, registerGrowthTools, type GrowthToolsHost } from "../src/growth/tools.js";

const CO = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const PLUGIN = "partnersinbiz.ads";
const TABLE: AccessTable = {
  view: { resource: "crm.contacts", action: "view" },
  scopedView: { resource: "crm.contacts", action: "view", scoped: true },
  admin: ADMIN_ONLY,
  open: ANY_MEMBER("every page needs it"),
  "tool:look": { resource: "crm.contacts", action: "view" },
};
const ALLOW_VIEW = { allow: ["crm.contacts:view"], scopeOverrides: { crm: "all" } };
const LINKED_VIEW = { allow: ["crm.contacts:view"], linkedCompanyIds: ["crm-co-1"] };

/** A plugin context with the switch row, members, grants and runs; every core read is counted. */
function fake(mode: "off" | "report" | "enforce" | null) {
  const state = new Map<string, unknown>();
  if (mode) state.set("company", { mode, rev: 1, userIds: [], receivedAt: new Date().toISOString() });
  const members: Array<{ principalType: string; principalId: string; status: string; membershipRole: string }> = [];
  let run: { responsible_user_id: string | null; status: string } | "throw" | null = null;
  const n = { members: 0, runs: 0 };
  const emitted: Array<{ name: string; payload: unknown }> = [];
  const actions = new Map<string, (p: Record<string, unknown>, c: unknown) => Promise<unknown>>();
  const tools = new Map<string, (p: unknown, r: unknown) => Promise<ToolResult>>();
  const ctx = {
    state: { get: async (s: { stateKey: string }) => state.get(s.stateKey) ?? null },
    access: { members: { list: async () => (n.members++, members) } },
    db: {
      query: async () => {
        n.runs++;
        if (run === "throw") throw new Error("read failed");
        return run ? [run] : [];
      },
    },
    events: { on: () => undefined, emit: async (name: string, _c: string, payload: unknown) => void emitted.push({ name, payload }) },
    actions: { register: (k: string, h: (p: Record<string, unknown>, c: unknown) => Promise<unknown>) => void actions.set(k, h) },
    tools: { register: (k: string, _d: unknown, h: (p: unknown, r: unknown) => Promise<ToolResult>) => void tools.set(k, h) },
    logger: { info: () => undefined },
  } as unknown as PluginContext;
  const seen: AccessCheck[] = [];
  const guard = createAccessGuard(ctx, { pluginKey: PLUGIN, table: TABLE });
  for (const key of Object.keys(TABLE).filter((k) => !k.startsWith("tool:")).concat("missing")) {
    guard.action(key, async (_p, _c, check) => (seen.push(check), { done: key }));
  }
  guard.tool("look", { displayName: "Look", description: "Look", parametersSchema: { type: "object" } }, async (_p, _r, check) => (seen.push(check), { content: "looked" }));
  return {
    ctx, n, emitted, seen, guard, tools, state,
    member: (id: string, role: string, grant?: object, status = "active") => {
      members.push({ principalType: "user", principalId: id, status, membershipRole: role });
      if (grant) state.set(`u:${id}`, grant);
    },
    setRun: (r: typeof run) => void (run = r),
    act: (key: string, actor: Record<string, unknown> | null, companyId: string | null = CO) =>
      actions.get(key)!({}, actor ? { actor: { companyId, ...actor }, companyId } : undefined),
    tool: (runCtx: Record<string, unknown> = {}) => tools.get("look")!({}, { agentId: AGENT, runId: RUN, companyId: CO, projectId: "", ...runCtx }),
  };
}

const user = (userId: string) => ({ type: "user", userId, agentId: null, runId: null });
const agent = (runId: string | null = RUN) => ({ type: "agent", userId: null, agentId: AGENT, runId });
const refused = (r: unknown) => isRefusal(r) && (r as { code: string }).code === "PERMISSION_DENIED";
const toolRefused = (r: ToolResult) => typeof r.error === "string" && r.error.startsWith("Access refused");

describe("createAccessGuard: callers of plan 4.4 under enforce", () => {
  it("system passes; owner, admin and local board pass with no table entry", async () => {
    const f = fake("enforce");
    f.member("own", "owner");
    f.member("adm", "admin");
    expect(await f.act("missing", { type: "system" })).toEqual({ done: "missing" });
    for (const id of ["own", "adm", "local-board"]) expect(await f.act("admin", user(id))).toEqual({ done: "admin" });
  });

  it("limited person: grant and table entry decide; no entry, ADMIN_ONLY and no grant refused", async () => {
    const f = fake("enforce");
    f.member("op", "operator", ALLOW_VIEW);
    f.member("bare", "operator");
    expect(await f.act("view", user("op"))).toEqual({ done: "view" });
    expect(await f.act("open", user("op"))).toEqual({ done: "open" });
    for (const key of ["missing", "admin"]) expect(refused(await f.act(key, user("op")))).toBe(true);
    expect(refused(await f.act("view", user("bare")))).toBe(true);
    expect(await f.act("open", user("bare"))).toEqual({ done: "open" });
  });

  it("not an active member, or nobody signed in: refused, even on ANY_MEMBER", async () => {
    const f = fake("enforce");
    f.member("gone", "operator", ALLOW_VIEW, "suspended");
    for (const caller of [user("gone"), user("stranger"), { type: "user", userId: null }]) expect(refused(await f.act("open", caller))).toBe(true);
  });

  it("agent: decided by the run's person, for actions and tools", async () => {
    const f = fake("enforce");
    f.member("own", "owner");
    f.member("op", "operator", ALLOW_VIEW);
    f.member("bare", "operator");
    for (const [person, pass] of [["own", true], ["op", true], ["bare", false]] as const) {
      f.setRun({ responsible_user_id: person, status: "running" });
      noteAccessReceived(f.ctx, CO); // drops the cached run
      expect(refused(await f.act("view", agent()))).toBe(!pass);
      expect(toolRefused(await f.tool())).toBe(!pass);
    }
  });

  it("agent: no person on the run, run not found, ended, failed read, no runId: refused", async () => {
    for (const run of [{ responsible_user_id: null, status: "running" }, null, { responsible_user_id: "own", status: "succeeded" }, "throw"] as const) {
      const f = fake("enforce");
      f.member("own", "owner");
      f.setRun(run);
      expect(refused(await f.act("view", agent()))).toBe(true);
      expect(toolRefused(await f.tool())).toBe(true);
    }
    const f = fake("enforce");
    expect(refused(await f.act("view", agent(null)))).toBe(true);
    expect(toolRefused(await f.tool({ runId: "" }))).toBe(true);
    expect(f.n.runs).toBe(0);
  });

  it("a refused tool names no record and points to Setup", async () => {
    const f = fake("enforce");
    const r = await f.tool({ runId: "" });
    expect(r.error).toBe("Access refused: the person this run works for may not do this (This agent call has no run, so the person it works for is unknown). An owner can change it in Setup under People.");
    expect(r.content).toBe(r.error);
    expect(f.emitted).toEqual([{ name: "access.refusal", payload: { companyId: CO, pluginKey: PLUGIN, userId: null, key: "tool:look", permission: "crm.contacts:view", viaAgentId: AGENT } }]);
  });

  it("no company: a person passes (the bridge checked instance admin), an agent is refused", async () => {
    const f = fake("enforce");
    expect(await f.act("admin", user("someone"), null)).toEqual({ done: "admin" });
    expect(refused(await f.act("view", agent(), null))).toBe(true);
    expect(refused(await f.act("view", { type: "user", userId: null }, null))).toBe(true);
    expect(await f.act("view", null, null)).toEqual({ done: "view" }); // no actor: the host itself, as in the sdk
    expect(toolRefused(await f.tool({ companyId: "" }))).toBe(true);
  });
});

describe("scope rule", () => {
  it("an own-companies decision is refused on an entry without scoped, and handed over on one with it", async () => {
    const f = fake("enforce");
    f.member("cm", "operator", LINKED_VIEW);
    expect(refused(await f.act("view", user("cm")))).toBe(true);
    expect(await f.act("scopedView", user("cm"))).toEqual({ done: "scopedView" });
    expect(f.seen.at(-1)?.decision).toEqual({ allowed: true, scope: "linked", companyIds: ["crm-co-1"] });
  });
});

describe("modes", () => {
  it("off or no row: the handler runs with no member or run lookup", async () => {
    for (const mode of ["off", null] as const) {
      const f = fake(mode);
      expect(await f.act("missing", user("op"))).toEqual({ done: "missing" });
      expect(await f.act("view", agent(null))).toEqual({ done: "view" });
      expect(await f.tool()).toEqual({ content: "looked" });
      expect(f.n).toEqual({ members: 0, runs: 0 });
      expect(f.emitted.filter((e) => e.name === "access.refusal")).toEqual([]);
      expect(f.seen.every((c) => c.decision.scope === "all")).toBe(true);
    }
  });

  it("report: the call goes through with no limit and the refusal is reported", async () => {
    const f = fake("report");
    f.member("cm", "operator", LINKED_VIEW);
    expect(await f.act("missing", user("cm"))).toEqual({ done: "missing" });
    expect(await f.act("scopedView", user("cm"))).toEqual({ done: "scopedView" });
    expect(f.seen.map((c) => c.decision)).toEqual([{ allowed: true, scope: "all" }, { allowed: true, scope: "all" }]);
    expect(f.emitted).toEqual([{ name: "access.refusal", payload: { companyId: CO, pluginKey: PLUGIN, userId: "cm", key: "missing", permission: null, viaAgentId: null } }]);
  });
});

describe("registration", () => {
  it("records the keys it registered", () => {
    expect(fake(null).guard.keys().sort()).toEqual(["admin", "missing", "open", "scopedView", "tool:look", "view"]);
  });

  it("the growth helper registers its tools through the guard", async () => {
    const f = fake("enforce");
    const host = { actor: async () => ({}), handlers: Object.fromEntries(GROWTH_TOOL_NAMES.map((n) => [n, async () => ({ ok: true })])) } as unknown as GrowthToolsHost;
    registerGrowthTools(f.ctx, host, f.guard);
    expect(f.guard.keys()).toEqual(expect.arrayContaining(GROWTH_TOOL_NAMES.map((n) => `tool:${n}`)));
    const r = await f.tools.get("get-playbook")!({}, { agentId: AGENT, runId: "", companyId: CO, projectId: "" });
    expect(r.error).toMatch(/^Access refused/);
  });
});


/** The acting person core sends (PAR-12608 4.10, H3). */
const host = (onBehalfOfUserId: string | null, onBehalfOfRestricted = false) => ({ onBehalfOfUserId, onBehalfOfRestricted });

describe("acting person from the host (H3)", () => {
  it("the callers carry it only when the host sent it, and never on the host itself", () => {
    expect(actionCaller({ actor: { ...agent(), ...host("own", true) } } as never).onBehalfOf).toEqual({ userId: "own", restricted: true });
    expect(actionCaller({ actor: agent() } as never)).not.toHaveProperty("onBehalfOf");
    expect(actionCaller({ actor: { type: "system", ...host("own") } } as never)).not.toHaveProperty("onBehalfOf");
    expect(toolCaller({ agentId: AGENT, runId: "", companyId: CO, projectId: "", ...host(" key-person ") }).onBehalfOf).toEqual({ userId: "key-person", restricted: false });
  });

  it("agent: decided by the host's person with no run lookup; a run id is not trusted over it", async () => {
    const f = fake("enforce");
    f.member("own", "owner");
    f.member("bare", "operator");
    // The run named in the call works for the owner; the host says the call works for "bare".
    f.setRun({ responsible_user_id: "own", status: "running" });
    expect(refused(await f.act("view", { ...agent(), ...host("bare") }))).toBe(true);
    expect(toolRefused(await f.tool(host("bare")))).toBe(true);
    expect(await f.act("view", { ...agent(), ...host("own") })).toEqual({ done: "view" });
    expect(f.n.runs).toBe(0);
  });

  it("agent key with no run: takes the key's person instead of a refusal", async () => {
    const f = fake("enforce");
    f.member("own", "owner");
    f.member("op", "operator", ALLOW_VIEW);
    expect(await f.act("view", { ...agent(null), ...host("op") })).toEqual({ done: "view" });
    expect(await f.tool({ runId: "", ...host("own") })).toEqual({ content: "looked" });
    expect(f.seen.at(-1)?.caller.onBehalfOf).toEqual({ userId: "own", restricted: false });
    expect(f.n.runs).toBe(0);
  });

  it("agent with no run, and a run with no person, are still refused with the fields (AC-H6)", async () => {
    const f = fake("enforce");
    f.member("own", "owner");
    f.setRun({ responsible_user_id: "own", status: "running" });
    expect(refused(await f.act("view", { ...agent(null), ...host(null) }))).toBe(true);
    expect(refused(await f.act("view", { ...agent(), ...host(null) }))).toBe(true);
    const noRun = await f.tool({ runId: "", ...host(null) });
    expect(noRun.error).toContain("This agent call has no run");
    const noPerson = await f.tool(host(null));
    expect(noPerson.error).toContain("The run of this call names no person");
    expect(f.n.runs).toBe(0);
  });

  it("a person keeps his own id; the local board still passes with the host's null", async () => {
    const f = fake("enforce");
    f.member("bare", "operator");
    expect(refused(await f.act("view", { ...user("bare"), ...host("bare") }))).toBe(true);
    expect(await f.act("admin", { ...user("local-board"), ...host(null) })).toEqual({ done: "admin" });
  });

  it("restricted mark and no company row: refused and reported; the same plugin passes the unmarked (AC-H3a)", async () => {
    const f = fake(null);
    expect(refused(await f.act("view", { ...user("r"), ...host("r", true) }))).toBe(true);
    expect(toolRefused(await f.tool(host("r", true)))).toBe(true);
    expect(f.emitted.filter((e) => e.name === "access.refusal").map((e) => e.payload)).toEqual([
      { companyId: CO, pluginKey: PLUGIN, userId: "r", key: "view", permission: null, viaAgentId: null },
      { companyId: CO, pluginKey: PLUGIN, userId: "r", key: "tool:look", permission: null, viaAgentId: AGENT },
    ]);
    for (const who of ["o", "u"]) {
      expect(await f.act("view", { ...user(who), ...host(who) })).toEqual({ done: "view" });
      expect(await f.tool(host(who))).toEqual({ content: "looked" });
    }
    expect(await f.act("view", user("old-core"))).toEqual({ done: "view" }); // no fields: stage A
    expect(f.n).toEqual({ members: 0, runs: 0 });
  });

  it("restricted mark with a row: the row decides, as for everyone (off passes)", async () => {
    const off = fake("off");
    expect(await off.act("view", { ...user("r"), ...host("r", true) })).toEqual({ done: "view" });
    const enf = fake("enforce");
    enf.member("r", "operator", ALLOW_VIEW);
    expect(await enf.act("view", { ...user("r"), ...host("r", true) })).toEqual({ done: "view" });
    expect(refused(await enf.act("admin", { ...user("r"), ...host("r", true) }))).toBe(true);
  });
});
