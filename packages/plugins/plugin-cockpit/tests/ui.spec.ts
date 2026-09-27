import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CockpitSnapshot } from "@partnersinbiz/pib-plugin-kit/cockpit";
import { PLUGIN_KEY } from "../src/constants.js";
import { buildView, Overview } from "../src/ui/index.js";
import { TodayCard, fixLabel, isTeamSetupHref } from "../src/ui/components.js";
import type { LoadResult } from "../src/view.js";

const NOW = new Date("2026-09-26T10:00:00.000Z");
const linkFor = (href: string) => ({ href: `/PIB${href}` });
const snap = (plugin: string, extra: Partial<CockpitSnapshot> = {}): CockpitSnapshot => ({ plugin, title: plugin.split(".")[1]!, checkedAt: NOW.toISOString(), kpis: [], health: [], waiting: [], activity: [], quality: [], ...extra });

const load: LoadResult = {
  roles: null,
  rolesSavedAt: null,
  settingsSaved: false,
  snapshots: {},
  setupStatuses: {},
  // The Cockpit's own snapshot: a role problem links to Setup → Team.
  own: snap(PLUGIN_KEY, { title: "Cockpit", health: [{ key: "operator", title: "Operator", status: "warn", detail: "Olive (paused).", fix: "Resume it.", href: "/setup?section=team#team-operator" }] }),
  team: null,
  healthIssueId: "issue-9",
};

function view() {
  return buildView({
    load,
    installed: null,
    modules: null,
    live: {
      "partnersinbiz.billing": snap("partnersinbiz.billing", {
        title: "Billing",
        kpis: [{ key: "overdue", label: "Overdue invoices", value: "R 12,400", tone: "bad", group: "money", href: "/billing" }],
        health: [{ key: "outbox", title: "Cross-plugin deliveries", status: "bad", detail: "2 failed", fix: "Retry them", href: "/billing" }],
        waiting: [{ key: "approval:1", title: "Send INV-000012 to Northwind", why: "Money goes out in your name.", kind: "money", href: "/issues/PIB-3", issueId: "i3" }],
        activity: [{ at: "2026-09-26T09:00:00.000Z", text: "Posted JNL-000012", agentId: "a1" }],
      }),
    },
    agents: [{ id: "a1", name: "Bookkeeper", status: "active", budgetMonthlyCents: 2000, spentMonthlyCents: 1900 }],
    backup: { mtime: "2026-09-26T09:30:00.000Z", ageHours: 0.5 },
    now: NOW,
    windowMs: 86_400_000,
  });
}

