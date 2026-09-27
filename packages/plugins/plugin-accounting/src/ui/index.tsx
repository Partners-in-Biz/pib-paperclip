import { useEffect, useState } from "react";
import { useHostLocation, useHostNavigation, usePluginAction, type PluginPageProps, type PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import { resolvePluginUiBase } from "@partnersinbiz/pib-plugin-kit/oauth-client";
import { moduleEnabled } from "@partnersinbiz/pib-plugin-kit/setup-client";
import { BookOpen, ChartColumn, Landmark, LayoutDashboard, Page, Settings, Tabs, errorText, useIsNarrow, useUrlTab, type TabItem, type ToneInput } from "@partnersinbiz/pib-plugin-ui";
import { GetStarted, useGroupedNav, usePluginSetupStatus } from "@partnersinbiz/pib-plugin-ui";
import { AssetsTab } from "./assets.js";
import { BankTab } from "./bank.js";
import { BudgetsTab } from "./budgets.js";
import { ChartTab } from "./chart.js";
import { CutoverTab } from "./cutover.js";
import { JournalsTab } from "./journals.js";
import { OverviewTab, type LoadResult } from "./overview.js";
import { ReportsTab } from "./reports.js";
import { Banner, NoticeAction, NoticeLine, SectionNav } from "./shared.js";
import { VatTab } from "./vat.js";
import { isView, resolveView, TAB_SECTIONS, TOP_TABS, VIEW_IDS, viewForTab, type TopTab, type View } from "./views.js";

// The UI bundle cannot import namespace.ts (node:crypto).
const PLUGIN_ID = "partnersinbiz.accounting";
/** Settings → Plugins; the setup checklist's "settings" item has the exact link to this plugin's settings. */
const PLUGINS_SETTINGS_HREF = "/company/settings/instance/plugins";

const TAB_ICON: Record<TopTab, TabItem["icon"]> = { overview: LayoutDashboard, bank: Landmark, journals: BookOpen, reports: ChartColumn, setup: Settings };

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

/** Real data in the books: the "Finish setting up" card then starts as one line. */
export function booksHaveData(data: LoadResult | null): boolean {
  if (!data) return false;
  return (data.overview.journalCount ?? 0) > 0 || Object.values(data.overview.bankLines ?? {}).some((n) => Number(n) > 0);
}

export function AccountingPage({ context }: PluginPageProps) {
  const load = usePluginAction("accounting.load");
  const location = useHostLocation();
  const navigation = useHostNavigation();
  const narrow = useIsNarrow();
  const enabled = useModuleEnabled(context.companyId);
  const [data, setData] = useState<LoadResult | null>(null);
  const [message, setMessage] = useState("");
  // `?tab=` is a tab or a section (vat, drafts, cutover…); every value the page had before still opens the same content.
  const [view, setView] = useUrlTab<View>(VIEW_IDS, "overview", { path: "/accounting", search: location.search, navigate: navigation.navigate });
  const { tab, section } = resolveView(view);
  // The module's own setup checklist drives the "Finish setting up" card on the overview.
  const [setupKey, setSetupKey] = useState(0);
  const setupStatus = usePluginSetupStatus(PLUGIN_ID, context.companyId, setupKey);

  async function refresh() {
    setData((await load({ uiBase: await resolvePluginUiBase(PLUGIN_ID, import.meta.url) })) as LoadResult);
    setSetupKey((k) => k + 1);
  }

  /** Open a tab or section by id (old tab ids from the Overview and links still work). */
  function go(id: string) {
    setView(isView(id) ? id : "overview");
    setMessage("");
  }

  useEffect(() => {
    if (!context.companyId || enabled !== true) return;
    setData(null);
    refresh().catch((error: unknown) => setMessage(errorText(error)));
  }, [context.companyId, enabled]);

  if (enabled === false) return <ModuleOff />;

  const o = data?.overview;
  const openLines = o ? (o.bankLines.unreconciled ?? 0) + (o.bankLines.matching ?? 0) : 0;
  const rejected = o?.rejectedPostings ?? 0;
  const pending = o?.pendingApprovals ?? 0;
  const gaps = data?.roleGaps.length ?? 0;

  // Badges mean "needs you"; each sits on the tab (and section) that holds the work.
  const tabCounts: Record<TopTab, Pick<TabItem, "count" | "countTone">> = {
    overview: { count: rejected + openLines + pending || null, countTone: rejected ? "bad" : "warn" },
    bank: { count: openLines || null, countTone: "warn" },
    journals: { count: rejected + pending || null, countTone: rejected ? "bad" : "warn" },
    reports: { count: null },
    setup: { count: gaps || null, countTone: "bad" },
  };
  // No icons on a phone, so more of the five tabs fit on the first screen.
  const tabs: TabItem[] = TOP_TABS.map((t) => ({ id: t.id, label: t.label, ...(narrow ? {} : { icon: TAB_ICON[t.id] }), ...tabCounts[t.id] }));
  const sectionCount: Partial<Record<View, { count: number | null; tone: ToneInput }>> = {
    drafts: { count: pending || null, tone: "warn" },
    rejected: { count: rejected || null, tone: "bad" },
    chart: { count: gaps || null, tone: "bad" },
  };
  const sections = TAB_SECTIONS[tab].map((s) => ({ id: s.view, label: s.label, count: sectionCount[s.view]?.count ?? null, tone: sectionCount[s.view]?.tone }));

  const settingsHref = setupStatus?.items.find((i) => i.key === "settings")?.href || PLUGINS_SETTINGS_HREF;
  // One line each, in the same place on every tab.
  const notices = data ? (
    <>
      {!data.settings.saved ? (
        <NoticeLine tone="warn" action={<NoticeAction link={navigation.linkProps(settingsHref) as unknown as Record<string, unknown>}>Open settings</NoticeAction>}>
          Settings not saved, so the month-end jobs skip these books.
        </NoticeLine>
      ) : null}
      {gaps ? (
        <NoticeLine tone="bad" action={section === "chart" ? null : <NoticeAction onClick={() => go("chart")}>Map roles</NoticeAction>}>
          {gaps === 1 ? "1 posting role has" : `${gaps} posting roles have`} no account, so those postings are rejected.
        </NoticeLine>
      ) : null}
    </>
  ) : null;

  const body = !data ? (
    <p style={{ margin: 0, fontSize: 13 }}>Loading…</p>
  ) : (
    <>
      {section === "overview" ? <GetStarted status={setupStatus} moduleName="Accounting" hasData={booksHaveData(data)} linkFor={(href) => navigation.linkProps(href) as unknown as Record<string, unknown>} /> : null}
      {section === "overview" ? <OverviewTab data={data} onMessage={setMessage} onOpen={go} refresh={refresh} /> : null}
      {section === "bank" ? <BankTab data={data} onMessage={setMessage} /> : null}
      {section === "journals" || section === "drafts" || section === "rejected" || section === "periods" ? <JournalsTab data={data} section={section} onMessage={setMessage} onOpen={go} /> : null}
      {section === "reports" ? <ReportsTab data={data} onMessage={setMessage} /> : null}
      {section === "vat" ? <VatTab data={data} onMessage={setMessage} /> : null}
      {section === "budgets" ? <BudgetsTab data={data} onMessage={setMessage} /> : null}
      {section === "chart" ? <ChartTab onMessage={setMessage} onChanged={refresh} /> : null}
      {section === "cutover" ? <CutoverTab data={data} onMessage={setMessage} onChanged={refresh} onOpen={go} /> : null}
      {section === "assets" ? <AssetsTab data={data} onMessage={setMessage} /> : null}
    </>
  );

  return (
    <Page
      title="Accounting"
      description="PiB's own books. Billing and Payroll post here; you reconcile the bank, file VAT and read the reports."
      message={message || undefined}
      accent="accounting"
    >
      {notices}
      <div style={{ display: "grid", gap: 10, minWidth: 0 }}>
        <Tabs tabs={tabs} active={tab} onChange={(id) => go(viewForTab(id as TopTab))} />
        <SectionNav items={sections} active={section} onChange={go} />
      </div>
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
