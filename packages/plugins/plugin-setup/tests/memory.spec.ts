import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { isModuleEnabled, moduleOfPlugin, MODULE_KEYS, setupProgress, SETUP_PLUGIN, type SetupItem } from "../src/kit-setup.js";
import { finishSetupContent } from "../src/finish-issue.js";
import { guidedOrder, itemPhase } from "../src/guide.js";
import {
  MEMORY_ACTION,
  MEMORY_NOT_CHECKED,
  isMemoryAction,
  memorySetupParams,
  memoryStatus,
  parseWikiSnapshot,
  suggestWikiFolder,
  WIKI_PLUGIN,
  wikiSnapshotFrom,
  type WikiSnapshot,
} from "../src/memory.js";
import { allModulesOn, moduleRank, ORDERED_MODULES } from "../src/modules.js";
import { standInStatus } from "../src/status.js";
import { resolveModuleViews } from "../src/ui/data.js";
import { fetchWikiSnapshot, runMemorySetup } from "../src/ui/memory-client.js";
import { fakeCtx, fixedClock } from "./helpers/fake-ctx.js";
import { registerSetup } from "../src/register.js";
import { reportMemory } from "../src/service.js";

const CO = "11111111-2222-3333-4444-555555555555";
const INSTANCE = "/Users/x/.paperclip/instances/default";
const AGENT_ID = "aaaaaaaa-0000-0000-0000-000000000001";

const byKey = (items: SetupItem[]) => Object.fromEntries(items.map((item) => [item.key, item]));

function snapshot(overrides: Partial<WikiSnapshot> = {}): WikiSnapshot {
  return {
    checkedAt: "2026-09-27T10:00:00.000Z",
    folder: { configured: true, healthy: true, path: `${INSTANCE}/companies/${CO}/wiki`, problems: [] },
    agent: { id: AGENT_ID, name: "Wiki Maintainer", status: "idle", adapterType: "codex_local", urlKey: "wiki-maintainer" },
    peers: [{ id: "ceo", name: "Ada", adapterType: "codex_local", role: "ceo" }],
    routines: [
      { key: "cursor-window-processing", title: "Process LLM Wiki updates", routineId: "r1", status: "active", triggersEnabled: true },
      { key: "nightly-wiki-lint", title: "Run LLM Wiki lint", routineId: "r2", status: "active", triggersEnabled: true },
      { key: "index-refresh", title: "Refresh LLM Wiki index", routineId: "r3", status: "active", triggersEnabled: true },
    ],
    eventIngestion: { enabled: true, sources: { issues: true, comments: true, documents: false } },
    suggestedFolderPath: `${INSTANCE}/companies/${CO}/wiki`,
    ...overrides,
  };
}

const FRESH = snapshot({
  folder: { configured: false, healthy: false, path: null, problems: [] },
  agent: { id: null, name: null, status: null, adapterType: null, urlKey: null },
  routines: snapshot().routines!.map((r) => ({ ...r, routineId: null, status: null, triggersEnabled: null })),
  eventIngestion: { enabled: false, sources: { issues: false, comments: false, documents: false } },
});

