/**
 * What the Cockpit does with other plugins' reports and hand-offs: the team
 * in roles.updated, onboarding on a first won deal, paid invoices as
 * activity, unassigned work, and warnings that last longer than a day.
 */
import { describe, expect, it, vi } from "vitest";
import { COCKPIT_EVENTS, PIB_PLUGINS, type CockpitSnapshot, type RolesPayload } from "@partnersinbiz/pib-plugin-kit";
import { companyBrief } from "../src/brief.js";
import { collectProblems, healthIssueContent, refreshHealthIssue, warningAgeMs } from "../src/health.js";
import { parseSnapshot, teamSignature, unassignedWaiting } from "../src/merge.js";
import { clientRefOf, onboardingContent, onDealWon, onInvoicePaid } from "../src/onboarding.js";
import { ownSnapshot } from "../src/own.js";
import { createEnv, onSnapshotEvent, registerCockpit } from "../src/register.js";
import { fullRolesPayload, reemitRoles, routeFromRoles, saveTeam } from "../src/roles.js";
import { getRoles } from "../src/db.js";
import { fakeCtx, fixedClock, type FakeAgent } from "./helpers/fake-ctx.js";

// The extra checks (checks.ts) have their own specs; here the Cockpit's other behaviour is tested on a quiet baseline.
vi.mock("../src/checks.js", async (original) => ({ ...(await original<typeof import("../src/checks.js")>()), extraChecks: async () => ({ health: [], kpis: [], quality: [], waiting: [] }) }));

const A = "company-a";
const NOW = "2026-09-26T10:00:00.000Z";

const agents: FakeAgent[] = [
  { id: "op", companyId: A, name: "Olive", status: "active" },
  { id: "rev", companyId: A, name: "Rex", status: "active" },
  { id: "am", companyId: A, name: "Ama", status: "active" },
  { id: "seo", companyId: A, name: "Sam", status: "paused" },
  { id: "soc", companyId: A, name: "Sol", status: "idle" },
];

function setup(options: Parameters<typeof fakeCtx>[0] = {}) {
  const fake = fakeCtx({ savedConfigs: { [A]: { healthIssue: true } }, prefixes: { [A]: "PIB" }, agents: agents.map((a) => ({ ...a })), ...options });
  const clock = fixedClock(NOW);
  const env = createEnv(fake.ctx, clock.now);
  registerCockpit(fake.ctx, env);
  return { ...fake, env, clock };
}

const snap = (plugin: string, extra: Partial<CockpitSnapshot> & Record<string, unknown> = {}) => ({ plugin, title: plugin.split(".")[1]!, checkedAt: NOW, kpis: [], health: [], waiting: [], activity: [], quality: [], ...extra });

const rolesEvents = (emitted: Array<{ name: string; payload: unknown }>) => emitted.filter((e) => e.name === COCKPIT_EVENTS.rolesUpdated).map((e) => e.payload as RolesPayload);

