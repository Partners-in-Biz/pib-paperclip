/**
 * Watch live (PAR-14514 S3) on the real Cockpit worker (sdk harness): the fail-closed setting per consumer, who may
 * get a ticket, the route's single-use redemption and its one refusal, the activity record and the status pass-through.
 * The same handlers behind the real core action route and auth middleware: server/src/__tests__/cockpit-browser-live-routes.test.ts.
 */
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_LIVE_REFUSAL, loadBrowserLiveSessions, loadBrowserLiveStatus, readBrowserLiveSetting, TICKET_TTL_MS } from "../src/browser-live.js";
import { BrowserDaemonError } from "../src/browser-daemon-client.js";
import type { Env } from "../src/env.js";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

const OWNER_CO = "b1700000-0000-4000-8000-000000000001";
const OTHER_CO = "b1700000-0000-4000-8000-000000000002";
const OWNER = "b1700000-0000-4000-8000-000000000011";
const ADMIN = "b1700000-0000-4000-8000-000000000012";
const MEMBER = "b1700000-0000-4000-8000-000000000013";
const OTHER_OWNER = "b1700000-0000-4000-8000-000000000014";
const AGENT = "b1700000-0000-4000-8000-000000000021";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** `null`: no browserLive saved at all. */
async function cockpit(setting: unknown = "view") {
  const harness = createTestHarness({ manifest, config: setting === null ? {} : { browserLive: setting } });
  const at = new Date().toISOString();
  const member = (companyId: string, userId: string, role: string) => ({ id: `m-${companyId}-${userId}`, companyId, principalType: "user" as const, principalId: userId, status: "active" as const, membershipRole: role, grants: [], createdAt: at, updatedAt: at });
  harness.seed({
    companies: [{ id: OWNER_CO, name: "Partners in Biz", issuePrefix: "PAR" } as never, { id: OTHER_CO, name: "Client", issuePrefix: "CLI" } as never],
    accessMembers: [member(OWNER_CO, OWNER, "owner"), member(OWNER_CO, ADMIN, "admin"), member(OWNER_CO, MEMBER, "member"), member(OTHER_CO, OTHER_OWNER, "owner")],
  });
  await plugin.definition.setup(harness.ctx);
  const person = (userId: string, companyId = OWNER_CO) => ({ companyId, actor: { type: "user" as const, userId, companyId } });
  const ticket = (as: ReturnType<typeof person> | { companyId: string; actor: Record<string, unknown> }, params: Record<string, unknown> = { mode: "view" }) =>
    harness.performAction<{ ticket: string; mode: string; expiresAt: string }>("browser.live.ticket", params, as as never);
  const route = (query: Record<string, string>, actor: Partial<PluginApiRequestInput["actor"]> = { actorType: "user", actorId: OWNER, userId: OWNER }, companyId = OWNER_CO) =>
    plugin.definition.onApiRequest!({
      routeKey: "browser-live", method: "GET", path: "/browser/live", params: {}, query: { companyId, ...query }, body: null,
      actor: { actorType: "user", actorId: "", ...actor } as PluginApiRequestInput["actor"], companyId, headers: {},
    });
  return { harness, person, ticket, route };
}

const refusal = { status: BROWSER_LIVE_REFUSAL.status, body: BROWSER_LIVE_REFUSAL.body };

describe("readBrowserLiveSetting (fail closed)", () => {
  const env = (get: () => Promise<unknown>) => ({ ctx: { config: { get }, logger: { warn: () => undefined } } }) as unknown as Env;
  it.each([
    [{ browserLive: "view" }, "view"], [{ browserLive: "takeover" }, "takeover"], [{ browserLive: "off" }, "off"],
    [{}, "off"], [null, "off"], [{ browserLive: "VIEW" }, "off"], [{ browserLive: true }, "off"],
  ])("%j -> %s", async (config, expected) => {
    expect(await readBrowserLiveSetting(env(async () => config), OWNER_CO)).toBe(expected);
  });
  it("answers off when the read throws", async () => {
    expect(await readBrowserLiveSetting(env(async () => { throw new Error("host down"); }), OWNER_CO)).toBe("off");
  });
  it("the manifest setting defaults to off", () => {
    const schema = manifest.instanceConfigSchema as { properties: Record<string, { enum?: string[]; default?: string }> };
    expect(schema.properties.browserLive).toMatchObject({ enum: ["off", "view", "takeover"], default: "off" });
  });
});

