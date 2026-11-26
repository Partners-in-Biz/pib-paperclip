/**
 * Take over and resume (PAR-14514 S4) on the real Cockpit worker (sdk harness) against a fake pib-browser daemon on a
 * temp unix socket: the control ticket and route, Done (verify, card, wake exactly the waiting tasks that pass the
 * checks, clear), a failed check, the per-identity lock, Stop, every setting, and the setting switch.
 * The same handlers behind the real core action route and auth middleware: server/src/__tests__/cockpit-browser-live-routes.test.ts.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Issue, PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BROWSER_LIVE_REFUSAL } from "../src/browser-live.js";
import { browserLiveConfigChanged, SESSION_RESTORED_REASON } from "../src/browser-takeover.js";
import { browserLoginEffectKey } from "../src/credentials.js";
import type { Env } from "../src/env.js";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

const OWNER_CO = "b1700000-0000-4000-8000-000000000001";
const OTHER_CO = "b1700000-0000-4000-8000-000000000002";
const OWNER = "b1700000-0000-4000-8000-000000000011";
const ADMIN = "b1700000-0000-4000-8000-000000000012";
const MEMBER = "b1700000-0000-4000-8000-000000000013";
const AGENT = "b1700000-0000-4000-8000-000000000021";
const IDENTITY = "pib:meta";

// ---------------------------------------------------------------------------
// Fake daemon: /status, /release, /waiting/clear (the unsigned calls), on a temp socket
// ---------------------------------------------------------------------------

const dir = mkdtempSync(path.join(tmpdir(), "cockpit-takeover-"));
const socketPath = path.join(dir, "live.sock");
const daemon = {
  release: { ok: true, reason: "logged_in" },
  releaseDelayMs: 0,
  /** The daemon answers the clear but keeps the entries (a lost write). */
  dropClear: false,
  lease: null as unknown,
  viewers: 0,
  waiting: [] as Array<{ identity: string; issue: string; reason: string; at: string }>,
  calls: [] as Array<{ path: string; body: unknown }>,
};
let server: Server;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", async () => {
      const body = raw ? JSON.parse(raw) : null;
      daemon.calls.push({ path: `${req.method} ${req.url}`, body });
      const send = (code: number, value: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
      if (req.method === "GET" && req.url === "/status") return send(200, { viewers: daemon.viewers, agentSessions: [], sessions: [], lease: daemon.lease, waiting: daemon.waiting });
      if (req.method === "POST" && req.url === "/release") {
        if (daemon.releaseDelayMs) await new Promise((r) => setTimeout(r, daemon.releaseDelayMs));
        const identity = body.identity;
        return send(200, { ...daemon.release, waiting: daemon.waiting.filter((w) => w.identity === identity) });
      }
      if (req.method === "POST" && req.url === "/waiting/clear") {
        const before = daemon.waiting.length;
        if (!daemon.dropClear) daemon.waiting = daemon.waiting.filter((w) => !(w.identity === body.identity && body.issues.includes(w.issue)));
        return send(200, { ok: true, removed: before - daemon.waiting.length });
      }
      send(404, {});
    });
  });
  server.listen(socketPath);
  await once(server, "listening");
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  vi.stubEnv("PIB_BROWSER_LIVE_SOCKET", socketPath);
  daemon.release = { ok: true, reason: "logged_in" };
  daemon.releaseDelayMs = 0;
  daemon.dropClear = false;
  daemon.lease = null;
  daemon.viewers = 0;
  daemon.waiting = [];
  daemon.calls = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// The worker on the harness
// ---------------------------------------------------------------------------

const at = new Date().toISOString();
function issue(n: number, over: Partial<Issue> = {}): Issue {
  return { id: `b1700000-0000-4000-8000-0000000009${String(n).padStart(2, "0")}`, identifier: `PAR-${n}`, companyId: OWNER_CO, title: `Task ${n}`, status: "blocked", assigneeAgentId: AGENT, createdAt: at, updatedAt: at, ...over } as Issue;
}