describe("roles.updated carries statuses and the team", () => {
  it("keeps only roles a plugin owns from its snapshot", () => {
    const parsed = parseSnapshot(snap(PIB_PLUGINS.crm, { team: [{ role: "account-manager", agentId: "am", status: "active" }, { role: "operator", agentId: "evil" }, { role: "account-manager", agentId: "twice" }] }), PIB_PLUGINS.crm)!;
    expect(parsed.team).toEqual([{ role: "account-manager", agentId: "am", status: "active" }]);
    expect(parseSnapshot(snap(PIB_PLUGINS.crm), PIB_PLUGINS.crm)!.team).toBeUndefined();
    expect(teamSignature([{ role: "social", agentId: "a", status: "idle" }])).not.toBe(teamSignature([{ role: "social", agentId: "a", status: "paused" }]));
  });

  it("fills statuses from the agents and team from the snapshots, and re-sends when a role changes", async () => {
    const s = setup();
    await saveTeam(s.env, A, { operatorAgentId: "op", reviewerAgentId: "rev" }, "user-1");
    s.emitted.length = 0;
    await onSnapshotEvent(s.env, PIB_PLUGINS.crm, { companyId: A, payload: snap(PIB_PLUGINS.crm, { team: [{ role: "account-manager", agentId: "am", status: "active" }] }) });
    await onSnapshotEvent(s.env, PIB_PLUGINS.seo, { companyId: A, payload: snap(PIB_PLUGINS.seo, { team: [{ role: "seo-specialist", agentId: "seo", status: "active" }] }) });
    const sent = rolesEvents(s.emitted);
    expect(sent).toHaveLength(2);
    // The agent record wins over what the snapshot said (Sam is paused now).
    expect(sent.at(-1)).toMatchObject({
      operatorStatus: "active",
      reviewerStatus: "active",
      team: { operator: { agentId: "op", status: "active" }, reviewer: { agentId: "rev", status: "active" }, "account-manager": { agentId: "am", status: "active" }, "seo-specialist": { agentId: "seo", status: "paused" } },
    });
    // The same team again: nothing re-sent.
    s.emitted.length = 0;
    await onSnapshotEvent(s.env, PIB_PLUGINS.crm, { companyId: A, payload: snap(PIB_PLUGINS.crm, { checkedAt: "2026-09-26T11:00:00.000Z", team: [{ role: "account-manager", agentId: "am", status: "active" }] }) });
    expect(rolesEvents(s.emitted)).toHaveLength(0);
    // A new agent in the role: re-sent at once.
    await onSnapshotEvent(s.env, PIB_PLUGINS.crm, { companyId: A, payload: snap(PIB_PLUGINS.crm, { checkedAt: "2026-09-26T12:00:00.000Z", team: [{ role: "account-manager", agentId: "soc", status: "idle" }] }) });
    expect(rolesEvents(s.emitted).at(-1)!.team!["account-manager"]).toEqual({ agentId: "soc", status: "idle" });
    // Hourly: the full payload too.
    s.emitted.length = 0;
    await reemitRoles(s.env);
    expect(rolesEvents(s.emitted)[0]!.team!["seo-specialist"]).toEqual({ agentId: "seo", status: "paused" });
  });

  it("a removed agent is sent as terminated, so plugins stop routing to it", async () => {
    const s = setup();
    await saveTeam(s.env, A, { operatorAgentId: "op" }, "user-1");
    s.agents.splice(s.agents.findIndex((a) => a.id === "op"), 1);
    const payload = await fullRolesPayload(s.env, (await getRoles(s.ctx, A))!);
    expect(payload.operatorStatus).toBe("terminated");
    expect(routeFromRoles(payload, ["operator"])).toEqual({ assigneeAgentId: null, assigneeUserId: "user-1", via: "owner" });
  });

  it("routes like kit routeWork: the role, else the Operator, else the owner, else nobody", () => {
    const base: RolesPayload = { companyId: A, operatorAgentId: "op", reviewerAgentId: null, ownerUserId: "user-1", reviewOutward: false, updatedAt: NOW, operatorStatus: "active", team: { social: { agentId: "soc", status: "idle" }, "seo-specialist": { agentId: "seo", status: "paused" } } };
    expect(routeFromRoles(base, ["social"])).toMatchObject({ assigneeAgentId: "soc", via: "social" });
    expect(routeFromRoles(base, ["seo-specialist"])).toMatchObject({ assigneeAgentId: "op", via: "operator" });
    expect(routeFromRoles({ ...base, operatorStatus: "paused" }, ["seo-specialist"])).toMatchObject({ assigneeUserId: "user-1", via: "owner" });
    expect(routeFromRoles(null, ["social"])).toEqual({ assigneeAgentId: null, assigneeUserId: null, via: "none" });
  });
});

