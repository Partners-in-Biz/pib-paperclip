import { useEffect, useState, type ReactNode } from "react";
import { useHostLocation, useHostNavigation, usePluginAction, type PluginPageProps, type PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import { resolvePluginUiBase } from "@partnersinbiz/pib-plugin-kit/oauth-client";
import { moduleEnabled } from "@partnersinbiz/pib-plugin-kit/setup-client";
import { Blocks, BookOpen, Button, CalendarCheck, ChartColumn, Landmark, LayoutDashboard, Package, Page, Stamp, Tabs, Target, errorText, type LucideIcon } from "@partnersinbiz/pib-plugin-ui";
import { useGroupedNav } from "@partnersinbiz/pib-plugin-ui";
import { AssetsTab } from "./assets.js";
import { BankTab } from "./bank.js";
import { BudgetsTab } from "./budgets.js";
import { ChartTab } from "./chart.js";
import { CutoverTab } from "./cutover.js";
import { JournalsTab } from "./journals.js";
import { OverviewTab, type LoadResult } from "./overview.js";
import { ReportsTab } from "./reports.js";
import { Banner } from "./shared.js";
import { VatTab } from "./vat.js";

// The UI bundle cannot import namespace.ts (node:crypto).
const PLUGIN_ID = "partnersinbiz.accounting";

type TabId = "overview" | "bank" | "journals" | "chart" | "vat" | "reports" | "assets" | "budgets" | "cutover";

const TABS: Array<{ id: TabId; label: string; icon: LucideIcon }> = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "bank", label: "Bank", icon: Landmark },
  { id: "journals", label: "Journals", icon: BookOpen },
  { id: "chart", label: "Chart & roles", icon: Blocks },
  { id: "vat", label: "VAT", icon: Stamp },
  { id: "reports", label: "Reports", icon: ChartColumn },
  { id: "assets", label: "Assets & FX", icon: Package },
  { id: "budgets", label: "Budgets & forecast", icon: Target },
  { id: "cutover", label: "Cut-over", icon: CalendarCheck },
];

/** `?tab=bank` etc. (links from the Setup checklist); anything else is the overview. */
function tabFrom(search: string): TabId {
  const value = new URLSearchParams(search).get("tab");
  return TABS.some((t) => t.id === value) ? (value as TabId) : "overview";
}

/** Null while checking; false when the company switched Accounting off in Setup. */
function useModuleEnabled(companyId: string | null | undefined): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    setEnabled(null);
    moduleEnabled(companyId, PLUGIN_ID)
      .then((value) => live && setEnabled(value))
      .catch(() => live && setEnabled(true));
    return () => {
      live = false;
    };
  }, [companyId]);
  return enabled;
}

function ModuleOff() {
  const nav = useHostNavigation();
  return (
    <Page title="Accounting" description="Partners in Biz's books." accent="accounting">
      <Banner tone="info">
        <span>
          This module is switched off for this company. Turn it on in <a {...nav.linkProps("/setup")} style={{ fontWeight: 600 }}>Setup</a>.
        </span>
      </Banner>
    </Page>
  );
}

