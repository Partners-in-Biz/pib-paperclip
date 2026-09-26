import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CockpitSnapshot } from "@partnersinbiz/pib-plugin-kit/cockpit";
import { PLUGIN_KEY } from "../src/constants.js";
import { buildView, Overview } from "../src/ui/index.js";
import { TodayCard } from "../src/ui/components.js";
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
  own: snap(PLUGIN_KEY, { title: "Cockpit" }),
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
    const html = renderToStaticMarkup(createElement(Overview, { view: view(), load, linkFor, windowHours: 24, onWindow: () => undefined, onTeam: () => undefined, now: NOW }));
    for (const text of ["Today", "Waiting on you (1)", "Send INV-000012 to Northwind", "Money goes out in your name.", "Money", "Pipeline", "Marketing", "Delivery", "Overdue invoices", "R 12,400", "What the agents did", "Posted JNL-000012", "Agents", "Bookkeeper", "Budget 80%+", "$19.00 of $20.00", "System health", "Cross-plugin deliveries", "Fix: </span>Retry them", "Last database backup", "No Operator yet", "Open the System health issue"]) {
      expect(html).toContain(text);
    }
    expect(html).toContain('href="/PIB/issues/PIB-3"');
    expect(html).toContain('href="/PIB/issues/issue-9"');
    // Phone-friendly: wrapping grids and a scrollable table, no fixed page widths.
    expect(html).toContain("minmax(min(320px, 100%), 1fr)");
    expect(html).toContain("overflow-x:auto");
    // Only the agents table has a minimum width, and it sits in the scroll wrapper.
    expect(html.match(/(?<![-\w])width:\s?(1[0-9]{3}|[4-9][0-9]{2})px/g)).toBeNull();
    expect(html.match(/min-width:\s?[3-9]\d{2,}px/g)).toEqual(["min-width:640px"]);
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
