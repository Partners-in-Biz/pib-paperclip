import { describe, expect, it } from "vitest";
import type { CockpitSnapshot, WaitingItem } from "@partnersinbiz/pib-plugin-kit/cockpit";
import { PLUGIN_KEY } from "../src/constants.js";
import {
  activityGroups,
  agentAlert,
  agentHealth,
  agentRows,
  groupKpis,
  headlineKpis,
  healthGroups,
  hostWaiting,
  mergeWaiting,
  parseSnapshot,
  pluginEnabled,
  setupMissingCount,
  staleChecks,
  todayLine,
  type AgentLite,
} from "../src/merge.js";
import { backupInfo, buildView, pickSnapshots, type LoadResult } from "../src/view.js";

const NOW = new Date("2026-09-26T10:00:00.000Z");
const w = (key: string, kind: WaitingItem["kind"], extra: Partial<WaitingItem> = {}): WaitingItem => ({ key, title: key, why: "because", kind, ...extra });
const snap = (plugin: string, extra: Partial<CockpitSnapshot> = {}): CockpitSnapshot => ({ plugin, title: plugin.split(".")[1]!, checkedAt: NOW.toISOString(), kpis: [], health: [], waiting: [], activity: [], quality: [], ...extra });
const agent = (id: string, extra: Partial<AgentLite> = {}): AgentLite => ({ id, name: id, status: "active", budgetMonthlyCents: 0, spentMonthlyCents: 0, ...extra });

describe("parseSnapshot", () => {
  it("normalises a snapshot, unwraps { data }, drops bad rows and forces the plugin key", () => {
    const parsed = parseSnapshot({
      data: {
        plugin: "spoofed.plugin",
        title: "Billing",
        checkedAt: "2026-09-26T09:00:00.000Z",
        kpis: [{ key: "cash", label: "Cash", value: "R 1,000", raw: 100000, tone: "ok", group: "money" }, { label: "no key" }, { key: "x", label: "X", value: 3, group: "weird" }],
        health: [{ key: "outbox", title: "Deliveries", status: "bad", fix: "Retry" }, { key: "bogus", title: "B", status: "purple" }],
        waiting: [{ key: "approval:1", title: "Approve invoice", why: "Money", kind: "money", issueId: "i1" }],
        activity: Array.from({ length: 14 }, (_, i) => ({ at: new Date(NOW.getTime() - i * 60_000).toISOString(), text: `Did ${i}` })),
        quality: [{ key: "rejected", label: "Rejected", value: "2", agentId: "a1" }],
      },
    }, "partnersinbiz.billing");
    expect(parsed?.plugin).toBe("partnersinbiz.billing");
    expect(parsed?.kpis.map((k) => [k.key, k.group, k.value])).toEqual([["cash", "money", "R 1,000"], ["x", "other", "3"]]);
    expect(parsed?.health.map((h) => h.status)).toEqual(["bad", "warn"]);
    expect(parsed?.activity).toHaveLength(10);
    expect(parsed?.activity[0]!.text).toBe("Did 0");
    expect(parseSnapshot({ hello: 1 }, "partnersinbiz.crm")).toBeNull();
    expect(parseSnapshot(null, "partnersinbiz.crm")).toBeNull();
  });
});