export function AccountingPage({ context }: PluginPageProps) {
  const load = usePluginAction("accounting.load");
  const location = useHostLocation();
  const enabled = useModuleEnabled(context.companyId);
  const [data, setData] = useState<LoadResult | null>(null);
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<TabId>(() => tabFrom(location.search));

  async function refresh() {
    setData((await load({ uiBase: await resolvePluginUiBase(PLUGIN_ID, import.meta.url) })) as LoadResult);
  }

  // A new ?tab= (e.g. a link from Setup while the page is open) switches tab.
  useEffect(() => {
    setTab(tabFrom(location.search));
  }, [location.search]);

  useEffect(() => {
    if (!context.companyId || enabled !== true) return;
    setData(null);
    refresh().catch((error: unknown) => setMessage(errorText(error)));
  }, [context.companyId, enabled]);

  if (enabled === false) return <ModuleOff />;

  const settingsBanner: ReactNode = data && !data.settings.saved ? (
    <Banner tone="warn">
      <span>
        <strong>Accounting settings are not saved for this company yet.</strong> Open Settings → Plugins → Accounting, fill in the legal name, VAT number, VAT
        category and financial year-end, and click Save once. Until then the scheduled jobs (depreciation, FX rates, month-end) skip this company.
      </span>
    </Banner>
  ) : null;

  const gapsBanner: ReactNode = data && data.roleGaps.length ? (
    <Banner tone="warn">
      <span>
        Postings that use these roles will be rejected until they are mapped: <strong>{data.roleGaps.join(", ")}</strong>.
      </span>
      <div>
        <Button type="button" variant="secondary" style={{ height: 28, fontSize: 12 }} onClick={() => setTab("chart")}>Map roles</Button>
      </div>
    </Banner>
  ) : null;

  const body = !data ? (
    <p style={{ margin: 0, fontSize: 13 }}>Loading…</p>
  ) : (
    <>
      {tab === "overview" ? <OverviewTab data={data} onMessage={setMessage} onOpen={(id) => setTab(id as TabId)} refresh={refresh} /> : null}
      {tab === "bank" ? <BankTab data={data} onMessage={setMessage} /> : null}
      {tab === "journals" ? <JournalsTab data={data} onMessage={setMessage} /> : null}
      {tab === "chart" ? <ChartTab onMessage={setMessage} onChanged={refresh} /> : null}
      {tab === "vat" ? <VatTab data={data} onMessage={setMessage} /> : null}
      {tab === "reports" ? <ReportsTab data={data} onMessage={setMessage} /> : null}
      {tab === "assets" ? <AssetsTab data={data} onMessage={setMessage} /> : null}
      {tab === "budgets" ? <BudgetsTab data={data} onMessage={setMessage} /> : null}
      {tab === "cutover" ? <CutoverTab data={data} onMessage={setMessage} /> : null}
    </>
  );

  return (
    <Page
      title="Accounting"
      description="Partners in Biz's books. Billing and Payroll post here; the bank is reconciled here; VAT201 and reports come from the journals."
      message={message || undefined}
      accent="accounting"
    >
      {settingsBanner}
      {gapsBanner}
      <Tabs
        tabs={TABS.map((t) => {
          const o = data?.overview;
          if (!o) return t;
          const openLines = (o.bankLines.unreconciled ?? 0) + (o.bankLines.matching ?? 0);
          if (t.id === "bank") return { ...t, count: openLines || null, countTone: "warn" as const };
          if (t.id === "journals") return { ...t, count: o.rejectedPostings + o.pendingApprovals || null, countTone: o.rejectedPostings ? ("bad" as const) : ("warn" as const) };
          if (t.id === "chart") return { ...t, count: data.roleGaps.length || null, countTone: "bad" as const };
          if (t.id === "overview") return { ...t, count: o.rejectedPostings + openLines + o.pendingApprovals || null, countTone: o.rejectedPostings ? ("bad" as const) : ("warn" as const) };
          return t;
        })}
        active={tab}
        onChange={(id) => {
          setTab(id as TabId);
          setMessage("");
        }}
      />
      {body}
    </Page>
  );
}

export function AccountingSidebar({ context }: PluginSidebarProps) {
  const hostNavigation = useHostNavigation();
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    let live = true;
    moduleEnabled(context.companyId, PLUGIN_ID)
      .then((value) => live && setEnabled(value))
      .catch(() => live && setEnabled(true));
    return () => {
      live = false;
    };
  }, [context.companyId]);
  // The Cockpit's Clients / Marketing / Finance group shows this page instead (pib-plugin-ui NAV_GROUPS).
  const grouped = useGroupedNav("partnersinbiz.accounting");
  const href = hostNavigation.resolveHref("/accounting");
  const isActive = typeof window !== "undefined" && window.location.pathname === href;
  if (!enabled || grouped !== false) return null;
  return (
    <a
      {...hostNavigation.linkProps("/accounting")}
      aria-current={isActive ? "page" : undefined}
      className={[
        "flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 text-(length:--text-compact) font-medium transition-colors",
        isActive ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      ].join(" ")}
      style={{ textDecoration: "none" }}
    >
      <span aria-hidden="true" className="relative shrink-0">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="4" y="2" width="16" height="20" rx="2" />
          <path d="M8 6h8M8 10h2M12 10h2M16 10h0M8 14h2M12 14h2M8 18h2M12 18h4M16 14v4" />
        </svg>
      </span>
      <span className="flex-1 truncate">Accounting</span>
    </a>
  );
}