describe("Company wiki module", () => {
  it("is a kit module for the LLM Wiki plugin, ranked right after Cockpit", () => {
    expect(MODULE_KEYS).toContain("memory");
    expect(moduleOfPlugin(WIKI_PLUGIN)).toBe("memory");
    expect(moduleOfPlugin("partnersinbiz.crm")).toBe("crm");
    expect(ORDERED_MODULES.slice(0, 4)).toEqual(["crm", "mailbox", "cockpit", "memory"]);
    expect(moduleRank("memory")).toBe(moduleRank("cockpit") + 1);
    expect(new Set(ORDERED_MODULES.map(moduleRank)).size).toBe(MODULE_KEYS.length);
  });

  it("switching memory off does not switch off any other plugin", async () => {
    const state = new Map<string, unknown>([["company:c1:pib-setup:modules", { companyId: "c1", modules: { ...allModulesOn(), memory: false }, updatedAt: "x" }]]);
    const ctx = { state: { get: async (key: { scopeKind: string; scopeId: string; namespace: string; stateKey: string }) => state.get(`${key.scopeKind}:${key.scopeId}:${key.namespace}:${key.stateKey}`) ?? null } } as unknown as PluginContext;
    expect(await isModuleEnabled(ctx, "c1", "partnersinbiz.crm")).toBe(true);
    expect(await isModuleEnabled(ctx, "c1", "partnersinbiz.cockpit")).toBe(true);
    expect(await isModuleEnabled(ctx, "c1", "some.other.plugin")).toBe(true);
    expect(await isModuleEnabled(ctx, "c1", WIKI_PLUGIN)).toBe(false);
  });
});

describe("snapshot from host responses", () => {
  const agents = [
    { id: AGENT_ID, name: "Wiki Maintainer", status: "paused", adapterType: "claude_local", urlKey: "wiki-maintainer", adapterConfig: {} },
    { id: "ops", name: "Operator", role: "general", status: "active", adapterType: "codex_local", adapterConfig: { instructionsFilePath: `${INSTANCE}/companies/${CO}/agents/ops/instructions/AGENTS.md` } },
    { id: "ceo", name: "Ada", role: "ceo", status: "idle", adapterType: "codex_local", adapterConfig: { env: { X: "y" } } },
    { id: "gone", name: "Old", status: "terminated", adapterType: "claude_local" },
  ];
  const settings = {
    data: {
      folder: { configured: true, healthy: false, path: "/srv/wiki", problems: [{ code: "missing_file", message: "AGENTS.md is missing" }] },
      managedAgent: { status: "resolved", agentId: AGENT_ID, details: { name: "Wiki Maintainer", status: "paused", adapterType: "claude_local", urlKey: "wiki-maintainer" } },
      managedRoutines: [
        { resourceKey: "cursor-window-processing", routineId: "r1", routine: { status: "paused" } },
        { resourceKey: "nightly-wiki-lint", routineId: "r2", routine: { status: "active" } },
        { resourceKey: "index-refresh", routineId: null, routine: null, status: "missing" },
      ],
      eventIngestion: { enabled: false, sources: { issues: false, comments: false, documents: false }, wikiId: "default", maxCharacters: 12000 },
    },
  };
  const routines = [
    { id: "r1", title: "Process LLM Wiki updates", status: "paused", triggers: [{ id: "t1", enabled: false }] },
    { id: "r2", title: "Run LLM Wiki lint", status: "active", triggers: [{ id: "t2", enabled: true }, { id: "t2b", enabled: false, archived: true }] },
  ];

  it("reads folder, agent (fresh from the company list), peers, routines and ingestion", () => {
    const snap = wikiSnapshotFrom({ companyId: CO, wiki: settings, agents, routines, now: new Date("2026-09-27T10:00:00.000Z") });
    expect(snap.folder).toEqual({ configured: true, healthy: false, path: "/srv/wiki", problems: ["AGENTS.md is missing"] });
    expect(snap.agent).toMatchObject({ id: AGENT_ID, status: "paused", adapterType: "claude_local", urlKey: "wiki-maintainer" });
    expect(snap.peers?.map((peer) => peer.name)).toEqual(["Ada", "Operator"]);
    expect(snap.routines).toEqual([
      { key: "cursor-window-processing", title: "Process LLM Wiki updates", routineId: "r1", status: "paused", triggersEnabled: false },
      { key: "nightly-wiki-lint", title: "Run LLM Wiki lint", routineId: "r2", status: "active", triggersEnabled: true },
      { key: "index-refresh", title: "Refresh LLM Wiki index", routineId: null, status: null, triggersEnabled: null },
    ]);
    expect(snap.eventIngestion?.enabled).toBe(false);
    expect(snap.suggestedFolderPath).toBe(`${INSTANCE}/companies/${CO}/wiki`);
  });

  it("works from /overview alone (no routines, no agents): unknown where it cannot see", () => {
    const snap = wikiSnapshotFrom({ companyId: CO, wiki: { folder: { configured: false, healthy: false, path: null, problems: [] }, managedAgent: { status: "missing", agentId: null, details: null } }, agents: null, routines: null });
    expect(snap.agent).toEqual({ id: null, name: null, status: null, adapterType: null, urlKey: null });
    expect(snap.routines).toBeNull();
    expect(snap.peers).toBeNull();
    expect(snap.eventIngestion).toBeNull();
    expect(snap.suggestedFolderPath).toBeNull();
  });

  it("finds the company folder in any adapter config string, or nothing", () => {
    expect(suggestWikiFolder([{ adapterConfig: { args: [`--instructions ${INSTANCE}/companies/${CO}/agents/a/AGENTS.md`] } }], CO)).toBe(`${INSTANCE}/companies/${CO}/wiki`);
    expect(suggestWikiFolder([{ adapterConfig: { p: `/My Drive/pc/companies/${CO}/x` } }], CO)).toBe(`/My Drive/pc/companies/${CO}/wiki`);
    expect(suggestWikiFolder([{ adapterConfig: { p: `${INSTANCE}/companies/other/x` } }], CO)).toBeNull();
    expect(suggestWikiFolder([{ adapterConfig: { p: `relative/companies/${CO}/x` } }], CO)).toBeNull();
    expect(suggestWikiFolder([{ adapterConfig: { p: `/a/../companies/${CO}/x` } }], CO)).toBeNull();
    expect(suggestWikiFolder([], CO)).toBeNull();
  });

  it("re-checks a snapshot sent by the page", () => {
    const snap = snapshot();
    expect(parseWikiSnapshot(JSON.parse(JSON.stringify(snap)))).toEqual(snap);
    expect(parseWikiSnapshot(null)).toBeNull();
    expect(parseWikiSnapshot("x")).toBeNull();
    const hostile = parseWikiSnapshot({ ...snap, suggestedFolderPath: "/x/../../etc", routines: [{ key: "nope", status: "active" }], checkedAt: "never" });
    expect(hostile?.suggestedFolderPath).toBeNull();
    expect(hostile?.routines?.every((routine) => routine.routineId === null)).toBe(true);
    expect(Number.isNaN(Date.parse(hostile!.checkedAt))).toBe(false);
  });
});