async function cockpit(setting: unknown = "takeover", issues: Issue[] = []) {
  const harness = createTestHarness({ manifest, config: { browserLive: setting } });
  const member = (companyId: string, userId: string, role: string) => ({ id: `m-${companyId}-${userId}`, companyId, principalType: "user" as const, principalId: userId, status: "active" as const, membershipRole: role, grants: [], createdAt: at, updatedAt: at });
  harness.seed({
    companies: [{ id: OWNER_CO, name: "Partners in Biz", issuePrefix: "PAR" } as never, { id: OTHER_CO, name: "Client", issuePrefix: "CLI" } as never],
    accessMembers: [member(OWNER_CO, OWNER, "owner"), member(OWNER_CO, ADMIN, "admin"), member(OWNER_CO, MEMBER, "member")],
    issues,
  });
  await plugin.definition.setup(harness.ctx);
  const person = (userId: string, companyId = OWNER_CO) => ({ companyId, actor: { type: "user" as const, userId, companyId } });
  const act = <T = Record<string, unknown>>(key: string, params: Record<string, unknown>, as: unknown = person(OWNER)) => harness.performAction<T>(key, params, as as never);
  const route = (query: Record<string, string>, userId = OWNER) =>
    plugin.definition.onApiRequest!({
      routeKey: "browser-live", method: "GET", path: "/browser/live", params: {}, query: { companyId: OWNER_CO, ...query }, body: null,
      actor: { actorType: "user", actorId: userId, userId } as PluginApiRequestInput["actor"], companyId: OWNER_CO, headers: {},
    });
  const comments = vi.spyOn(harness.ctx.issues, "createComment");
  const wakes = vi.spyOn(harness.ctx.issues, "requestWakeup");
  const activity = () => harness.dbExecutes.filter((q) => q.sql.includes(".activity")).map((q) => String(q.params?.[4]));
  return { harness, person, act, route, comments, wakes, activity };
}

const waitingFor = (...issues: string[]) => issues.map((i, n) => ({ identity: IDENTITY, issue: i, reason: "session_expired", at: `2026-11-26T10:0${n}:00.000Z` }));

describe("browser.live.ticket and the route, mode control", () => {
  it("gives a control ticket at takeover; the route returns the control stream for that identity and records the start", async () => {
    const { act, route, activity } = await cockpit("takeover");
    const { ticket } = await act<{ ticket: string; mode: string }>("browser.live.ticket", { mode: "control", identity: IDENTITY });
    expect(await route({ ticket })).toEqual({ websocket: { local: { socket: socketPath, path: `/stream?mode=control&identity=${IDENTITY}` } } });
    expect(activity()).toEqual([`Take-over started by user ${OWNER} (identity ${IDENTITY})`]);
    // A reconnect (the 5-minute proxy end) is recorded as one, not as a second start.
    const again = await act<{ ticket: string }>("browser.live.ticket", { mode: "control", identity: IDENTITY });
    await route({ ticket: again.ticket });
    expect(activity()[1]).toBe(`Take-over stream reconnected by user ${OWNER} (identity ${IDENTITY})`);
    // The worker never asked the daemon for a lease.
    expect(daemon.calls).toEqual([]);
  });

  it("refuses control at off and at view, and without an identity", async () => {
    for (const [setting, words] of [["off", /turned off/], ["view", /not turned on/]] as const) {
      const { act } = await cockpit(setting);
      await expect(act("browser.live.ticket", { mode: "control", identity: IDENTITY })).rejects.toThrow(words);
    }
    const { act } = await cockpit("takeover");
    await expect(act("browser.live.ticket", { mode: "control" })).rejects.toThrow(/identity/);
    await expect(act("browser.live.ticket", { mode: "control", identity: "bad identity" })).rejects.toThrow(/identity/);
  });

  it("refuses a member, an agent acting for the owner and the local board (the S3 caller checks)", async () => {
    const { act } = await cockpit("takeover");
    for (const as of [
      { companyId: OWNER_CO, actor: { type: "user", userId: MEMBER, companyId: OWNER_CO } },
      { companyId: OWNER_CO, actor: { type: "agent", agentId: AGENT, runId: "run-1", companyId: OWNER_CO, onBehalfOfUserId: OWNER } },
      { companyId: OWNER_CO, actor: { type: "user", userId: "local-board", companyId: OWNER_CO } },
    ]) await expect(act("browser.live.ticket", { mode: "control", identity: IDENTITY }, as)).rejects.toThrow();
  });

  it("a control ticket issued at takeover is refused at the route once the setting is view", async () => {
    const { act, route, harness } = await cockpit("takeover");
    const { ticket } = await act<{ ticket: string }>("browser.live.ticket", { mode: "control", identity: IDENTITY });
    harness.setConfig({ browserLive: "view" });
    expect(await route({ ticket })).toEqual({ status: BROWSER_LIVE_REFUSAL.status, body: BROWSER_LIVE_REFUSAL.body });
  });
});

