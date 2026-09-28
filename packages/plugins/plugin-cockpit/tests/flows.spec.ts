/**
 * The Flows view: parsing each plugin's `flows`, who holds each role, where
 * the graph is switched off (and why), what is stuck, the sentence at the top,
 * and the tab and Overview summary with no numbers, some numbers and all.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FLOW_STAGES, FLOWS, PIB_PLUGINS, type CockpitSnapshot, type FlowStageReport } from "@partnersinbiz/pib-plugin-kit";
import { PLUGIN_KEY } from "../src/constants.js";
import { buildFlows, flowTeam, flowsSentence, parseFlowReports, settingsDone, stageOff, stuckOrder, type FlowsInput, type FlowTeam, type OffInput } from "../src/flows.js";
import { parseSnapshot } from "../src/merge.js";
import { buildView, knownSetupStatuses, type LoadResult } from "../src/view.js";
import { countText, FlowsPanel, FlowsSummary, flowStatus, numbersNote, stageList, stageState, stuckGroups } from "../src/ui/flows.js";
import { Overview, tabFromSearch } from "../src/ui/index.js";

const NOW = new Date("2026-09-28T08:00:00.000Z");
const linkFor = (href: string) => ({ href: `/PIB${href}` });
const render = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);
const snap = (plugin: string, extra: Partial<CockpitSnapshot> = {}): CockpitSnapshot => ({ plugin, title: plugin.split(".")[1]!, checkedAt: NOW.toISOString(), kpis: [], health: [], waiting: [], activity: [], quality: [], ...extra });

const P = PIB_PLUGINS;
const FLOW_PLUGINS = [P.crm, P.billing, P.accounting, P.seo, P.social, P.campaigns, P.payroll];
const settings = (done = true) => ({ plugin: "x", items: [{ key: "settings", title: "Save", status: done ? "done" : "missing", required: true }] });
const agents = [
  { id: "op", name: "Olive", status: "active" },
  { id: "am", name: "Ama", status: "active" },
  { id: "bk", name: "Bea", status: "idle" },
  { id: "seo", name: "Sam", status: "active" },
  { id: "so", name: "Sol", status: "running" },
  { id: "pc", name: "Pat", status: "idle" },
];
const teamSnapshots = [
  snap(P.crm, { team: [{ role: "account-manager", agentId: "am", status: "active" }] }),
  snap(P.accounting, { team: [{ role: "bookkeeper", agentId: "bk", status: "idle" }] }),
  snap(P.seo, { team: [{ role: "seo-specialist", agentId: "seo", status: "active" }] }),
  snap(P.social, { team: [{ role: "social", agentId: "so", status: "active" }] }),
  snap(P.payroll, { team: [{ role: "payroll-clerk", agentId: "pc", status: "idle" }] }),
];

/** A company where every module is on, set up and staffed. */
function staffed(reports: Record<string, FlowStageReport[]> = {}): FlowsInput {
  return {
    snapshots: [...teamSnapshots.map((s) => ({ ...s, ...(reports[s.plugin] ? { flows: reports[s.plugin] } : {}) })), ...[P.billing, P.campaigns, PLUGIN_KEY].map((plugin) => snap(plugin, reports[plugin] ? { flows: reports[plugin] } : {}))],
    modules: {},
    installed: Object.fromEntries([...FLOW_PLUGINS, PLUGIN_KEY].map((key) => [key, { status: "ready" }])),
    setupStatuses: Object.fromEntries(FLOW_PLUGINS.map((key) => [key, settings()])),
    cockpitSettingsSaved: true,
    roles: { operatorAgentId: "op", reviewerAgentId: null },
    agents,
  };
}

/** A number for every stage of the graph (none stuck). */
function everyStage(count = 1): Record<string, FlowStageReport[]> {
  const out: Record<string, FlowStageReport[]> = {};
  for (const stage of Object.values(FLOW_STAGES)) (out[stage.plugin] ??= []).push({ stage: stage.key, count, stuck: 0 });
  return out;
}