describe("snapshot → checklist", () => {
  it("everything set up: all required done, nothing missing", () => {
    const status = memoryStatus(snapshot());
    expect(status).toMatchObject({ plugin: WIKI_PLUGIN, module: "memory", title: "Company wiki", checkedAt: "2026-09-27T10:00:00.000Z" });
    expect(status.items.map((item) => [item.key, item.status, item.required])).toEqual([
      ["wiki_folder", "done", true],
      ["wiki_agent", "done", true],
      ["wiki_routines", "done", true],
      ["event_ingestion", "done", false],
    ]);
    expect(setupProgress(status.items)).toMatchObject({ done: 3, total: 3, missing: [] });
    const items = byKey(status.items);
    expect(items.wiki_agent!.href).toBe("/agents/wiki-maintainer");
    expect(items.event_ingestion!.detail).toBe("Recording issues, comments for the Maintainer.");
    for (const item of status.items) expect(item.agentNext).toBeTruthy();
  });

  it("unknown / unreachable: every item unknown with the reason, never a crash", () => {
    const status = memoryStatus(null, { reason: "LLM Wiki is not running." });
    expect(status.items.map((item) => item.status)).toEqual(["unknown", "unknown", "unknown", "unknown"]);
    expect(status.items.every((item) => item.detail === "LLM Wiki is not running.")).toBe(true);
    expect(setupProgress(status.items).missing).toHaveLength(3);
    expect(memoryStatus(null).items[0]!.detail).toMatch(/could not read/);
  });

  it("new company: one Do it for me sets up folder, routines and ingestion", () => {
    const items = byKey(memoryStatus(FRESH).items);
    const folder = items.wiki_folder!;
    expect(folder.status).toBe("missing");
    expect(folder.detail).toContain(`${INSTANCE}/companies/${CO}/wiki`);
    expect(folder.action).toEqual({ plugin: SETUP_PLUGIN, key: MEMORY_ACTION, label: "Set up company memory", params: { folderPath: `${INSTANCE}/companies/${CO}/wiki`, routines: true, ingestion: true } });
    expect(isMemoryAction(folder.action)).toBe(true);
    expect(items.wiki_agent).toMatchObject({ status: "missing", href: "/wiki/settings", action: { plugin: WIKI_PLUGIN, key: "reconcile-managed-agent" } });
    expect(isMemoryAction(items.wiki_agent!.action)).toBe(false);
    expect(items.wiki_routines).toMatchObject({ status: "missing", blockedBy: ["wiki_agent"], action: { key: MEMORY_ACTION, params: { routines: true } } });
    expect(items.wiki_routines!.detail).toContain("Not created yet: Process LLM Wiki updates (every 6 hours)");
    expect(items.event_ingestion).toMatchObject({ status: "optional", required: false, action: { key: MEMORY_ACTION, params: { ingestion: true } } });
  });

  it("no folder path to suggest: deep link and steps, no button", () => {
    const folder = byKey(memoryStatus({ ...FRESH, suggestedFolderPath: null }).items).wiki_folder!;
    expect(folder).toMatchObject({ status: "missing", action: null, href: "/wiki" });
    expect(folder.steps?.join(" ")).toContain("Configure & bootstrap");
  });

  it("folder configured but broken: repair at the same path", () => {
    const folder = byKey(memoryStatus(snapshot({ folder: { configured: true, healthy: false, path: "/srv/wiki", problems: ["AGENTS.md is missing"] } })).items).wiki_folder!;
    expect(folder.status).toBe("missing");
    expect(folder.detail).toBe("The wiki folder at /srv/wiki is not ready: AGENTS.md is missing");
    expect(folder.action).toMatchObject({ label: "Repair the wiki folder", params: { folderPath: "/srv/wiki" } });
  });

  it("maintainer paused on an adapter nobody else uses: person steps pointing at the CEO's adapter", () => {
    const agent = byKey(memoryStatus(snapshot({ agent: { id: AGENT_ID, name: "Wiki Maintainer", status: "paused", adapterType: "claude_local", urlKey: null } })).items).wiki_agent!;
    expect(agent.status).toBe("missing");
    expect(agent.detail).toContain("It uses claude_local, but the agents that run in this company use codex_local.");
    expect(agent.detail).toContain("paused");
    expect(agent.href).toBe(`/agents/${AGENT_ID}`);
    expect(agent.action ?? null).toBeNull();
    expect(agent.steps).toContain("Set the adapter to codex_local (what Ada, your CEO, uses) and pick the same model that agent uses.");
    expect(agent.steps?.at(-1)).toContain("Wiki → Settings → Setup → Maintainer");
  });

  it("maintainer states: error, terminated, right adapter but paused, no peers", () => {
    const agentWith = (status: string, extra: Partial<WikiSnapshot> = {}) => byKey(memoryStatus(snapshot({ agent: { id: AGENT_ID, name: "W", status, adapterType: "codex_local", urlKey: null }, ...extra })).items).wiki_agent!;
    expect(agentWith("error")).toMatchObject({ status: "missing", detail: expect.stringContaining("last run failed") });
    expect(agentWith("terminated").detail).toContain("terminated");
    expect(agentWith("paused").detail).toBe("It is paused (LLM Wiki creates it paused).");
    expect(agentWith("active").status).toBe("done");
    // Nobody to compare with: judged on status alone, generic adapter step.
    const lonely = agentWith("paused", { peers: [] });
    expect(lonely.steps?.[1]).toContain("the ones your CEO uses");
    expect(agentWith("running", { peers: null }).status).toBe("done");
    expect(byKey(memoryStatus(snapshot({ agent: null })).items).wiki_agent!.status).toBe("unknown");
  });

  it("routines: paused, schedule off, schedules unreadable", () => {
    const base = snapshot().routines!;
    const routinesWith = (rows: WikiSnapshot["routines"]) => byKey(memoryStatus(snapshot({ routines: rows })).items).wiki_routines!;
    const paused = routinesWith(base.map((r, i) => (i === 0 ? { ...r, status: "paused", triggersEnabled: false } : r)));
    expect(paused.status).toBe("missing");
    expect(paused.detail).toContain("Paused: Process LLM Wiki updates (every 6 hours).");
    expect(paused.detail).toContain("Schedule off: Process LLM Wiki updates (every 6 hours).");
    expect(paused.steps).not.toContain("Click Repair / reconcile so all three routines exist.");
    const unreadable = routinesWith(base.map((r) => ({ ...r, triggersEnabled: null })));
    expect(unreadable.status).toBe("unknown");
    expect(unreadable.detail).toContain("could not read their schedules");
    expect(unreadable.action ?? null).toBeNull();
    expect(routinesWith(null).status).toBe("unknown");
  });

  it("ingestion: on without sources still counts as off; unknown stays optional", () => {
    const off = byKey(memoryStatus(snapshot({ eventIngestion: { enabled: true, sources: { issues: false, comments: false, documents: false } } })).items).event_ingestion!;
    expect(off.status).toBe("optional");
    expect(byKey(memoryStatus(snapshot({ eventIngestion: null })).items).event_ingestion).toMatchObject({ status: "unknown", required: false });
  });

  it("Do it for me params are re-checked before running", () => {
    expect(memorySetupParams({ folderPath: "/srv/wiki", routines: true, ingestion: "yes" })).toEqual({ folderPath: "/srv/wiki", routines: true });
    expect(memorySetupParams({ folderPath: "../etc" })).toEqual({});
    expect(memorySetupParams(undefined)).toEqual({});
  });
});