describe("browser.live.ticket", () => {
  it("gives the owner and an admin of the owner company a 30-second view ticket", async () => {
    const { ticket, person } = await cockpit();
    for (const user of [OWNER, ADMIN]) {
      const now = Date.now();
      const out = await ticket(person(user));
      expect(out.mode).toBe("view");
      expect(out.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Date.parse(out.expiresAt) - now).toBeGreaterThan(TICKET_TTL_MS - 1000);
      expect(Date.parse(out.expiresAt) - now).toBeLessThanOrEqual(TICKET_TTL_MS + 50);
    }
  });

  it("does not contact the daemon", async () => {
    vi.stubEnv("PIB_BROWSER_LIVE_SOCKET", "/nonexistent/should-not-be-touched.sock");
    const { ticket, person, harness } = await cockpit();
    await ticket(person(OWNER));
    expect(harness.logs.map((l) => l.message).join("\n")).not.toMatch(/browser service/i);
  });

  it.each([
    ["a member who is not admin", { companyId: OWNER_CO, actor: { type: "user", userId: MEMBER, companyId: OWNER_CO } }, /owner or admin/],
    ["another company's owner, in that company", { companyId: OTHER_CO, actor: { type: "user", userId: OTHER_OWNER, companyId: OTHER_CO } }, /owner company/],
    ["an agent run acting for the owner", { companyId: OWNER_CO, actor: { type: "agent", agentId: AGENT, runId: "run-1", companyId: OWNER_CO, onBehalfOfUserId: OWNER } }, /signed-in person/],
    ["an agent key acting for the owner", { companyId: OWNER_CO, actor: { type: "agent", agentId: AGENT, companyId: OWNER_CO, onBehalfOfUserId: OWNER } }, /signed-in person/],
    ["an agent context that also carries the owner's user id", { companyId: OWNER_CO, actor: { type: "agent", agentId: AGENT, userId: OWNER, companyId: OWNER_CO } }, /signed-in person/],
    ["the local board user (board with no person)", { companyId: OWNER_CO, actor: { type: "user", userId: "local-board", companyId: OWNER_CO } }, /signed-in person/],
    ["a system caller", { companyId: OWNER_CO, actor: { type: "system", companyId: OWNER_CO } }, /signed-in person/],
  ])("refuses %s", async (_label, as, reason) => {
    const { ticket } = await cockpit();
    await expect(ticket(as)).rejects.toThrow(reason);
  });

  it("refuses any mode but view or control (control: browser-takeover.spec.ts)", async () => {
    const { ticket, person } = await cockpit("takeover");
    await expect(ticket(person(OWNER), { mode: "edit" })).rejects.toThrow("mode must be view or control");
    await expect(ticket(person(OWNER), {})).rejects.toThrow("mode must be view or control");
  });

  it("refuses at off, with the setting missing, and when the setting read throws", async () => {
    for (const setting of ["off", null]) {
      const { ticket, person } = await cockpit(setting);
      await expect(ticket(person(OWNER))).rejects.toThrow("turned off");
    }
    const { ticket, person, harness } = await cockpit();
    vi.spyOn(harness.ctx.config, "get").mockRejectedValue(new Error("host down"));
    await expect(ticket(person(OWNER))).rejects.toThrow("turned off");
  });

  it("refuses when the person's role cannot be read", async () => {
    const { ticket, person, harness } = await cockpit();
    vi.spyOn(harness.ctx.access.members, "list").mockRejectedValue(new Error("host down"));
    await expect(ticket(person(OWNER))).rejects.toThrow("Cannot verify your role");
  });
});