describe("onboarding on a first won deal", () => {
  const won = (extra: Record<string, unknown> = {}) => ({
    companyId: A,
    payload: { key: "crm:deal:d1:won", dealId: "d1", title: "Website retainer", valueMinor: 1_200_000, currency: "ZAR", clientKind: "company", clientRef: "nw", clientName: "Northwind Traders", firstWin: true, wonAt: "2026-09-26T09:00:00.000Z", ...extra },
  });

  it("opens ONE onboarding issue for the Operator with a deep link per module", async () => {
    const s = setup();
    await saveTeam(s.env, A, { operatorAgentId: "op" }, "user-1");
    await onSnapshotEvent(s.env, PIB_PLUGINS.crm, { companyId: A, payload: snap(PIB_PLUGINS.crm, { team: [{ role: "account-manager", agentId: "am", status: "active" }] }) });
    await s.fire(`plugin.${PIB_PLUGINS.crm}.deal.won`, won());
    const issues = [...s.issues.values()].filter((i) => i.originKind === "plugin:partnersinbiz.cockpit:onboarding");
    expect(issues).toHaveLength(1);
    const issue = issues[0]!;
    expect(issue).toMatchObject({ title: "Onboard new client: Northwind Traders (company:nw)", assigneeAgentId: "op", status: "todo", priority: "high", originId: "cockpit:onboarding:company:nw" });
    expect(s.wakeups).toContain(issue.id);
    for (const text of [
      "deal **Website retainer** (R 12,000.00) was won on 2026-09-26",
      "**Account Manager** (Ama): fill the client profile (`partnersinbiz.crm:update-client-profile`",
      "set up the retainer or subscription in Billing",
      "[Client workspace](/PIB/crm?client=company:nw)",
      "[Billing](/PIB/billing?client=company:nw&tab=retainers)",
      "ONE `partnersinbiz.cockpit:ask-owner` (kind `grant`, client `company:nw`)",
      "[Social accounts](/PIB/social?client=company:nw&tab=accounts)",
      "[SEO](/PIB/seo?client=company:nw&tab=integrations)",
      "**SEO Specialist** (not staffed",
      "`partnersinbiz.seo:create-sprint` with `client: company:nw`",
      "**Social agent** (not staffed",
      "**Done when** every module shows the client",
    ]) expect(issue.description, text).toContain(text);
    // Re-sent, or a second "first" deal for the same client: still one issue.
    await s.fire(`plugin.${PIB_PLUGINS.crm}.deal.won`, won());
    await s.fire(`plugin.${PIB_PLUGINS.crm}.deal.won`, won({ key: "crm:deal:d2:won", dealId: "d2" }));
    expect([...s.issues.values()].filter((i) => i.originKind === "plugin:partnersinbiz.cockpit:onboarding")).toHaveLength(1);
    // Activity: both deals and the onboarding.
    const activity = (await ownSnapshot(s.env, A)).activity.map((a) => a.text);
    expect(activity).toEqual(expect.arrayContaining(["Won Website retainer for Northwind Traders (R 12,000.00): a new client", "Opened onboarding for Northwind Traders (Operator)"]));
  });

  it("falls back to the owner without an Operator, skips switched-off modules, and a later win is only activity", async () => {
    const s = setup();
    await saveTeam(s.env, A, {}, "user-1");
    await s.ctx.state.set({ scopeKind: "company", scopeId: A, namespace: "pib-setup", stateKey: "modules" }, { companyId: A, modules: { social: false, seo: false }, updatedAt: NOW });
    const result = await onDealWon(s.env, won({ clientRef: "company:bs", clientName: "Brightside" }));
    expect(result.onboarding).toMatchObject({ action: "opened" });
    const issue = [...s.issues.values()].find((i) => i.originKind === "plugin:partnersinbiz.cockpit:onboarding")!;
    expect(issue).toMatchObject({ assigneeUserId: "user-1", title: "Onboard new client: Brightside (company:bs)" });
    expect(issue.description).not.toContain("/social");
    expect(issue.description).not.toContain("/seo");
    expect(issue.description).not.toContain("ask-owner");
    const later = await onDealWon(s.env, won({ key: "crm:deal:d9:won", clientRef: "bs", firstWin: false }));
    expect(later).toEqual({ recorded: true, onboarding: null });
    expect(await onDealWon(s.env, { companyId: A, payload: { key: "x" } })).toEqual({ recorded: false, onboarding: null });
  });

  it("reads the client from either event shape", () => {
    expect(clientRefOf("company", "nw")).toBe("company:nw");
    expect(clientRefOf("contact", "ct1")).toBe("contact:ct1");
    expect(clientRefOf(null, "company:nw")).toBe("company:nw");
    expect(clientRefOf("company", "bad id!")).toBeNull();
    const content = onboardingContent({ clientRef: "contact:ct1", clientName: "Thabo", dealTitle: "Logo", dealValue: null, wonAt: NOW, prefix: null, modules: { crm: true, billing: false, social: false, seo: false }, staff: {} });
    expect(content.description).toContain("[Client workspace](/crm?client=contact:ct1)");
    expect(content.description).not.toContain("Billing");
  });

  it("the canary client's won deal is a rehearsal: no onboarding issue, no activity, and a second client still onboards", async () => {
    const s = setup();
    await saveTeam(s.env, A, { operatorAgentId: "op" }, "user-1");
    const canary = await onDealWon(s.env, won({ clientRef: "company:canary-1a2b3c4d", clientName: "PiB Canary Co" }));
    expect(canary).toEqual({ recorded: false, onboarding: null });
    expect([...s.issues.values()].filter((i) => i.originKind === "plugin:partnersinbiz.cockpit:onboarding")).toEqual([]);
    expect((await ownSnapshot(s.env, A)).activity).toEqual([]);
    // A real client whose id merely starts the same way is not the canary (the id must be company:canary-<hash>).
    const real = await onDealWon(s.env, won({ key: "crm:deal:d7:won", clientRef: "company:canary", clientName: "Canary Cages" }));
    expect(real.onboarding).toMatchObject({ action: "opened" });
    const spoof = await onDealWon(s.env, won({ key: "crm:deal:d8:won", clientRef: "contact:canary-1a2b3c4d", clientName: "Contact Canary" }));
    expect(spoof.onboarding).toMatchObject({ action: "opened" });
  });

  it("a test payment by the canary client is no revenue and no activity, but a real client's payment still counts", async () => {
    const s = setup();
    const paid = (key: string, clientRef: string) => ({ companyId: A, payload: { key, invoiceId: key, number: "INV-000099", clientKind: "company", clientRef, totalMinor: 500_000, currency: "ZAR", paidAt: "2026-09-26T08:00:00.000Z" } });
    expect(await onInvoicePaid(s.env, paid("billing:invoice:c1:paid", "company:canary-1a2b3c4d"))).toBe(false);
    expect((await ownSnapshot(s.env, A)).activity).toEqual([]);
    expect(await onInvoicePaid(s.env, paid("billing:invoice:r1:paid", "company:nw"))).toBe(true);
    expect((await ownSnapshot(s.env, A)).activity.map((a) => a.text)).toEqual(["INV-000099 paid in full (R 5,000.00)"]);
  });

  it("records a paid invoice as activity (once)", async () => {
    const s = setup();
    const event = { companyId: A, payload: { key: "billing:invoice:i1:paid", invoiceId: "i1", number: "INV-000012", clientKind: "company", clientRef: "nw", totalMinor: 1_234_567, currency: "ZAR", paidAt: "2026-09-26T08:00:00.000Z" } };
    expect(await onInvoicePaid(s.env, event)).toBe(true);
    expect(await onInvoicePaid(s.env, event)).toBe(false);
    await s.fire(`plugin.${PIB_PLUGINS.billing}.invoice.paid`, { ...event, payload: { ...event.payload, key: "billing:invoice:i2:paid", number: "INV-000013", clientRef: null } });
    const activity = (await ownSnapshot(s.env, A)).activity;
    expect(activity.map((a) => [a.text, a.href])).toEqual([
      ["INV-000012 paid in full (R 12,345.67)", "/billing?client=company:nw&tab=invoices"],
      ["INV-000013 paid in full (R 12,345.67)", "/billing?tab=invoices"],
    ]);
  });
});