describe("Company wiki in guided mode, stand-ins and the Finish setup issue", () => {
  it("guided mode: folder with connections, agent then routines with agents, after CRM/Mailbox/Cockpit", () => {
    const items = memoryStatus(FRESH).items;
    expect(itemPhase(items[0]!)).toBe(1);
    expect(itemPhase(items[1]!)).toBe(2);
    expect(itemPhase(items[2]!)).toBe(2);
    const order = guidedOrder([
      { module: "memory", pluginKey: WIKI_PLUGIN, status: memoryStatus(FRESH) },
      { module: "cockpit", pluginKey: "partnersinbiz.cockpit", status: { plugin: "partnersinbiz.cockpit", module: "cockpit", title: "C", checkedAt: "x", items: [{ key: "agents", title: "Hire the team", status: "missing", required: true }] } },
    ]);
    expect(order.map((entry) => entry.id)).toEqual([
      `${WIKI_PLUGIN}:wiki_folder`,
      "partnersinbiz.cockpit:agents",
      `${WIKI_PLUGIN}:wiki_agent`,
      `${WIKI_PLUGIN}:wiki_routines`,
    ]);
  });

  it("not installed: install LLM Wiki", () => {
    expect(standInStatus({ pluginKey: WIKI_PLUGIN, module: "memory", kind: "not-installed" }).items[0]).toMatchObject({ key: "install", title: "Install the LLM Wiki plugin" });
  });

  it("page view: live check failed and nothing stored → unknown checklist with the reason", () => {
    const views = resolveModuleViews({
      modules: null,
      installed: { [WIKI_PLUGIN]: { id: "w", pluginKey: WIKI_PLUGIN, status: "ready", version: "0.1.0", displayName: "LLM Wiki", schema: null } },
      live: { [WIKI_PLUGIN]: { ok: false, reason: "Could not read LLM Wiki: boom." } },
      stored: {},
    });
    const memory = views.find((view) => view.module === "memory")!;
    expect(memory.source).toBe("stand-in");
    expect(memory.status?.items.map((item) => item.status)).toEqual(["unknown", "unknown", "unknown", "unknown"]);
    expect(memory.status?.items[0]!.detail).toBe("Could not read LLM Wiki: boom.");
  });

  it("finish issue: never checked → listed as not checked; reported → real items with Do it for me", () => {
    const onlyMemory = Object.fromEntries(MODULE_KEYS.map((key) => [key, key === "memory"]));
    const installed = { [WIKI_PLUGIN]: { id: "w" } };
    const unchecked = finishSetupContent({ modules: onlyMemory, statuses: {}, installed, prefix: "PIB" });
    expect(unchecked?.title).toBe("Finish setup: 3 steps left");
    expect(unchecked?.description).toContain("## Company wiki (0 of 3 done)");
    expect(unchecked?.description).toContain(MEMORY_NOT_CHECKED);
    const reported = finishSetupContent({ modules: onlyMemory, statuses: { [WIKI_PLUGIN]: memoryStatus(FRESH) }, installed, prefix: "PIB" });
    expect(reported?.description).toContain("[Open the wiki](/PIB/wiki)");
    expect(reported?.description).toContain('The Setup page can do this for you: "Set up company memory".');
    expect(finishSetupContent({ modules: onlyMemory, statuses: { [WIKI_PLUGIN]: memoryStatus(snapshot()) }, installed, prefix: "PIB" })).toBeNull();
    // Switched on but not installed: one step (install it, or switch the module off), counted like the page counts it.
    const notInstalled = finishSetupContent({ modules: onlyMemory, statuses: {}, installed: {}, prefix: null });
    expect(notInstalled?.title).toBe("Finish setup: 1 step left");
    expect(notInstalled?.description).toContain("**Install the LLM Wiki plugin**");
  });
});