describe("GET /browser/live (websocket route, worker half)", () => {
  it("redeems the owner's ticket once: the daemon's local socket, view mode, and one activity record with no ticket in it", async () => {
    const { ticket, person, route, harness } = await cockpit();
    const { ticket: t } = await ticket(person(OWNER));
    expect(await route({ ticket: t })).toEqual({ websocket: { local: { socket: "/run/pib-browser/live.sock", path: "/stream?mode=view" } } });
    const inserts = harness.dbExecutes.filter((q) => q.sql.includes(".activity"));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.params).toEqual(expect.arrayContaining([OWNER_CO, "browser_live", `Watch live started by user ${OWNER}`]));
    expect(JSON.stringify(inserts[0]!.params)).not.toContain(t);
    expect(JSON.stringify(harness.logs)).not.toContain(t);
    // Used.
    expect(await route({ ticket: t })).toEqual(refusal);
  });

  it("uses PIB_BROWSER_LIVE_SOCKET when set, as the daemon does", async () => {
    vi.stubEnv("PIB_BROWSER_LIVE_SOCKET", "/run/test/live.sock");
    const { ticket, person, route } = await cockpit();
    const { ticket: t } = await ticket(person(ADMIN));
    expect(await route({ ticket: t }, { actorType: "user", actorId: ADMIN, userId: ADMIN })).toMatchObject({ websocket: { local: { socket: "/run/test/live.sock" } } });
  });

  it("every refusal is the unknown-ticket answer, and a refused ticket is spent", async () => {
    const { ticket, person, route, harness } = await cockpit();
    const fresh = async (user = OWNER) => (await ticket(person(user))).ticket;
    const answers: Array<[string, unknown]> = [];
    answers.push(["unknown ticket", await route({ ticket: "x".repeat(43) })]);
    answers.push(["no ticket", await route({})]);
    answers.push(["an over-long ticket", await route({ ticket: "x".repeat(500) })]);
    const others = await fresh(ADMIN);
    answers.push(["another user's ticket", await route({ ticket: others })]);
    answers.push(["that ticket again, now by its own user", await route({ ticket: others }, { actorType: "user", actorId: ADMIN, userId: ADMIN })]);
    answers.push(["a member who is not admin", await route({ ticket: await fresh() }, { actorType: "user", actorId: MEMBER, userId: MEMBER })]);
    answers.push(["an agent run acting for the owner", await route({ ticket: await fresh() }, { actorType: "agent", actorId: AGENT, agentId: AGENT, runId: "run-1", onBehalfOfUserId: OWNER })]);
    answers.push(["the local board user", await route({ ticket: await fresh() }, { actorType: "user", actorId: "local-board", userId: "local-board" })]);
    answers.push(["another company (owner's ticket)", await route({ ticket: await fresh() }, undefined, OTHER_CO)]);
    answers.push(["another company's owner in that company", await route({ ticket: await fresh() }, { actorType: "user", actorId: OTHER_OWNER, userId: OTHER_OWNER }, OTHER_CO)]);
    for (const [label, answer] of answers) expect(answer, label).toEqual(refusal);
    expect(harness.dbExecutes.filter((q) => q.sql.includes(".activity"))).toHaveLength(0);
  });

  it("re-checks the role at redemption: an owner demoted after the ticket is refused", async () => {
    const { ticket, person, route, harness } = await cockpit();
    const { ticket: t } = await ticket(person(OWNER));
    const at = new Date().toISOString();
    harness.seed({ accessMembers: [{ id: `m-${OWNER_CO}-${OWNER}`, companyId: OWNER_CO, principalType: "user", principalId: OWNER, status: "active", membershipRole: "member", grants: [], createdAt: at, updatedAt: at }] });
    expect(await route({ ticket: t })).toEqual(refusal);
  });

  it("a ticket only opens the company it was issued in, even where a second company also passes the owner check", async () => {
    const { ticket, person, route, harness } = await cockpit();
    const SECOND = "b1700000-0000-4000-8000-000000000003";
    const at = new Date().toISOString();
    harness.seed({
      companies: [{ id: SECOND, name: "Second", issuePrefix: "PAR" } as never],
      accessMembers: [{ id: `m-${SECOND}-${OWNER}`, companyId: SECOND, principalType: "user", principalId: OWNER, status: "active", membershipRole: "owner", grants: [], createdAt: at, updatedAt: at }],
    });
    const { ticket: t } = await ticket(person(OWNER));
    expect(await route({ ticket: t }, undefined, SECOND)).toEqual(refusal);
  });

  it("refuses an expired ticket", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { ticket, person, route } = await cockpit();
    const { ticket: t } = await ticket(person(OWNER));
    vi.setSystemTime(Date.now() + TICKET_TTL_MS + 1);
    expect(await route({ ticket: t })).toEqual(refusal);
  });

  it("refuses at off and when the setting read throws (the ticket was issued under view)", async () => {
    {
      const { ticket, person, route, harness } = await cockpit();
      const { ticket: t } = await ticket(person(OWNER));
      harness.setConfig({ browserLive: "off" });
      expect(await route({ ticket: t })).toEqual(refusal);
    }
    {
      const { ticket, person, route, harness } = await cockpit();
      const { ticket: t } = await ticket(person(OWNER));
      vi.spyOn(harness.ctx.config, "get").mockRejectedValue(new Error("host down"));
      expect(await route({ ticket: t })).toEqual(refusal);
    }
  });

  it("refuses when the activity record cannot be written: no record, no stream", async () => {
    const { ticket, person, route, harness } = await cockpit();
    const { ticket: t } = await ticket(person(OWNER));
    vi.spyOn(harness.ctx.db, "execute").mockRejectedValue(new Error("db down"));
    expect(await route({ ticket: t })).toEqual(refusal);
  });
});