describe("waiting on you", () => {
  it("orders money and legal first, oldest first, and dedupes by key and issue (plugins win over the host)", () => {
    const merged = mergeWaiting([
      { source: "partnersinbiz.social", items: [w("review:post", "review", { issueId: "i-post" }), w("grant:x", "grant")] },
      { source: "partnersinbiz.billing", items: [w("approval:inv-new", "money", { since: "2026-09-26T08:00:00.000Z" }), w("approval:inv-old", "money", { since: "2026-09-20T08:00:00.000Z" }), w("grant:x", "grant")] },
      { source: "host", sourceTitle: "Paperclip", items: hostWaiting({ myIssues: [{ id: "i-post", title: "Approve post", status: "in_review" }, { id: "i-contract", identifier: "PIB-9", title: "Sign the client contract", status: "todo" }] }) },
    ]);
    expect(merged.map((m) => m.key)).toEqual(["approval:inv-old", "approval:inv-new", "issue:i-contract", "grant:x", "review:post"]);
    expect(merged.find((m) => m.key === "grant:x")?.source).toBe("partnersinbiz.social");
    expect(merged.find((m) => m.key === "issue:i-contract")).toMatchObject({ kind: "legal", title: "PIB-9 Sign the client contract", href: "/issues/PIB-9" });
  });

  it("turns open approvals, the person's open issues and missing setup items into waiting items", () => {
    const items = hostWaiting({
      approvals: [
        { id: "a1", type: "budget_override_required", status: "pending", payload: { agentName: "SEO" } },
        { id: "a2", type: "hire_agent", status: "revision_requested", payload: { name: "Operator" } },
        { id: "a3", type: "request_board_approval", status: "approved" },
      ],
      myIssues: [{ id: "i1", title: "Pay the VAT", status: "blocked" }, { id: "i2", title: "Done thing", status: "done" }],
      setupMissing: 3,
    });
    expect(items.map((i) => [i.key, i.kind])).toEqual([["host-approval:a1", "money"], ["host-approval:a2", "grant"], ["issue:i1", "money"], ["setup:missing", "grant"]]);
    expect(items[0]!.title).toBe("Budget override needed: SEO");
    expect(items[0]!.href).toBe("/approvals/a1");
    expect(items[3]).toMatchObject({ title: "Finish setup: 3 required items", href: "/setup" });
  });

  it("counts missing required setup items of switched-on modules only", () => {
    const status = (plugin: string, missing: number) => ({ plugin, module: null, title: plugin, checkedAt: NOW.toISOString(), items: Array.from({ length: missing }, (_, i) => ({ key: `k${i}`, title: "t", status: "missing" as const, required: true })) });
    expect(setupMissingCount({ "partnersinbiz.crm": status("partnersinbiz.crm", 2), "partnersinbiz.seo": status("partnersinbiz.seo", 3) }, { seo: false })).toBe(2);
  });
});

describe("KPIs, health and module switches", () => {
  it("groups KPIs, picks headline KPIs with problems first, and hides switched-off modules", () => {
    const billing = snap("partnersinbiz.billing", { kpis: [{ key: "cash", label: "Cash", value: "R1", group: "money", tone: "ok" }, { key: "overdue", label: "Overdue", value: "R9", group: "money", tone: "bad" }] });
    const crm = snap("partnersinbiz.crm", { kpis: [{ key: "pipeline", label: "Pipeline", value: "R5", group: "pipeline" }] });
    const groups = groupKpis([billing, crm]);
    expect(groups.money.map((k) => k.key)).toEqual(["cash", "overdue"]);
    expect(headlineKpis([billing, crm]).map((k) => k.key)).toEqual(["overdue", "pipeline"]);
    expect(pluginEnabled({ billing: false }, "partnersinbiz.billing")).toBe(false);
    expect(pluginEnabled(null, "partnersinbiz.billing")).toBe(true);
    expect(pluginEnabled({ billing: false }, PLUGIN_KEY)).toBe(true);
  });

  it("groups health worst first with the worst check first", () => {
    const groups = healthGroups([
      snap("partnersinbiz.crm", { health: [{ key: "a", title: "A", status: "ok" }] }),
      snap("partnersinbiz.social", { health: [{ key: "b", title: "B", status: "warn" }, { key: "c", title: "C", status: "bad" }] }),
    ]);
    expect(groups.map((g) => [g.plugin, g.status])).toEqual([["partnersinbiz.social", "bad"], ["partnersinbiz.crm", "ok"]]);
    expect(groups[0]!.checks.map((c) => c.key)).toEqual(["c", "b"]);
  });
});