describe("Cockpit page", () => {
  it("renders every section with links, KPIs, agents and health", () => {
    const html = renderToStaticMarkup(createElement(Overview, { view: view(), load, linkFor, windowHours: 24, onWindow: () => undefined, now: NOW }));
    for (const text of ["Today", "Waiting on you (1)", "Send INV-000012 to Northwind", "Money goes out in your name.", "Money", "Overdue invoices", "R 12,400", "What the agents did", "Posted JNL-000012", "Agents", "Bookkeeper", "Used 95% of its $20.00 monthly budget", "$19.00 of $20.00", "System health", "Cross-plugin deliveries", "Fix: </span>Retry them", "No Operator yet", "Open the System health issue"]) {
      expect(html, text).toContain(text);
    }
    // Groups with nothing to report stay out of the way; an up-to-date backup (an ok check) sits behind Show all.
    for (const text of ["Pipeline", "Marketing", "Delivery", "Last database backup"]) expect(html, text).not.toContain(text);
    // One status pill per agent row, no second "Budget 80%+" chip.
    expect(html).not.toContain("Budget 80%+");
    expect(html).toContain('href="/PIB/issues/PIB-3"');
    expect(html).toContain('href="/PIB/issues/issue-9"');
    // No Team tab: the Operator banner and role problems go to Setup → Team.
    expect(html).toContain('href="/PIB/setup?section=team#team-operator"');
    expect(html.match(/Fix in Setup/g)).toHaveLength(2);
    expect(html).not.toContain("Set up the team");
    // Phone-friendly: wrapping grids and a scrollable table, no fixed page widths.
    expect(html).toContain("minmax(min(420px, 100%), 1fr)");
    expect(html).toContain("overflow-x:auto");
    // Only the agents table has a minimum width, and it sits in the scroll wrapper.
    expect(html.match(/(?<![-\w])width:\s?(1[0-9]{3}|[4-9][0-9]{2})px/g)).toBeNull();
    expect(html.match(/min-width:\s?[3-9]\d{2,}px/g)).toEqual(["min-width:640px"]);
  });

  it("hides the Operator banner once an Operator is linked", () => {
    const linked: LoadResult = { ...load, roles: { companyId: "c", operatorAgentId: "op", reviewerAgentId: null, ownerUserId: null, reviewOutward: false, updatedAt: NOW.toISOString() } };
    const html = renderToStaticMarkup(createElement(Overview, { view: view(), load: linked, linkFor, windowHours: 24, onWindow: () => undefined, now: NOW }));
    expect(html).not.toContain("No Operator yet");
    // The paused Operator's health check still links to Setup → Team.
    expect(html.match(/Fix in Setup/g)).toHaveLength(1);
  });

  it("labels links to Setup → Team 'Fix in Setup'", () => {
    expect(isTeamSetupHref("/setup?section=team#team-bookkeeper")).toBe(true);
    expect(isTeamSetupHref("/setup")).toBe(false);
    expect(isTeamSetupHref(null)).toBe(false);
    expect(fixLabel("/setup?section=team", "Fix")).toBe("Fix in Setup");
    expect(fixLabel("/billing", "Fix")).toBe("Fix");
  });

  it("shows questions from agents first: money and legal red, the rest amber, with age, the question and an Answer link", () => {
    const asks = [
      { id: "q1", issueId: "i7", identifier: "PIB-7", issueTitle: "Refund", kind: "money" as const, question: "Refund Northwind's R 5,000 deposit?", options: ["Refund in full", "Credit note"], why: "They cancelled within 7 days.", askedBy: "Ama", askedByAgentId: "am", askedAt: "2026-09-26T07:00:00.000Z", updatedAt: "2026-09-26T07:00:00.000Z", dueBy: "2026-09-30", clientRef: "company:nw", clientName: "Northwind" },
      { id: "q2", issueId: "i8", identifier: "PIB-8", issueTitle: "GSC", kind: "grant" as const, question: "Give Search Console access?", options: [], why: "The audit waits on it.", askedBy: "Sam", askedByAgentId: "seo", askedAt: "2026-09-25T10:00:00.000Z", updatedAt: "2026-09-25T10:00:00.000Z", dueBy: null, clientRef: null, clientName: null },
    ];
    const withAsks: LoadResult = { ...load, asks, unassigned: { count: 3, items: [{ id: "u1", identifier: "PIB-20", title: "Bank statement received", createdAt: "2026-09-24T10:00:00.000Z" }] } };
    const v = buildView({ load: withAsks, installed: null, modules: null, live: { "partnersinbiz.billing": snap("partnersinbiz.billing", { waiting: [{ key: "approval:1", title: "Send INV-000012", why: "Money goes out.", kind: "money", issueId: "i3", href: "/issues/PIB-3" }] }) }, now: NOW, windowMs: 86_400_000 });
    // Asks first (oldest first within the kind order: money, then grant), then the plugin's money item, then unassigned work.
    expect(v.waiting.map((w) => w.key)).toEqual(["ask:q1", "ask:q2", "approval:1", "unassigned-issues"]);
    const html = renderToStaticMarkup(createElement(Overview, { view: v, load: withAsks, linkFor, windowHours: 24, onWindow: () => undefined, now: NOW }));
    for (const text of ["2 questions from agents", "Refund Northwind&#x27;s R 5,000 deposit?", "Refund in full", "(recommended)", "They cancelled within 7 days.", "Ama asked 3 hours ago · needed by 30 Sep · for Northwind", "Sam asked 24 hours ago", "Answer →", "2 questions", "3 open issues have nobody assigned", "PIB-20 Bank statement received", "Questions from agents first"]) expect(html, text).toContain(text);
    expect(html).toContain('href="/PIB/issues/PIB-7"');
    expect(html).toContain('href="/PIB/issues/PIB-20"');
    // Money is red, a grant amber.
    expect(html).toMatch(/data-ask="money" style="[^"]*var\(--pib-bad-border/);
    expect(html).toMatch(/data-ask="grant" style="[^"]*var\(--pib-warn-border/);
    // Still phone-friendly: nothing wider than a phone.
    expect(html.match(/(?<![-\w])width:\s?(1[0-9]{3}|[4-9][0-9]{2})px/g)).toBeNull();
    expect(html.match(/min-width:\s?[3-9]\d{2,}px/g)).toBeNull();
  });

  it("dates warnings that do not say since when from when the Cockpit first saw them", () => {
    const own = snap(PLUGIN_KEY, { title: "Cockpit", health: [{ key: "stuck", title: "Stuck", status: "warn" }, { key: "owned", title: "Owned", status: "warn", since: "2026-09-20T00:00:00.000Z" }] });
    const v = buildView({ load: { ...load, own, warningSince: { [`${PLUGIN_KEY}:stuck`]: "2026-09-24T10:00:00.000Z", [`${PLUGIN_KEY}:owned`]: "2026-09-25T00:00:00.000Z" } }, installed: null, modules: null, live: {}, now: NOW, windowMs: 86_400_000 });
    const checks = v.healthGroups.find((g) => g.plugin === PLUGIN_KEY)!.checks;
    expect(checks.find((c) => c.key === "stuck")!.since).toBe("2026-09-24T10:00:00.000Z");
    expect(checks.find((c) => c.key === "owned")!.since).toBe("2026-09-20T00:00:00.000Z");
  });

  it("renders the Company today widget", () => {
    const v = view();
    const html = renderToStaticMarkup(createElement(TodayCard, { waiting: v.waiting.length, health: v.health, today: v.today, headline: v.headline, linkFor }));
    expect(html).toContain("Company today");
    expect(html).toContain("1 waiting on you");
    expect(html).toContain("Problems");
    expect(html).toContain("R 12,400");
    expect(html).toContain('href="/PIB/cockpit"');
  });
});