describe("unassigned work", () => {
  it("counts open issues nobody holds (older than a day) and lists the top five, most urgent first", async () => {
    const old = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    const rows = [
      { id: "u1", company_id: A, identifier: "PIB-1", title: "Bank statement received", status: "todo", priority: "medium", created_at: old(3) },
      { id: "u2", company_id: A, identifier: "PIB-2", title: "Campaign step 2", status: "todo", priority: "high", created_at: old(2) },
      { id: "u3", company_id: A, identifier: "PIB-3", title: "Fresh", status: "todo", priority: "high", created_at: old(0.5) },
      { id: "u4", company_id: A, identifier: "PIB-4", title: "Held by Sam", status: "todo", priority: "high", assignee_agent_id: "seo", created_at: old(5) },
      { id: "u5", company_id: A, identifier: "PIB-5", title: "Done", status: "done", priority: "high", created_at: old(5) },
    ];
    const s = setup({ coreIssues: rows });
    await saveTeam(s.env, A, { operatorAgentId: "op" }, "user-1");
    const brief = await companyBrief(s.env, A);
    expect(brief.unassigned).toEqual({ count: 2, items: [expect.objectContaining({ issue: "PIB-2", href: "/PIB/issues/PIB-2" }), expect.objectContaining({ issue: "PIB-1" })] });
    const item = brief.waiting.find((w) => w.title === "2 open issues have nobody assigned")!;
    expect(item).toMatchObject({ kind: "other", examples: [expect.objectContaining({ title: "PIB-2 Campaign step 2", href: "/PIB/issues/PIB-2" }), expect.objectContaining({ title: "PIB-1 Bank statement received" })] });
    expect(unassignedWaiting({ count: 0, items: [] })).toEqual([]);
    expect(unassignedWaiting({ count: 1, items: [{ id: "x", identifier: "PIB-9", title: "One", createdAt: null }] })[0]).toMatchObject({ title: "1 open issue has nobody assigned", href: "/issues/PIB-9" });
    // The page gets the same from cockpit.load.
    const load = (await s.actions.get("cockpit.load")!({}, { companyId: A, actor: { type: "user", userId: "user-1" } })) as { unassigned: { count: number } };
    expect(load.unassigned.count).toBe(2);
  });
});