describe("stale plugins", () => {
  it("warns when an enabled plugin has not reported for 3 hours, or never reported 3 hours after the Cockpit started", () => {
    const checks = staleChecks({
      expected: ["partnersinbiz.crm", "partnersinbiz.seo", "partnersinbiz.social", PLUGIN_KEY],
      lastSnapshot: { "partnersinbiz.crm": "2026-09-26T09:30:00.000Z", "partnersinbiz.seo": "2026-09-26T06:00:00.000Z" },
      now: NOW,
      listeningSince: "2026-09-26T05:00:00.000Z",
    });
    expect(checks.map((c) => c.key)).toEqual(["stale:partnersinbiz.seo", "stale:partnersinbiz.social"]);
    expect(checks[0]).toMatchObject({ status: "warn", title: "SEO plugin not reporting", detail: "Last report 4 hours ago." });
    expect(checks[1]!.detail).toBe("It has never reported to the Cockpit.");
    // Just started listening: a plugin with no snapshot is not stale yet.
    expect(staleChecks({ expected: ["partnersinbiz.social"], lastSnapshot: {}, now: NOW, listeningSince: "2026-09-26T09:00:00.000Z" })).toEqual([]);
  });
});

describe("agents and budgets", () => {
  it("alerts at 80% of the monthly budget and on error", () => {
    expect(agentAlert(agent("a", { budgetMonthlyCents: 3000, spentMonthlyCents: 2399 })).alert).toBeNull();
    expect(agentAlert(agent("a", { budgetMonthlyCents: 3000, spentMonthlyCents: 2400 }))).toEqual({ alert: "budget", text: "Used 80% of its $30.00 monthly budget ($24.00)." });
    expect(agentAlert(agent("a", { status: "error", errorReason: "model key invalid" }))).toEqual({ alert: "error", text: "In error: model key invalid" });
    expect(agentAlert(agent("a", { budgetMonthlyCents: 0, spentMonthlyCents: 9999 })).alert).toBeNull();
    const health = agentHealth([agent("over", { budgetMonthlyCents: 1000, spentMonthlyCents: 1200 }), agent("near", { budgetMonthlyCents: 1000, spentMonthlyCents: 850 }), agent("gone", { status: "terminated", budgetMonthlyCents: 10, spentMonthlyCents: 100 })]);
    expect(health.map((h) => [h.key, h.status])).toEqual([["agent:budget:over", "bad"], ["agent:budget:near", "warn"]]);
  });

  it("builds agent rows with runs, last run and quality, alerts first", () => {
    const rows = agentRows([agent("b"), agent("a", { status: "error" })], {
      runs: [
        { agentId: "b", status: "succeeded", startedAt: "2026-09-26T09:00:00.000Z" },
        { agentId: "b", status: "failed", startedAt: "2026-09-25T09:00:00.000Z" },
        { agentId: "b", status: "succeeded", startedAt: "2026-09-01T09:00:00.000Z" },
      ],
      snapshots: [snap("partnersinbiz.social", { quality: [{ key: "rej", label: "Rejected", value: "10%", agentId: "b" }] })],
      since: new Date("2026-09-19T10:00:00.000Z"),
    });
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(rows[1]).toMatchObject({ lastRunAt: "2026-09-26T09:00:00.000Z", runs: { total: 2, failed: 1 } });
    expect(rows[1]!.quality[0]!.key).toBe("rej");
  });
});

describe("activity", () => {
  it("groups plugin and host activity by agent within the window", () => {
    const groups = activityGroups({
      snapshots: [snap("partnersinbiz.social", { activity: [{ at: "2026-09-26T08:00:00.000Z", text: "Published 3 posts", agentId: "a1", href: "/social" }, { at: "2026-09-20T08:00:00.000Z", text: "Old", agentId: "a1" }, { at: "2026-09-26T07:00:00.000Z", text: "Synced inbox" }] })],
      host: [
        { actorType: "agent", actorId: "a1", action: "issue.created", entityType: "issue", entityId: "i1", details: { identifier: "PIB-4" }, createdAt: "2026-09-26T09:00:00.000Z" },
        { actorType: "user", actorId: "u1", action: "issue.updated", entityType: "issue", entityId: "i2", createdAt: "2026-09-26T09:00:00.000Z" },
      ],
      runs: [{ agentId: "a1", status: "failed", startedAt: "2026-09-26T09:30:00.000Z" }],
      agents: [{ id: "a1", name: "Social agent" }],
      now: NOW,
      windowMs: 24 * 3_600_000,
    });
    expect(groups.map((g) => g.name)).toEqual(["Social agent", "social"]);
    expect(groups[0]!.lines.map((l) => l.text)).toEqual(["Created issue PIB-4", "Published 3 posts"]);
    expect(groups[0]!.lines[0]!.href).toBe("/issues/PIB-4");
    expect(groups[0]!.runs).toEqual({ total: 1, failed: 1 });
  });

  it("writes a plain Today line", () => {
    expect(todayLine({ waiting: 2, health: "bad", problems: 1, agentAlerts: 1, activeAgents: 4 })).toBe("2 things wait on you · 1 problem to fix · 1 agent alert · 4 agents working.");
    expect(todayLine({ waiting: 0, health: "ok", problems: 0, agentAlerts: 0, activeAgents: 1 })).toBe("Nothing waiting on you · all systems ok · 1 agent working.");
  });
});