describe("browser.takeover.done", () => {
  it("check ok: marks verified, closes the card, wakes exactly the waiting tasks that pass, one comment each, no status change, then clears", async () => {
    const tasks = [
      issue(1),                                                  // blocked, agent: woken
      issue(2, { status: "in_progress" }),                       // in progress: woken
      issue(3, { status: "done" }),                              // done: untouched
      issue(4, { blockedBy: [{ id: issue(9).id }] } as never),   // open blocker: untouched
      issue(5, { assigneeAgentId: null }),                       // no agent: untouched
      issue(6, { companyId: OTHER_CO, identifier: "CLI-6" }),    // another company: untouched
      issue(7, { status: "todo" }),                              // not blocked / in progress: untouched
      issue(9, { status: "in_progress", assigneeAgentId: null }),
    ];
    const { act, comments, wakes, activity, harness } = await cockpit("takeover", tasks);
    const queries = vi.spyOn(harness.ctx.db, "query");
    daemon.waiting = [...waitingFor("PAR-1", "PAR-2", "PAR-3", "PAR-4", "PAR-5", "CLI-6", "PAR-7", "PAR-404"), { identity: "pib:other", issue: "PAR-9", reason: "session_expired", at }];
    const out = await act<{ ok: boolean; woken: string[]; message: string }>("browser.takeover.done", { identity: IDENTITY });

    expect(out.ok).toBe(true);
    expect(out.woken).toEqual(["PAR-1", "PAR-2"]);
    expect(comments.mock.calls.map((c) => [c[0], c[1]])).toEqual([[issue(1).id, "Browser login for pib:meta works again."], [issue(2).id, "Browser login for pib:meta works again."]]);
    expect(wakes.mock.calls.map((c) => [c[0], c[2]?.reason])).toEqual([[issue(1).id, SESSION_RESTORED_REASON], [issue(2).id, SESSION_RESTORED_REASON]]);
    // No status change on any task.
    for (const t of tasks) expect((await harness.ctx.issues.get(t.id, t.companyId))?.status).toBe(t.status);
    // Register row marked verified (upsert on the browser seed key).
    const verified = harness.dbExecutes.find((q) => q.sql.includes(".credentials") && q.sql.includes("'ok'"));
    expect(verified?.params).toEqual(expect.arrayContaining([OWNER_CO, `browser:${IDENTITY}`]));
    // The identity's open "Log in again" card is looked up to be closed (resolveOpenCockpitAsks).
    expect(queries.mock.calls.some(([sql, params]) => sql.includes("effect ->> 'key'") && JSON.stringify(params) === JSON.stringify([OWNER_CO, browserLoginEffectKey(IDENTITY)]))).toBe(true);
    // The other identity's entry and the unreadable PAR-404 (not found) are handled as the rules say: only this identity cleared.
    expect(daemon.calls.map((c) => c.path)).toEqual(["POST /release", "POST /waiting/clear"]);
    expect(daemon.waiting.map((w) => w.issue)).toEqual(["PAR-9"]);
    expect(activity()).toEqual([
      `Take-over for ${IDENTITY} ended: Done by user ${OWNER}`,
      `Browser session check for ${IDENTITY}: logged in (logged_in)`,
      `Woke PAR-1: browser login for ${IDENTITY} restored by user ${OWNER}`,
      `Woke PAR-2: browser login for ${IDENTITY} restored by user ${OWNER}`,
    ]);
  });

  it("check failed: tells the person, wakes nothing, clears nothing, keeps the card", async () => {
    const { act, comments, wakes, activity } = await cockpit("takeover", [issue(1)]);
    daemon.release = { ok: false, reason: "session_expired" };
    daemon.waiting = waitingFor("PAR-1");
    const out = await act<{ ok: boolean; message: string }>("browser.takeover.done", { identity: IDENTITY });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/did not hold.*Nothing was woken/);
    expect(comments).not.toHaveBeenCalled();
    expect(wakes).not.toHaveBeenCalled();
    expect(daemon.waiting).toHaveLength(1);
    expect(activity()[1]).toBe(`Browser session check for ${IDENTITY}: not logged in (session_expired)`);
  });

  it("a double submit (two admins at once) gives one comment and one wake per task", async () => {
    const { act, person, comments, wakes, harness } = await cockpit("takeover", [issue(1), issue(2)]);
    daemon.waiting = waitingFor("PAR-1", "PAR-2");
    daemon.releaseDelayMs = 50;
    // Host reads are RPCs in production (they yield to I/O), so the two Done runs would interleave without the lock.
    const get = harness.ctx.issues.get.bind(harness.ctx.issues);
    vi.spyOn(harness.ctx.issues, "get").mockImplementation(async (...args) => { await new Promise((r) => setTimeout(r, 10)); return get(...args); });
    const [a, b] = await Promise.all([
      act<{ woken: string[] }>("browser.takeover.done", { identity: IDENTITY }, person(OWNER)),
      act<{ woken: string[] }>("browser.takeover.done", { identity: IDENTITY }, person(ADMIN)),
    ]);
    expect([...a.woken, ...b.woken].sort()).toEqual(["PAR-1", "PAR-2"]);
    expect(comments).toHaveBeenCalledTimes(2);
    expect(wakes).toHaveBeenCalledTimes(2);
  });

  it("an entry already handled is not woken again even when clearing it on the daemon failed", async () => {
    const { act, comments, wakes } = await cockpit("takeover", [issue(1)]);
    daemon.waiting = waitingFor("PAR-1");
    daemon.dropClear = true;
    await act("browser.takeover.done", { identity: IDENTITY });
    await act("browser.takeover.done", { identity: IDENTITY });
    expect(comments).toHaveBeenCalledTimes(1);
    expect(wakes).toHaveBeenCalledTimes(1);
    // The second Done asks the daemon to clear it again.
    expect(daemon.calls.filter((c) => c.path === "POST /waiting/clear")).toHaveLength(2);
  });

  it("done and stop work at every setting, including off", async () => {
    for (const setting of ["off", "view", "takeover"]) {
      const { act } = await cockpit(setting, [issue(1)]);
      daemon.waiting = waitingFor("PAR-1");
      await expect(act("browser.takeover.done", { identity: IDENTITY })).resolves.toMatchObject({ ok: true, woken: ["PAR-1"] });
      await expect(act("browser.takeover.stop", { identity: IDENTITY })).resolves.toMatchObject({ message: expect.stringMatching(/Nothing was woken/) });
    }
  });

  it("refuses a member, an agent acting for the owner, the local board, and a bad identity; the daemon is never called", async () => {
    const { act } = await cockpit("takeover", [issue(1)]);
    for (const key of ["browser.takeover.done", "browser.takeover.stop", "browser.takeover.waiting"]) {
      for (const as of [
        { companyId: OWNER_CO, actor: { type: "user", userId: MEMBER, companyId: OWNER_CO } },
        { companyId: OWNER_CO, actor: { type: "agent", agentId: AGENT, runId: "run-1", companyId: OWNER_CO, onBehalfOfUserId: OWNER } },
        { companyId: OWNER_CO, actor: { type: "user", userId: "local-board", companyId: OWNER_CO } },
        { companyId: OTHER_CO, actor: { type: "user", userId: OWNER, companyId: OTHER_CO } },
      ]) await expect(act(key, { identity: IDENTITY }, as), key).rejects.toThrow();
      await expect(act(key, { identity: "../x" })).rejects.toThrow(/identity/);
    }
    expect(daemon.calls).toEqual([]);
  });

  it("says so when the daemon is not running, and wakes nothing", async () => {
    vi.stubEnv("PIB_BROWSER_LIVE_SOCKET", path.join(dir, "nobody.sock"));
    const { act, wakes } = await cockpit("takeover", [issue(1)]);
    await expect(act("browser.takeover.done", { identity: IDENTITY })).rejects.toThrow(/not running.*Nothing was woken/);
    expect(wakes).not.toHaveBeenCalled();
  });
});