describe("worker: setup.report-memory", () => {
  it("stores the checklist the worker builds, for board users only", async () => {
    const { ctx, store, actions } = fakeCtx();
    registerSetup(ctx);
    const report = actions.get("setup.report-memory")!;
    const result = (await report({ snapshot: FRESH }, { companyId: "c1", actor: { type: "user", userId: "u1" } })) as { status: { items: SetupItem[] } };
    expect(result.status.items[0]!.key).toBe("wiki_folder");
    expect(store.statuses).toHaveLength(1);
    expect(store.statuses![0]).toMatchObject({ company_id: "c1", plugin_key: WIKI_PLUGIN });
    await expect(report({ snapshot: FRESH }, { companyId: "c1", actor: { type: "agent", agentId: "a" } })).rejects.toThrow(/Setup page/);
    expect(await reportMemory(ctx, "c1", "garbage", fixedClock("2026-09-27T11:00:00.000Z"))).toBeNull();
  });
});

describe("page client", () => {
  afterEach(() => vi.unstubAllGlobals());

  function mockFetch(routes: Record<string, (init?: RequestInit) => { status?: number; body: unknown }>) {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
      const route = routes[`${method} ${url}`];
      const out = route ? route(init) : { status: 404, body: { error: "nope" } };
      return new Response(JSON.stringify(out.body), { status: out.status ?? 200 });
    });
    return calls;
  }

  const W = `/api/plugins/${WIKI_PLUGIN}`;

  it("falls back to /overview and reports unreachable plainly", async () => {
    mockFetch({
      [`GET ${W}/api/overview?companyId=${CO}`]: () => ({ body: { folder: { configured: true, healthy: true, path: "/w", problems: [] } } }),
    });
    const ok = await fetchWikiSnapshot(CO);
    expect(ok.ok && ok.snapshot.folder?.path).toBe("/w");
    mockFetch({});
    const failed = await fetchWikiSnapshot(CO);
    expect(failed).toEqual({ ok: false, reason: "LLM Wiki did not answer the check. Upgrade or enable it, then check again." });
  });

  it("Set up company memory: bootstrap, create missing routines, activate them and their schedules, ingestion", async () => {
    let reconciled = false;
    const routineList = () => ({
      body: [
        { id: "r1", title: "Process LLM Wiki updates", status: "paused", managedByPlugin: { pluginKey: WIKI_PLUGIN, resourceKey: "cursor-window-processing" }, triggers: [{ id: "t1", enabled: false }] },
        { id: "r2", title: "Run LLM Wiki lint", status: "active", triggers: [{ id: "t2", enabled: true }] },
        ...(reconciled ? [{ id: "r3", title: "Refresh LLM Wiki index", status: "paused", triggers: [{ id: "t3", enabled: false }, { id: "t3x", enabled: false, archived: true }] }] : []),
        { id: "other", title: "Something else", status: "paused", triggers: [] },
      ],
    });
    const calls = mockFetch({
      [`POST ${W}/api/bootstrap`]: () => ({ status: 201, body: { ok: true } }),
      [`GET /api/companies/${CO}/routines`]: routineList,
      [`POST ${W}/actions/reconcile-managed-routines`]: () => {
        reconciled = true;
        return { body: { data: {} } };
      },
      [`PATCH /api/routines/r1`]: () => ({ body: {} }),
      [`PATCH /api/routines/r3`]: () => ({ body: {} }),
      [`PATCH /api/routine-triggers/t1`]: () => ({ body: {} }),
      [`PATCH /api/routine-triggers/t3`]: () => ({ body: {} }),
      [`POST ${W}/actions/update-event-ingestion-settings`]: () => ({ body: { data: {} } }),
    });
    const done = await runMemorySetup(CO, { folderPath: "/srv/wiki", routines: true, ingestion: true });
    expect(done).toEqual([
      "Wiki folder set to /srv/wiki",
      "Created the wiki routines",
      "Turned the wiki routines and their schedules on",
      "Turned on distilling of issues, comments and documents",
    ]);
    const writes = calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.url}`);
    expect(writes).toEqual([
      `POST ${W}/api/bootstrap`,
      `POST ${W}/actions/reconcile-managed-routines`,
      "PATCH /api/routines/r1",
      "PATCH /api/routine-triggers/t1",
      "PATCH /api/routines/r3",
      "PATCH /api/routine-triggers/t3",
      `POST ${W}/actions/update-event-ingestion-settings`,
    ]);
    expect(calls[0]!.body).toEqual({ companyId: CO, path: "/srv/wiki" });
    expect(calls.find((call) => call.url.endsWith("update-event-ingestion-settings"))!.body).toEqual({ companyId: CO, params: { enabled: true, sources: { issues: true, comments: true, documents: true }, companyId: CO } });
  });

  it("skips what is already done", async () => {
    const calls = mockFetch({
      [`GET /api/companies/${CO}/routines`]: () => ({
        body: [
          { id: "r1", title: "Process LLM Wiki updates", status: "active", triggers: [{ id: "t1", enabled: true }] },
          { id: "r2", title: "Run LLM Wiki lint", status: "active", triggers: [{ id: "t2", enabled: true }] },
          { id: "r3", title: "Refresh LLM Wiki index", status: "active", triggers: [{ id: "t3", enabled: true }] },
        ],
      }),
    });
    expect(await runMemorySetup(CO, { routines: true })).toEqual([]);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });
});