describe("page view", () => {
  const load = (extra: Partial<LoadResult> = {}): LoadResult => ({
    roles: null,
    rolesSavedAt: "2026-09-25T00:00:00.000Z",
    settingsSaved: true,
    snapshots: {},
    setupStatuses: {},
    own: snap(PLUGIN_KEY, { title: "Cockpit", health: [{ key: "operator", title: "Operator", status: "warn" }] }),
    team: null,
    healthIssueId: null,
    ...extra,
  });

  it("uses the live snapshot, falls back to the stored one, and hides switched-off and uninstalled plugins", () => {
    const picked = pickSnapshots({
      load: load({ snapshots: { "partnersinbiz.crm": { snapshot: snap("partnersinbiz.crm", { title: "stored crm" }), receivedAt: NOW.toISOString() }, "partnersinbiz.seo": { snapshot: snap("partnersinbiz.seo"), receivedAt: NOW.toISOString() }, "partnersinbiz.billing": { snapshot: snap("partnersinbiz.billing"), receivedAt: NOW.toISOString() } } }),
      installed: { "partnersinbiz.crm": { id: "c", status: "ready" }, "partnersinbiz.social": { id: "s", status: "ready" }, "partnersinbiz.seo": { id: "o", status: "ready" } },
      modules: { seo: false },
      live: { "partnersinbiz.social": snap("partnersinbiz.social", { title: "live social" }), "partnersinbiz.crm": null },
    });
    expect(picked.map((s) => [s.plugin, s.source, s.title])).toEqual([
      ["partnersinbiz.crm", "stored", "stored crm"],
      ["partnersinbiz.social", "live", "live social"],
      [PLUGIN_KEY, "live", "Cockpit"],
    ]);
  });

  it("builds the whole view: waiting, stale warning, backup warning", () => {
    const view = buildView({
      load: load({ snapshots: { "partnersinbiz.crm": { snapshot: snap("partnersinbiz.crm", { checkedAt: "2026-09-26T02:00:00.000Z", waiting: [w("crm:1", "judgement")] }), receivedAt: "2026-09-26T02:00:00.000Z" } } }),
      installed: { "partnersinbiz.crm": { id: "c", status: "ready" } },
      modules: null,
      live: {},
      approvals: [{ id: "a1", type: "budget_override_required", status: "pending" }],
      myIssues: [],
      setupMissing: 0,
      agents: [agent("a1", { budgetMonthlyCents: 100, spentMonthlyCents: 90 })],
      backup: { mtime: "2026-09-26T05:00:00.000Z", ageHours: 5 },
      now: NOW,
      windowMs: 86_400_000,
    });
    expect(view.waiting.map((x) => x.key)).toEqual(["host-approval:a1", "crm:1"]);
    expect(view.healthGroups.flatMap((g) => g.checks.map((c) => c.key))).toEqual(expect.arrayContaining(["stale:partnersinbiz.crm", "backup", "operator"]));
    expect(view.health).toBe("warn");
    expect(view.agents[0]!.alert).toBe("budget");
    expect(view.today).toContain("2 things wait on you");
    expect(backupInfo({ mtime: null, ageHours: 0.5 }, NOW)).toMatchObject({ status: "ok", text: "Less than an hour ago." });
    expect(backupInfo(null, NOW)).toBeNull();
  });
});