const SOME: Record<string, FlowStageReport[]> = {
  [P.crm]: [{ stage: "lead.in", count: 7, stuck: 2, stuckReason: "2 over a day without a follow-up", oldestDays: 3 }],
  [P.billing]: [
    { stage: "quote.approval", count: 1, stuck: 1, stuckReason: "1 waiting over a day", amountMinor: 1_850_000, currency: "ZAR" },
    { stage: "invoice.open", count: 5, stuck: 2, stuckReason: "2 overdue", amountMinor: 1_175_000, currency: "ZAR", oldestDays: 12 },
  ],
  [P.accounting]: [{ stage: "bank.match", count: 14, stuck: 3, stuckReason: "3 over a week old", oldestDays: 9 }],
};

// ---------------------------------------------------------------------------

describe("parsing a plugin's flows", () => {
  it("keeps only the plugin's own known stages, once, with sane numbers", () => {
    const reports = parseFlowReports([
      { stage: "invoice.open", count: 5.4, stuck: 9, stuckReason: "  2   overdue ", amountMinor: 1_175_000.4, currency: "zar", oldestDays: 12.7 },
      { stage: "invoice.open", count: 99 },
      { stage: "lead.in", count: 3 },
      { stage: "nope", count: 1 },
      { stage: "constructor", count: 1 },
      { stage: "quote.draft", count: "3" },
      { stage: "quote.sent", count: -2, stuck: 1, stuckReason: "x", amountMinor: 100, currency: "rands", oldestDays: -4 },
      null,
      "x",
      [1],
    ], P.billing);
    expect(reports).toEqual([
      { stage: "invoice.open", count: 5, stuck: 5, stuckReason: "2 overdue", amountMinor: 1_175_000, currency: "ZAR", oldestDays: 12 },
      { stage: "quote.sent", count: 0, stuck: 0, stuckReason: null, amountMinor: 100, currency: "ZAR", oldestDays: null },
    ]);
    expect(parseFlowReports(undefined, P.billing)).toEqual([]);
    expect(parseFlowReports({ stage: "invoice.open", count: 1 }, P.billing)).toEqual([]);
    const long = parseFlowReports([{ stage: "invoice.open", count: 1, stuck: 1, stuckReason: "x".repeat(400) }], P.billing)[0]!;
    expect(long.stuckReason).toHaveLength(160);
    expect(long.stuckReason!.endsWith("…")).toBe(true);
  });

  it("keeps flows in a snapshot only when the plugin sends them (older plugins do not)", () => {
    const parsed = parseSnapshot({ ...snap(P.billing), flows: [{ stage: "invoice.open", count: 2 }, { stage: "lead.in", count: 1 }] }, P.billing)!;
    expect(parsed.flows).toEqual([{ stage: "invoice.open", count: 2, stuck: 0, stuckReason: null, amountMinor: null, currency: null, oldestDays: null }]);
    expect(parseSnapshot(snap(P.billing), P.billing)!.flows).toBeUndefined();
    expect(parseSnapshot({ ...snap(P.billing), flows: "nope" }, P.billing)!.flows).toBeUndefined();
    expect(parseSnapshot({ data: { ...snap(P.billing), flows: [] } }, P.billing)!.flows).toEqual([]);
  });
});

describe("who holds each role", () => {
  it("takes the first report per role, the agents list's name and status, and the Cockpit's own Operator", () => {
    const team = flowTeam({
      snapshots: [{ team: [{ role: "account-manager", agentId: "am", status: "paused" }] }, { team: [{ role: "account-manager", agentId: "other" }, { role: "bookkeeper", agentId: "gone", status: "idle" }] }],
      roles: { operatorAgentId: "op" },
      agents,
    });
    expect(team["account-manager"]).toEqual({ agentId: "am", name: "Ama", status: "active" });
    // Missing from a loaded agents list: removed.
    expect(team.bookkeeper).toEqual({ agentId: "gone", name: null, status: "terminated" });
    expect(team.operator).toEqual({ agentId: "op", name: "Olive", status: "active" });
    // Without the agents list the reported status stands.
    expect(flowTeam({ snapshots: [{ team: [{ role: "social", agentId: "so", status: "paused" }] }] }).social).toEqual({ agentId: "so", name: null, status: "paused" });
  });
});

