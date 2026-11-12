import { describe, expect, it } from "vitest";
import { parseSnapshot, splitOwnerWaiting, OTHERS_MAX_HIDE_DAYS, type CockpitSnapshot, type WaitingEntry } from "../src/merge.js";
import { waitingFrom, waitingSplit } from "../src/brief.js";
import { buildView, type LoadResult } from "../src/view.js";
import { renderDigest } from "../src/digest-model.js";
import { runTool } from "../src/brief.js";
import { TOOL_NAMES } from "../src/tools.js";
import { createEnv, registerCockpit } from "../src/register.js";
import { fakeCtx, fixedClock } from "./helpers/fake-ctx.js";

const NOW = new Date("2026-11-12T08:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const entry = (key: string, extra: Partial<WaitingEntry> = {}): WaitingEntry => ({ key, title: key, why: "why", kind: "review", source: "social", sourceTitle: "Social", ...extra });
const ACTIVE = { activeAgentIds: ["a1"], hiddenIssueIds: [] as string[] };
const split = (items: WaitingEntry[], filter: typeof ACTIVE | null = ACTIVE) => splitOwnerWaiting(items, filter, NOW);

describe("splitOwnerWaiting", () => {
  it("1. an active agent's item under 7 days leaves the owner list and shows in others", () => {
    const r = split([entry("p1", { waitsOn: { kind: "agent", agentId: "a1" }, since: ago(1) })]);
    expect(r.owner).toEqual([]);
    expect(r.others.map((e) => e.key)).toEqual(["p1"]);
  });
  it("2. a client item does the same", () => {
    const r = split([entry("c1", { waitsOn: { kind: "client" }, since: ago(1) })]);
    expect([r.owner.length, r.others.length]).toEqual([0, 1]);
  });
  it("3. a missing or inactive agent stays with the owner", () => {
    const r = split([entry("m", { waitsOn: { kind: "agent", agentId: "gone" }, since: ago(1) })]);
    expect([r.owner.length, r.others.length]).toEqual([1, 0]);
  });
  it("4. no since, or 8 days old: stays with the owner, marked stale", () => {
    const r = split([entry("n", { waitsOn: { kind: "client" } }), entry("o", { waitsOn: { kind: "client" }, since: ago(OTHERS_MAX_HIDE_DAYS + 1) })]);
    expect(r.others).toEqual([]);
    expect(r.owner.map((e) => [e.key, e.stale])).toEqual([["n", true], ["o", true]]);
    expect(r.owner[0]!.why).toContain("over 7 days");
  });
  it("5. no or invalid waitsOn stays (old plugin); parseSnapshot drops an invalid one and keeps a valid one", () => {
    expect(split([entry("x")]).owner).toHaveLength(1);
    const snap = parseSnapshot({ plugin: "p", title: "P", checkedAt: NOW.toISOString(), waiting: [
      { key: "ok", title: "ok", waitsOn: { kind: "agent", agentId: "a1" }, since: ago(1) },
      { key: "cl", title: "cl", waitsOn: { kind: "client" } },
      { key: "bad1", title: "bad", waitsOn: { kind: "agent" } },
      { key: "bad2", title: "bad", waitsOn: "agent" },
    ] }, "p") as CockpitSnapshot;
    expect(snap.waiting.map((w) => [w.key, w.waitsOn ?? null])).toEqual([["ok", { kind: "agent", agentId: "a1" }], ["cl", { kind: "client" }], ["bad1", null], ["bad2", null]]);
  });
  it("(a) a hidden issue is dropped", () => {
    expect(split([entry("h", { issueId: "i1" })], { activeAgentIds: [], hiddenIssueIds: ["i1"] }).owner).toEqual([]);
  });
});

const fixtureItems = [
  { key: "a", title: "A", why: "w", kind: "review", issueId: "i-a", since: ago(1), waitsOn: { kind: "agent", agentId: "a1" } },
  { key: "b", title: "B", why: "w", kind: "review", issueId: "i-b", since: ago(2), waitsOn: { kind: "client" } },
  { key: "c", title: "C", why: "w", kind: "review", issueId: "i-c", since: ago(9), waitsOn: { kind: "client" } },
  { key: "d", title: "D", why: "w", kind: "review", issueId: "i-d", since: ago(1), waitsOn: { kind: "agent", agentId: "dead" } },
  { key: "e", title: "E", why: "w", kind: "review", issueId: "i-e", since: ago(1) },
];
const snapshot = { plugin: "partnersinbiz.social", title: "Social", checkedAt: NOW.toISOString(), kpis: [], health: [], waiting: fixtureItems, activity: [], quality: [] } as unknown as CockpitSnapshot;
const agents = [{ id: "a1", name: "A", status: "active" }, { id: "dead", name: "D", status: "terminated" }] as never[];

describe("one rule on every surface", () => {
  it("6. buildView with no ownerFilter keeps an agent item with the owner", () => {
    const load = { snapshots: { [snapshot.plugin]: { snapshot, receivedAt: NOW.toISOString() } }, setupStatuses: {}, roles: null } as unknown as LoadResult;
    const view = buildView({ load, installed: null, modules: null, live: {}, agents, now: NOW, windowMs: DAY, setupMissing: 0 });
    expect(view.waiting.map((w) => w.key).sort()).toEqual(["a", "c", "d", "e"]);
    expect(view.waitingOthers.map((w) => w.key)).toEqual(["b"]);
  });
  it("7. the tool path, the digest path and buildView give the same owner and others counts", () => {
    const load = { snapshots: { [snapshot.plugin]: { snapshot, receivedAt: NOW.toISOString() } }, setupStatuses: {}, roles: null, ownerFilter: { activeAgentIds: ["a1"], hiddenIssueIds: [] } } as unknown as LoadResult;
    const view = buildView({ load, installed: null, modules: null, live: {}, agents, now: NOW, windowMs: DAY, setupMissing: 0 });
    const data = { snapshots: [snapshot], approvals: [], ownerIssues: [], setupMissing: 0, agents };
    const owner = waitingFrom(data as never, NOW);
    const both = waitingSplit(data as never, NOW);
    expect(view.waiting.map((w) => w.key).sort()).toEqual(["c", "d", "e"]);
    expect(view.waiting.map((w) => w.key).sort()).toEqual(owner.map((w) => w.key).sort());
    expect(view.waitingOthers.map((w) => w.key)).toEqual(both.others.map((w) => w.key));
    expect(both.others.map((w) => w.key).sort()).toEqual(["a", "b"]);
    // the digest prints the others line from the same count
    const stats = { others: both.others.length, newAsks: 0, routed: 0, applied: [], history: [], unread: [] };
    expect(renderDigest({ items: [], stats, now: NOW })).toContain("2 wait on others.");
  });
});

describe("the waiting-on-owner tool", () => {
  it("1. keeps others out of the owner list and count, lists them, and says so in the summary", async () => {
    const A = "company-a";
    const fake = fakeCtx({ savedConfigs: { [A]: { healthIssue: true } }, prefixes: { [A]: "PIB" }, agents: [{ id: "a1", companyId: A, name: "Ann", status: "active" }] });
    const env = createEnv(fake.ctx, fixedClock(NOW.toISOString()).now);
    registerCockpit(fake.ctx, env);
    const toolSnap = { ...snapshot, plugin: "partnersinbiz.billing", title: "Social", waiting: fixtureItems.map(({ issueId: _issueId, ...w }) => w) };
    fake.store.snapshots = [{ company_id: A, plugin_key: toolSnap.plugin, kind: "cockpit", payload: toolSnap, checked_at: NOW.toISOString(), received_at: NOW.toISOString() }] as never;
    const result = await runTool(env, TOOL_NAMES.waiting, {}, { agentId: "t", runId: "r", companyId: A, projectId: "p" });
    const data = result.data as { count: number; items: Array<{ title: string }>; others: { count: number; items: Array<Record<string, unknown>> } };
    expect(data.items.map((i) => i.title).sort()).toEqual(["C", "D", "E"]);
    expect(data.count).toBe(3);
    expect(data.others.count).toBe(2);
    expect(data.others.items.find((i) => i.title === "A")).toMatchObject({ title: "A", waitsOn: { kind: "agent", agentId: "a1" }, from: "Social" });
    expect(result.content).toContain("3 items wait on the owner.");
    expect(result.content).toContain("2 wait on others.");
  });
});