describe("browser.live.status", () => {
  it("passes the daemon's /status through at every setting, and says when the daemon is not reachable", async () => {
    vi.stubEnv("PIB_BROWSER_LIVE_SOCKET", "/nonexistent/live.sock");
    for (const setting of ["off", "view", "takeover"]) {
      const { harness, person } = await cockpit(setting);
      expect(await harness.performAction("browser.live.status", {}, person(OWNER))).toEqual({ reachable: false, status: null, reason: "unreachable" });
    }
    const { harness } = await cockpit();
    const status = { viewers: 1, agentSessions: [], lease: null, waiting: [] };
    const env = { ctx: harness.ctx, now: () => new Date() } as unknown as Env;
    const context = { companyId: OWNER_CO, actor: { type: "user", userId: OWNER, agentId: null, runId: null, companyId: OWNER_CO } } as const;
    expect(await loadBrowserLiveStatus(env, context, async () => status)).toEqual({ reachable: true, status });
    expect(await loadBrowserLiveStatus(env, context, async () => { throw new BrowserDaemonError("x", "timeout"); })).toEqual({ reachable: false, status: null, reason: "timeout" });
  });

  it.each([
    ["a member who is not admin", { companyId: OWNER_CO, actor: { type: "user", userId: MEMBER, companyId: OWNER_CO } }],
    ["another company's owner", { companyId: OTHER_CO, actor: { type: "user", userId: OTHER_OWNER, companyId: OTHER_CO } }],
    ["an agent run acting for the owner", { companyId: OWNER_CO, actor: { type: "agent", agentId: AGENT, runId: "run-1", companyId: OWNER_CO, onBehalfOfUserId: OWNER } }],
    ["the local board user", { companyId: OWNER_CO, actor: { type: "user", userId: "local-board", companyId: OWNER_CO } }],
  ])("refuses %s", async (_label, as) => {
    const { harness } = await cockpit();
    await expect(harness.performAction("browser.live.status", {}, as as never)).rejects.toThrow();
  });
});