describe("where the graph is switched off", () => {
  const stage = (key: string) => FLOW_STAGES[key]!;
  const team: FlowTeam = { "account-manager": { agentId: "am", name: "Ama", status: "active" }, bookkeeper: { agentId: "bk", name: "Bea", status: "idle" } };
  const on: OffInput = {
    modules: {},
    installed: { [P.billing]: { status: "ready" }, [P.payroll]: { status: "ready" }, [PLUGIN_KEY]: { status: "ready" } },
    setupStatuses: { [P.billing]: settings(), [P.payroll]: settings() },
    cockpitSettingsSaved: true,
    team,
  };

  it("runs when the module is on, installed, set up and its role has a running agent", () => {
    expect(stageOff(stage("quote.draft"), on)).toBeNull();
    // Stages that wait on a person or the customer need no agent.
    expect(stageOff(stage("invoice.open"), { ...on, team: {} })).toBeNull();
    // An agent whose status is unknown counts as running (like kit routeWork).
    expect(stageOff(stage("quote.draft"), { ...on, team: { "account-manager": { agentId: "am", name: null, status: null } } })).toBeNull();
  });

  it("a sales stage runs while the Account Manager covers its unstaffed role", () => {
    const am = { "account-manager": { agentId: "am", name: "Ama", status: "idle" } };
    expect(stageOff(stage("quote.draft"), { ...on, team: am })).toBeNull();
    expect(stageOff(stage("quote.draft"), { ...on, team: { "deal-desk": { agentId: "dd", name: "Dee", status: "idle" } } })).toBeNull();
    // Nobody to do it: the fix is the covering role.
    expect(stageOff(stage("quote.draft"), { ...on, team: {} })).toMatchObject({ key: "role:account-manager:none", reason: "No Account Manager yet", href: "/setup?section=team#team-account-manager" });
    // Its own agent is paused and nobody covers: that is the problem to fix.
    expect(stageOff(stage("quote.draft"), { ...on, team: { "deal-desk": { agentId: "dd", name: "Dee", status: "paused" } } })).toMatchObject({ key: "role:deal-desk:paused", reason: "Dee (Deal Desk) is paused" });
    expect(stageOff(stage("quote.draft"), { ...on, team: { ...am, "deal-desk": { agentId: "dd", name: "Dee", status: "paused" } } })).toBeNull();
  });

  it("says why, in plain words, with the Setup link that fixes it", () => {
    expect(stageOff(stage("quote.draft"), { ...on, modules: { billing: false } })).toEqual({ kind: "module", key: "module:billing", reason: "Billing is switched off in Setup", phrase: "Billing switched off", href: "/setup?section=modules" });
    expect(stageOff(stage("quote.draft"), { ...on, installed: {} })).toMatchObject({ kind: "installed", reason: "The Billing plugin is not installed", href: "/setup?section=checklist#module-billing" });
    expect(stageOff(stage("quote.draft"), { ...on, installed: { [P.billing]: { status: "error" } } })).toMatchObject({ kind: "installed", reason: "The Billing plugin is not running" });
    expect(stageOff(stage("quote.draft"), { ...on, setupStatuses: { [P.billing]: settings(false) } })).toMatchObject({ kind: "settings", reason: "Billing settings are not saved", phrase: "Billing settings not saved", href: "/setup?section=checklist#module-billing" });
    // A plugin that never reported its setup has not saved its settings (it reports once they are).
    expect(stageOff(stage("quote.draft"), { ...on, setupStatuses: {} })).toMatchObject({ kind: "settings" });
    // A status without a settings item, or no statuses known at all: the settings check says nothing.
    expect(stageOff(stage("quote.draft"), { ...on, setupStatuses: { [P.billing]: { items: [{ key: "sender", status: "missing" }] } } })).toBeNull();
    expect(stageOff(stage("quote.draft"), { ...on, setupStatuses: null })).toBeNull();
    // The Cockpit's own settings come from its saved flag.
    expect(stageOff(stage("onboarding.open"), { ...on, cockpitSettingsSaved: false })).toMatchObject({ kind: "settings", reason: "Cockpit settings are not saved", href: "/setup?section=checklist#module-cockpit" });
  });

  it("names the role, its agent and the agent's state", () => {
    const held = (status: string | null): OffInput => ({ ...on, team: { "account-manager": { agentId: "am", name: "Ama", status } } });
    expect(stageOff(stage("quote.draft"), { ...on, team: {} })).toEqual({ kind: "role", key: "role:account-manager:none", reason: "No Account Manager yet", phrase: "no Account Manager", href: "/setup?section=team#team-account-manager" });
    expect(stageOff(stage("quote.draft"), held("paused"))!.reason).toBe("Ama (Account Manager) is paused");
    expect(stageOff(stage("quote.draft"), held("error"))!.reason).toBe("Ama (Account Manager) stopped with an error");
    expect(stageOff(stage("quote.draft"), held("pending_approval"))!.reason).toBe("Ama (Account Manager) waits for hire approval");
    expect(stageOff(stage("quote.draft"), held("terminated"))!.reason).toBe("The Account Manager agent was removed");
    expect(stageOff(stage("onboarding.open"), on)).toMatchObject({ reason: "No Operator yet", href: "/setup?section=team#team-operator" });
    // EMP201 needs the Bookkeeper, whose module is Accounting.
    expect(stageOff(stage("payroll.emp201"), { ...on, modules: { accounting: false } })).toMatchObject({ kind: "role", reason: "No Bookkeeper: Accounting is switched off", href: "/setup?section=modules" });
  });

  it("gives the first cause: module, then install, then settings, then the role", () => {
    const everything = { modules: { billing: false }, installed: {}, setupStatuses: {}, cockpitSettingsSaved: false, team: {} };
    expect(stageOff(stage("quote.draft"), everything)!.kind).toBe("module");
    expect(stageOff(stage("quote.draft"), { ...everything, modules: {} })!.kind).toBe("installed");
    expect(stageOff(stage("quote.draft"), { ...everything, modules: {}, installed: null })!.kind).toBe("settings");
    expect(stageOff(stage("quote.draft"), { ...everything, modules: {}, installed: null, setupStatuses: null })!.kind).toBe("role");
    expect(settingsDone({ items: [{ key: "settings", status: "done" }] })).toBe(true);
    expect(settingsDone({ items: [] })).toBeNull();
    expect(settingsDone(null)).toBeNull();
  });
});

