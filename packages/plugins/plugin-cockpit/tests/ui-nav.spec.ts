import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  NAV_GROUPS,
  NavCount,
  SidebarRowGroup,
  SidebarRowLink,
  fetchUiContributions,
  groupedNavPresent,
  isActivePath,
  memberIcon,
  navGroupOf,
  parseContributions,
  visibleMembers,
  type UiContribution,
} from "@partnersinbiz/pib-plugin-ui";
import manifest from "../src/manifest.js";
import { groupAttention, nextOpenState } from "../src/ui/nav.js";
import { clearSidebarCache, sharedSidebarView } from "../src/ui/data.js";

const COCKPIT_WITH_GROUPS: UiContribution = {
  pluginKey: "partnersinbiz.cockpit",
  slots: [
    { type: "page", routePath: "cockpit" },
    { type: "sidebar", id: "cockpit-sidebar" },
    { type: "sidebar", id: "pib-nav-clients" },
    { type: "sidebar", id: "pib-nav-marketing" },
    { type: "sidebar", id: "pib-nav-finance" },
  ],
};
const page = (pluginKey: string, routePath: string): UiContribution => ({ pluginKey, slots: [{ type: "page", routePath }, { type: "sidebar", id: `${routePath}-sidebar` }] });

describe("grouped sidebar", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__pibUiContributions;
  });

  it("puts every PiB page with its own sidebar row into exactly one group", () => {
    const members = Object.values(NAV_GROUPS).flatMap((g) => g.members.map((m) => m.pluginKey));
    expect(new Set(members).size).toBe(members.length);
    expect(members.sort()).toEqual([
      "partnersinbiz.accounting", "partnersinbiz.billing", "partnersinbiz.campaigns", "partnersinbiz.crm", "partnersinbiz.mailbox",
      "partnersinbiz.partners", "partnersinbiz.payroll", "partnersinbiz.seo", "partnersinbiz.social",
    ]);
    expect(navGroupOf("partnersinbiz.payroll")?.label).toBe("Finance");
    expect(navGroupOf("partnersinbiz.seo")?.label).toBe("Marketing");
    expect(navGroupOf("partnersinbiz.mailbox")?.label).toBe("Clients");
    expect(navGroupOf("partnersinbiz.cockpit")).toBeNull();
  });

  it("the Cockpit declares one sidebar slot per group, right after its own row", () => {
    const sidebar = (manifest.ui?.slots ?? []).filter((s) => s.type === "sidebar").map((s) => [s.id, s.exportName, s.order]);
    expect(sidebar).toEqual([
      ["cockpit-sidebar", "CockpitSidebar", 5],
      ["pib-nav-clients", "ClientsNav", 6],
      ["pib-nav-marketing", "MarketingNav", 7],
      ["pib-nav-finance", "FinanceNav", 8],
    ]);
    for (const group of Object.values(NAV_GROUPS)) expect(sidebar.some(([id]) => id === group.slotId)).toBe(true);
  });

  it("member rows hide only while the Cockpit's group for them is installed", () => {
    expect(groupedNavPresent([COCKPIT_WITH_GROUPS], "partnersinbiz.billing")).toBe(true);
    expect(groupedNavPresent([{ pluginKey: "partnersinbiz.cockpit", slots: [{ type: "sidebar", id: "cockpit-sidebar" }] }], "partnersinbiz.billing")).toBe(false);
    expect(groupedNavPresent(null, "partnersinbiz.billing")).toBe(false); // could not read: show the plugin's own row
    expect(groupedNavPresent([COCKPIT_WITH_GROUPS], "partnersinbiz.cockpit")).toBe(false);
  });

  it("groups list installed pages whose module is on", () => {
    const contributions = [COCKPIT_WITH_GROUPS, page("partnersinbiz.billing", "billing"), page("partnersinbiz.accounting", "accounting")];
    const finance = NAV_GROUPS.finance;
    expect(visibleMembers(finance, contributions, null).map((m) => m.label)).toEqual(["Billing", "Accounting"]); // Payroll not installed
    expect(visibleMembers(finance, contributions, { accounting: false }).map((m) => m.label)).toEqual(["Billing"]);
    expect(visibleMembers(finance, null, { payroll: false }).map((m) => m.label)).toEqual(["Billing", "Accounting"]); // unknown installs: trust the modules
  });

  it("parses the host's ui-contributions and shares one request per minute", async () => {
    expect(parseContributions([{ pluginKey: "a", slots: [{ type: "page" }] }, { nope: 1 }])).toEqual([{ pluginKey: "a", slots: [{ type: "page" }] }]);
    expect(parseContributions({ contributions: [{ pluginKey: "b" }] })).toEqual([{ pluginKey: "b", slots: [] }]);
    expect(parseContributions("x")).toBeNull();
    let calls = 0;
    const fake = (async () => {
      calls += 1;
      return new Response(JSON.stringify([COCKPIT_WITH_GROUPS]), { status: 200 });
    }) as unknown as typeof fetch;
    const [a, b] = await Promise.all([fetchUiContributions(fake), fetchUiContributions(fake)]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
    delete (globalThis as Record<string, unknown>).__pibUiContributions;
    const failed = await fetchUiContributions((async () => new Response("no", { status: 500 })) as unknown as typeof fetch);
    expect(failed).toBeNull();
  });

  it("matches a page and anything below it, not its neighbours", () => {
    expect(isActivePath("/PIB/billing", "/PIB/billing")).toBe(true);
    expect(isActivePath("/PIB/billing", "/PIB/billing/")).toBe(true);
    expect(isActivePath("/PIB/billing", "/PIB/billing/invoices/1")).toBe(true);
    expect(isActivePath("/PIB/billing?tab=x", "/PIB/billing")).toBe(true);
    expect(isActivePath("/PIB/billing", "/PIB/billing-old")).toBe(false);
    expect(isActivePath("/PIB/billing", "/PIB/accounting")).toBe(false);
  });

  it("opens by itself when you land on one of its pages, and otherwise remembers", () => {
    expect(nextOpenState({ stored: null, current: null, activeNow: false, activeBefore: false })).toBe(false);
    expect(nextOpenState({ stored: true, current: null, activeNow: false, activeBefore: false })).toBe(true);
    expect(nextOpenState({ stored: false, current: null, activeNow: true, activeBefore: false })).toBe(true); // landing on a Finance page opens Finance
    expect(nextOpenState({ stored: false, current: false, activeNow: true, activeBefore: true })).toBe(false); // you closed it while on the page: stays closed
    expect(nextOpenState({ stored: null, current: true, activeNow: false, activeBefore: true })).toBe(true); // leaving does not close it
  });

  it("renders an accessible group and nested rows", () => {
    const finance = NAV_GROUPS.finance;
    const link = (label: string) => createElement(SidebarRowLink, { key: label, linkProps: { href: `/PIB/${label.toLowerCase()}` }, label, icon: memberIcon(finance.members[0]!), active: label === "Billing", nested: true });
    const closed = renderToStaticMarkup(createElement(SidebarRowGroup, { group: finance, open: false, active: true, onToggle: () => undefined, children: [link("Billing"), link("Payroll")] }));
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).toContain('aria-controls="pib-nav-finance-items"');
    expect(closed).toContain("Finance");
    expect(closed).toMatch(/hidden=""/);
    const open = renderToStaticMarkup(createElement(SidebarRowGroup, { group: finance, open: true, active: true, onToggle: () => undefined, children: [link("Billing"), link("Payroll")] }));
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('aria-current="page"');
    expect(open).toContain("margin-left:22px");
    expect(open).toContain('href="/PIB/payroll"');
  });

  it("counts what waits on you per group, flags money and legal, and picks up broken plugins", () => {
    const view = {
      waiting: [
        { key: "a", title: "Approve invoice", why: "", kind: "money", source: "partnersinbiz.billing", sourceTitle: "Billing" },
        { key: "b", title: "Review payslips", why: "", kind: "review", source: "partnersinbiz.payroll", sourceTitle: "Payroll" },
        { key: "c", title: "Approve post", why: "", kind: "review", source: "partnersinbiz.social", sourceTitle: "Social" },
        { key: "d", title: "Setup", why: "", kind: "grant", source: "host", sourceTitle: "Paperclip" },
      ],
      snapshots: [
        { plugin: "partnersinbiz.accounting", health: [{ key: "bank", title: "Bank feed", status: "bad" }] },
        { plugin: "partnersinbiz.seo", health: [{ key: "gsc", title: "Search Console", status: "warn" }] },
      ],
    } as never;
    const finance = groupAttention(view, NAV_GROUPS.finance.members.map((m) => m.pluginKey));
    expect(finance).toMatchObject({ total: 2, urgent: true, health: "bad" });
    expect(finance.byPlugin).toEqual({ "partnersinbiz.billing": { count: 1, urgent: true }, "partnersinbiz.payroll": { count: 1, urgent: false } });
    const marketing = groupAttention(view, NAV_GROUPS.marketing.members.map((m) => m.pluginKey));
    expect(marketing).toMatchObject({ total: 1, urgent: false, health: "warn" });
    expect(groupAttention(null, ["x"])).toEqual({ total: 0, urgent: false, health: "ok", byPlugin: {} });
  });

  it("draws the count on a closed group and a dot for a broken plugin", () => {
    expect(renderToStaticMarkup(createElement(NavCount, { count: 0 }))).toBe("");
    expect(renderToStaticMarkup(createElement(NavCount, { count: 120 }))).toContain("99+");
    const html = renderToStaticMarkup(createElement(SidebarRowGroup, {
      group: NAV_GROUPS.finance,
      open: false,
      active: false,
      onToggle: () => undefined,
      badge: createElement(NavCount, { count: 2, urgent: true, label: "2 waiting on you (money or legal)" }),
      dot: "red",
      description: "2 waiting on you (money or legal)",
      children: [],
    }));
    expect(html).toContain('aria-label="Finance, 2 waiting on you (money or legal)"');
    expect(html).toContain(">2</span>");
    expect(html).toContain("background:red");
  });

  it("the whole sidebar shares one light load per company", async () => {
    clearSidebarCache();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    let loads = 0;
    const loadAction = async () => {
      loads += 1;
      return { roles: null, rolesSavedAt: null, settingsSaved: true, snapshots: {}, setupStatuses: {}, own: null, team: null, healthIssueId: null, installed: null };
    };
    try {
      let clock = 1_000;
      const now = () => clock;
      const views = await Promise.all([1, 2, 3, 4].map(() => sharedSidebarView("co-1", loadAction, now)));
      expect(loads).toBe(1);
      expect(views.every((v) => v === views[0])).toBe(true);
      clock += 31_000;
      await sharedSidebarView("co-1", loadAction, now);
      expect(loads).toBe(2);
      await sharedSidebarView("co-2", loadAction, now);
      expect(loads).toBe(3);
    } finally {
      globalThis.fetch = realFetch;
      clearSidebarCache();
    }
  });
});