describe("browser.status carries the Watch live setting for the Browser tab", () => {
  const live = async (setting: unknown, as: Parameters<Awaited<ReturnType<typeof cockpit>>["ticket"]>[0]) => {
    const { harness } = await cockpit(setting);
    return (await harness.performAction<{ live: string }>("browser.status", {}, as as never)).live;
  };
  it("is the setting for an owner or admin of the owner company", async () => {
    const { person } = await cockpit();
    expect(await live("view", person(OWNER))).toBe("view");
    expect(await live("takeover", person(ADMIN))).toBe("takeover");
  });
  it("is off at off, with nothing saved, for a member, an agent and the local board", async () => {
    const { person } = await cockpit();
    expect(await live("off", person(OWNER))).toBe("off");
    expect(await live(null, person(OWNER))).toBe("off");
    expect(await live("view", person(MEMBER))).toBe("off");
    expect(await live("view", { companyId: OWNER_CO, actor: { type: "agent", agentId: AGENT, userId: OWNER, companyId: OWNER_CO } })).toBe("off");
    expect(await live("view", person("local-board"))).toBe("off");
  });
});

describe("browser.live.sessions (the Watch live chip)", () => {
  const NOW = new Date("2026-11-26T12:00:00Z");
  const row = (over: Record<string, unknown> = {}) => ({ agentId: AGENT, identity: "pib:paperclip", companyId: OWNER_CO, issue: "PAR-1", lastActiveAt: NOW.getTime() - 1000, ...over });
  const run = async (setting: unknown, who: string, rows: unknown[], at = NOW) => {
    const { harness, person } = await cockpit(setting);
    const env = { ctx: harness.ctx, now: () => at } as unknown as Env;
    return loadBrowserLiveSessions(env, person(who) as never, async () => ({ sessions: rows }));
  };

  it("lists this company's fresh sessions with agent, identity and issue only", async () => {
    const rows = [row(), row({ agentId: "other", companyId: OTHER_CO }), row({ lastActiveAt: NOW.getTime() - 120_000, agentId: "stale" }), row({ identity: "bad identity", agentId: "bad" })];
    expect(await run("view", OWNER, rows)).toEqual({ sessions: [{ agentId: AGENT, identity: "pib:paperclip", issue: "PAR-1" }] });
  });
  it("answers no sessions (not an error) for a member, when off, and when the daemon fails", async () => {
    expect(await run("view", MEMBER, [row()])).toEqual({ sessions: [] });
    expect(await run("off", OWNER, [row()])).toEqual({ sessions: [] });
    const { harness, person } = await cockpit("view");
    const env = { ctx: harness.ctx, now: () => NOW } as unknown as Env;
    expect(await loadBrowserLiveSessions(env, person(OWNER) as never, async () => { throw new BrowserDaemonError("x", "timeout"); })).toEqual({ sessions: [] });
  });
  it("asks the daemon once inside the cache window", async () => {
    const { harness, person } = await cockpit("view");
    let now = NOW.getTime();
    const env = { ctx: harness.ctx, now: () => new Date(now) } as unknown as Env;
    const read = vi.fn(async () => ({ sessions: [] }));
    await loadBrowserLiveSessions(env, person(OWNER) as never, read);
    await loadBrowserLiveSessions(env, person(ADMIN) as never, read);
    expect(read).toHaveBeenCalledTimes(1);
    now += 4000;
    await loadBrowserLiveSessions(env, person(OWNER) as never, read);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("the ticket takes only a valid identity", async () => {
    const { ticket, person } = await cockpit("view");
    await expect(ticket(person(OWNER), { mode: "view", identity: "pib:paperclip" })).resolves.toMatchObject({ mode: "view" });
    await expect(ticket(person(OWNER), { mode: "view", identity: "../etc:passwd" })).rejects.toThrow();
  });
});