describe("the graph", () => {
  it("draws every flow in the kit's order with every stage, and says all flows run when nothing is off", () => {
    const view = buildFlows(staffed(everyStage()));
    expect(view.flows.map((f) => f.key)).toEqual(FLOWS.map((f) => f.key));
    for (const flow of view.flows) expect(flow.stages.map((s) => s.key)).toEqual(FLOWS.find((f) => f.key === flow.key)!.stages.map((s) => s.key));
    expect(view).toMatchObject({ total: 6, running: 6, off: 0, stages: 25, reported: 25, stuck: [], fixes: [], sentence: "All 6 flows are running." });
    // Who each stage waits on: the role's agent by name, you, the customer or the system.
    const at = (key: string) => view.flows.flatMap((f) => f.stages).find((s) => s.key === key)!;
    expect(at("lead.in").waits).toEqual({ kind: "agent", label: "Ama (Account Manager)", name: "Ama", role: "Account Manager" });
    expect(at("onboarding.open").waits.label).toBe("Olive (Operator)");
    expect(at("quote.approval").waits.label).toBe("You");
    expect(at("invoice.open").waits.label).toBe("The customer");
    expect(at("social.scheduled").waits.label).toBe("Automatic");
  });

  it("with no numbers and nobody staffed: every stage still shows, the off ones grouped by fix", () => {
    const view = buildFlows({ snapshots: [] });
    expect(view.reported).toBe(0);
    expect(view.flows.flatMap((f) => f.stages).every((s) => s.count === null && s.stuck === 0)).toBe(true);
    expect(view.fixes.map((f) => [f.reason, f.stages.length])).toEqual([
      ["No Account Manager yet", 6],
      ["No Bookkeeper yet", 3],
      ["No Operator yet", 1],
      ["No Payroll Clerk yet", 1],
      ["No SEO Specialist yet", 1],
      ["No Social agent yet", 1],
    ]);
    expect(view.sentence).toBe("0 of 6 flows are running; 13 stages are switched off: no Account Manager (6), no Bookkeeper (3), no Operator (1) and 3 more.");
  });

  it("puts stuck work first: the worst stages, and the flows that hold them", () => {
    const view = buildFlows(staffed(SOME));
    expect(view.stuck.map((s) => s.key)).toEqual(["bank.match", "lead.in", "invoice.open", "quote.approval"]);
    expect(view.stuckItems).toBe(8);
    expect(view.flows.map((f) => f.key)).toEqual(["lead-to-cash", "onboarding", "content", "campaigns", "books", "payroll"]);
    expect(view.flows[0]).toMatchObject({ stuck: 8, stuckStages: 4, reported: 4, items: 27, running: true });
    const invoices = view.stuck.find((s) => s.key === "invoice.open")!;
    expect(invoices).toMatchObject({ count: 5, stuck: 2, stuckReason: "2 overdue", amountMinor: 1_175_000, currency: "ZAR", oldestDays: 12, href: "/billing?tab=invoices", flowTitle: "Lead to cash", at: NOW.toISOString() });
    // Equal stuck: waiting on an agent before the customer; then the oldest.
    expect(stuckOrder({ key: "a", stuck: 2, waitingOn: "customer", oldestDays: 50 }, { key: "b", stuck: 2, waitingOn: "agent", oldestDays: 1 })).toBeGreaterThan(0);
    expect(stuckOrder({ key: "lead.in", stuck: 1, waitingOn: "agent", oldestDays: 2 }, { key: "deal.open", stuck: 1, waitingOn: "agent", oldestDays: 9 })).toBeGreaterThan(0);
  });

  it("keeps a switched-off stage's numbers, and only the owning plugin's", () => {
    const input = staffed({ [P.crm]: [{ stage: "lead.in", count: 7, stuck: 2 }] });
    const view = buildFlows({ ...input, agents: agents.filter((a) => a.id !== "am") });
    const leads = view.flows[0]!.stages[0]!;
    expect(leads).toMatchObject({ count: 7, stuck: 2, off: { reason: "The Account Manager agent was removed" } });
    expect(view.stuck.map((s) => s.key)).toEqual(["lead.in"]);
    // Billing cannot report the CRM's stage.
    const spoofed = buildFlows({ ...staffed(), snapshots: [snap(P.billing, { flows: [{ stage: "lead.in", count: 99, stuck: 99 }] })] });
    expect(spoofed.flows[0]!.stages[0]!.count).toBeNull();
  });

  it("words the sentence for one fix, several, and more than three", () => {
    const fix = (phrase: string, n: number) => ({ key: phrase, kind: "role" as const, reason: phrase, phrase, href: "/setup", stages: Array.from({ length: n }, () => ({}) as never) });
    expect(flowsSentence({ running: 5, total: 6, off: 2, fixes: [fix("no Bookkeeper", 2)] })).toBe("5 of 6 flows are running; 2 stages are switched off: no Bookkeeper.");
    expect(flowsSentence({ running: 4, total: 6, off: 3, fixes: [fix("no Account Manager", 2), fix("Mailbox settings not saved", 1)] })).toBe("4 of 6 flows are running; 3 stages are switched off: no Account Manager (2) and Mailbox settings not saved (1).");
    expect(flowsSentence({ running: 1, total: 6, off: 1, fixes: [fix("Social not installed", 1)] })).toBe("1 of 6 flows is running; 1 stage is switched off: Social not installed.");
    expect(flowsSentence({ running: 6, total: 6, off: 0, fixes: [] })).toBe("All 6 flows are running.");
  });

  it("reads the stored setup statuses from the Cockpit, else from Setup; unknown before any plugin reported", () => {
    expect(knownSetupStatuses({ setupStatuses: {} }, null)).toBeNull();
    expect(knownSetupStatuses({ setupStatuses: {} }, { [P.crm]: null })).toBeNull();
    const merged = knownSetupStatuses({ setupStatuses: { [P.crm]: settings(true) } }, { [P.crm]: settings(false), [P.billing]: settings(false) })!;
    expect(settingsDone(merged[P.crm])).toBe(true);
    expect(settingsDone(merged[P.billing])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

const load: LoadResult = { roles: null, rolesSavedAt: null, settingsSaved: false, snapshots: {}, setupStatuses: {}, own: null, team: null, healthIssueId: null };

describe("the Flows tab", () => {
  it("opens with ?tab=flows", () => {
    expect(tabFromSearch("?tab=flows")).toBe("flows");
  });

  it("with no numbers: the sentence, what to switch back on, every stage in order, and a note", () => {
    const view = buildFlows({ snapshots: [] });
    const html = render(createElement(FlowsPanel, { view, linkFor }));
    expect(html).toContain(view.sentence);
    expect(html).toContain("Switch these back on");
    expect(html).toContain("No module reports its numbers yet.");
    expect(html).toContain('href="/PIB/setup?section=team#team-account-manager"');
    expect(html).not.toContain("Stuck now");
    for (const flow of FLOWS) {
      expect(html, flow.title).toContain(flow.title);
      // Stages appear in the graph's order.
      const positions = flow.stages.map((s) => html.indexOf(`data-stage="${s.key}"`));
      expect(positions.every((p, i) => p > 0 && (i === 0 || p > positions[i - 1]!)), flow.key).toBe(true);
    }
    // Off stages are muted with their reason and a fix; nothing is linked to a page that may not exist.
    expect(html).toMatch(/data-stage="lead.in" data-state="off"/);
    expect(html).toContain("No Account Manager yet");
    // A wide card draws each flow as a line of its stages.
    expect(html).toContain('class="pib-flow pib-flow-n9"');
    expect(html).toContain("@container pib-flow (min-width:828px)");
  });

  it("with some numbers: stuck work first, grouped by who it waits on, with links, amounts and reasons", () => {
    const view = buildFlows(staffed(SOME));
    const html = render(createElement(FlowsPanel, { view, linkFor }));
    expect(html).toContain("8 stuck in 4 stages");
    expect(html).toContain("Stuck now");
    const groups = ["Waiting on you (1)", "Waiting on agents (2)", "Waiting on customers (1)"].map((text) => html.indexOf(text));
    expect(groups.every((p, i) => p > 0 && (i === 0 || p > groups[i - 1]!))).toBe(true);
    const rows = [...html.matchAll(/data-stuck="([a-z.]+)"/g)].map((m) => m[1]);
    expect(rows).toEqual(["quote.approval", "bank.match", "lead.in", "invoice.open"]);
    // Money keeps "R" and the amount together (a non-breaking space).
    for (const text of ["2 overdue", "oldest 12 days", "R\u00A011,750.00", "waits on Bea (Bookkeeper)", "2 of 5 stuck", "1 waiting over a day"]) expect(html, text).toContain(text);
    expect(html).toContain('href="/PIB/billing?tab=invoices"');
    // The flow with stuck work comes first; the stations show counts and who they wait on.
    expect(html.indexOf('id="flow-lead-to-cash"')).toBeLessThan(html.indexOf('id="flow-onboarding"'));
    expect(html).toMatch(/data-stage="invoice.open" data-state="stuck"/);
    expect(html).toContain("21 stages have no numbers yet");
    expect(html).not.toContain("Switch these back on");
  });

  it("with every number and nothing off: all running, nothing stuck", () => {
    const view = buildFlows(staffed(everyStage(2)));
    const html = render(createElement(FlowsPanel, { view, linkFor }));
    expect(html).toContain("All 6 flows are running.");
    expect(html).toContain("Nothing is stuck");
    expect(html).not.toContain("Fix in Setup");
    expect(html).not.toContain("no numbers yet");
    expect(numbersNote(view)).toBeNull();
    // Still phone-friendly: nothing wider than a phone outside the container rules.
    expect(html.replace(/<style>[\s\S]*?<\/style>/g, "").match(/(?<![-\w])width:\s?(1[0-9]{3}|[4-9][0-9]{2})px/g)).toBeNull();
  });

  it("small pieces: stage states, counts, flow statuses, stage lists, the phone's stuck cap", () => {
    expect(stageState({ off: null, stuck: 0, count: null })).toBe("none");
    expect(stageState({ off: null, stuck: 0, count: 0 })).toBe("empty");
    expect(stageState({ off: null, stuck: 1, count: 3 })).toBe("stuck");
    expect(stageState({ off: { kind: "role", key: "k", reason: "r", phrase: "p", href: "/" }, stuck: 1, count: 3 })).toBe("off");
    expect([countText(7), countText(1234), countText(14_600)]).toEqual(["7", "1.2k", "15k"]);
    const view = buildFlows(staffed(SOME));
    expect(flowStatus(view.flows[0]!)).toEqual({ text: "8 stuck", tone: "warn" });
    expect(flowStatus(buildFlows({ snapshots: [] }).flows.find((f) => f.key === "onboarding")!)).toEqual({ text: "1 of 2 stages off", tone: "neutral" });
    expect(flowStatus(view.flows[1]!)).toEqual({ text: "Running", tone: "ok" });
    expect(stageList([{ label: "A" }, { label: "B" }])).toBe("2 stages off: A and B");
    expect(stageList([{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }, { label: "E" }])).toBe("5 stages off: A, B, C and 2 more");
    // The phone's first five: waiting on you first, then the worst agent stages.
    expect(stuckGroups(view.stuck, 2).map((g) => [g.kind, g.stages.map((s) => s.key)])).toEqual([["person", ["quote.approval"]], ["agent", ["bank.match"]]]);
  });
});

describe("the Overview's flows summary", () => {
  it("has the sentence, each flow as a row linking to its place on the tab, and the Flows tab link", () => {
    const view = buildFlows(staffed(SOME));
    const html = render(createElement(FlowsSummary, { view, linkFor }));
    expect(html).toContain(view.sentence);
    expect(html).toContain('href="/PIB/cockpit?tab=flows"');
    for (const flow of FLOWS) expect(html).toContain(`href="/PIB/cockpit?tab=flows#flow-${flow.key}"`);
    expect(html).toContain("8 stuck");
    expect(html).not.toContain("Fix in Setup");
  });

  it("sits on the Overview, built from the same view", () => {
    const view = buildView({
      load,
      installed: null,
      modules: null,
      live: { [P.billing]: snap(P.billing, { flows: [{ stage: "invoice.open", count: 3, stuck: 1, stuckReason: "1 overdue" }] }) },
      now: NOW,
      windowMs: 86_400_000,
    });
    expect(view.flows.stuck.map((s) => s.key)).toEqual(["invoice.open"]);
    const html = render(createElement(Overview, { view, load, linkFor, windowHours: 24, onWindow: () => undefined, now: NOW }));
    expect(html).toContain('id="flows"');
    expect(html).toContain("Open Flows →");
    expect(html.indexOf('id="waiting"')).toBeLessThan(html.indexOf('id="flows"'));
  });
});