describe("browser.takeover.stop and .waiting", () => {
  it("stop releases and wakes nothing, even with tasks waiting and the login ok", async () => {
    const { act, comments, wakes, activity } = await cockpit("takeover", [issue(1)]);
    daemon.waiting = waitingFor("PAR-1");
    const out = await act<{ ok: boolean }>("browser.takeover.stop", { identity: IDENTITY });
    expect(out.ok).toBe(true);
    expect(daemon.calls.map((c) => [c.path, c.body])).toEqual([["POST /release", { identity: IDENTITY }]]);
    expect(comments).not.toHaveBeenCalled();
    expect(wakes).not.toHaveBeenCalled();
    expect(daemon.waiting).toHaveLength(1);
    expect(activity()[0]).toBe(`Take-over for ${IDENTITY} ended: Stop by user ${OWNER}`);
  });

  it("waiting names the tasks Done would wake, and writes nothing", async () => {
    const { act, comments, harness } = await cockpit("takeover", [issue(1), issue(3, { status: "done" })]);
    daemon.waiting = waitingFor("PAR-1", "PAR-3");
    expect(await act("browser.takeover.waiting", { identity: IDENTITY })).toEqual({ tasks: [{ identifier: "PAR-1", title: "Task 1" }] });
    expect(comments).not.toHaveBeenCalled();
    expect(harness.dbExecutes).toHaveLength(0);
    expect(daemon.calls.map((c) => c.path)).toEqual(["GET /status"]);
  });
});