describe("warnings that last more than a day reach the System health issue", () => {
  it("tracks when each warning started and escalates it after 24 hours", async () => {
    const s = setup();
    await saveTeam(s.env, A, { operatorAgentId: "op" }, "user-1");
    s.store.snapshots = [{ company_id: A, plugin_key: PIB_PLUGINS.mailbox, kind: "cockpit", payload: snap(PIB_PLUGINS.mailbox, { health: [{ key: "stuck", title: "3 sends stuck", status: "warn", fix: "Reconnect Gmail" }] }), checked_at: NOW, received_at: NOW }];
    expect(await refreshHealthIssue(s.env, A)).toMatchObject({ action: "none" });
    expect(s.store.health_warnings).toEqual([expect.objectContaining({ company_id: A, key: `${PIB_PLUGINS.mailbox}:stuck`, first_seen_at: NOW })]);
    s.clock.set("2026-09-27T10:30:00.000Z");
    // The plugin still reports every hour (else it is also "not reporting").
    Object.assign(s.store.snapshots![0]!, { checked_at: "2026-09-27T10:00:00.000Z" });
    s.store.snapshots![0]!.payload.checkedAt = "2026-09-27T10:00:00.000Z";
    const result = await refreshHealthIssue(s.env, A);
    expect(result).toMatchObject({ action: "created", problems: 1 });
    const issue = s.issues.get((result as { issueId: string }).issueId)!;
    expect(issue.description).toContain("**Warning: 3 sends stuck** — Unresolved for more than a day.");
    expect(issue).toMatchObject({ assigneeAgentId: "op", priority: "medium" });
    // Cleared: forgotten, and the issue closes.
    s.store.snapshots![0]!.payload.health = [];
    expect(await refreshHealthIssue(s.env, A)).toMatchObject({ action: "closed" });
    expect(s.store.health_warnings).toEqual([]);
  });

  it("a warning that says it started more than a day ago escalates at once; the brief never writes", async () => {
    const s = setup();
    await saveTeam(s.env, A, {}, "user-1");
    const since = "2026-09-24T08:00:00.000Z";
    s.store.snapshots = [{ company_id: A, plugin_key: PIB_PLUGINS.billing, kind: "cockpit", payload: snap(PIB_PLUGINS.billing, { health: [{ key: "pop", title: "Proof of payment waiting", status: "warn", since }, { key: "new", title: "New warning", status: "warn" }] }), checked_at: NOW, received_at: NOW }];
    const problems = await collectProblems(s.env, A);
    expect(problems.entries.map((e) => e.title)).toContain("Proof of payment waiting");
    expect(problems.entries.map((e) => e.title)).not.toContain("New warning");
    expect(s.store.health_warnings ?? []).toEqual([]);
    expect(warningAgeMs({ since: null }, "2026-09-25T09:00:00.000Z", new Date(NOW))).toBe(25 * 3_600_000);
    expect(healthIssueContent(problems.entries.filter((e) => e.plugin === PIB_PLUGINS.billing), "PIB")!.description).toContain("Warning: Proof of payment waiting");
  });
});