describe("setting change", () => {
  const run = async (setting: string, companyId: string | null = OWNER_CO) => {
    const { harness } = await cockpit(setting);
    await browserLiveConfigChanged({ ctx: harness.ctx, now: () => new Date() } as unknown as Env, { browserLive: setting }, companyId);
    return daemon.calls.filter((c) => c.path === "POST /release").map((c) => c.body);
  };
  it("off with a live take-over or a viewer releases everything", async () => {
    daemon.lease = { state: "live", identity: IDENTITY, userId: OWNER, secondsLeft: 600, controlConnected: true };
    expect(await run("off")).toEqual([{ all: true }]);
    daemon.calls = [];
    daemon.lease = null;
    daemon.viewers = 1;
    expect(await run("off")).toEqual([{ all: true }]);
  });
  it("off with nothing live leaves an unconfirmed take-over alone", async () => {
    daemon.lease = { state: "ended", confirmed: false, identity: IDENTITY, reason: "logged_in" };
    expect(await run("off")).toEqual([]);
  });
  it("view ends a live take-over only; takeover changes nothing; another company's setting is ignored", async () => {
    daemon.lease = { state: "live", identity: IDENTITY, userId: OWNER, secondsLeft: 600, controlConnected: true };
    expect(await run("view")).toEqual([{ identity: IDENTITY }]);
    daemon.calls = [];
    expect(await run("takeover")).toEqual([]);
    expect(await run("off", OTHER_CO)).toEqual([]);
  });
  it("never throws when the daemon is down", async () => {
    vi.stubEnv("PIB_BROWSER_LIVE_SOCKET", path.join(dir, "nobody.sock"));
    await expect(run("off")).resolves.toEqual([]);
  });
});
