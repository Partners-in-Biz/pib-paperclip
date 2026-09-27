/**
 * The Payroll page. The warning lines sit between the header and the tabs,
 * the same on every tab, so the tabs never jump; each tab has one main
 * action; lists become tappable rows on a phone.
 */
import { useEffect, useState } from "react";
import {
  useHostLocation,
  useHostNavigation,
  usePluginAction,
  type PluginPageProps,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";
import {
  Banknote,
  FileText,
  GetStarted,
  LayoutDashboard,
  Page,
  Stamp,
  Sun,
  Tabs,
  Users,
  errorText,
  useGroupedNav,
  usePluginSetupStatus,
} from "@partnersinbiz/pib-plugin-ui";
import { resolvePluginUiBase } from "@partnersinbiz/pib-plugin-kit/oauth-client";
import { moduleEnabled } from "@partnersinbiz/pib-plugin-kit/setup-client";
import { pageAlerts } from "./alerts.js";
import type { DirectoryPerson } from "./approver.js";
import { ClerkBox } from "./clerk.js";
import { EmployeesTab } from "./employees.js";
import { fetchPeople } from "./host-api.js";
import { LeaveTab } from "./leave.js";
import { OverviewTab } from "./overview.js";
import { PayslipsTab } from "./payslips.js";
import { RunsTab } from "./runs.js";
import { AlertLines, Muted, Notice } from "./shared.js";
import { StatutoryTab } from "./statutory.js";
import { TAB_IDS, type Snapshot, type TabId } from "./types.js";

const PLUGIN_ID = "partnersinbiz.payroll";
const PAGE_PATH = "/payroll";
const SETTINGS_FALLBACK = "/company/settings/instance/plugins";

/** `?tab=` from the address (Setup links to e.g. /payroll?tab=employees). */
function tabFrom(search: string): TabId | null {
  const value = new URLSearchParams(search).get("tab");
  return value && (TAB_IDS as string[]).includes(value) ? (value as TabId) : null;
}

/** `?run=<id>` opens that pay run (the Cockpit's "Lock pay run" link). */
function runFrom(search: string): string | null {
  const value = new URLSearchParams(search).get("run");
  return value && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
}

/** The address for a tab (and an open run), keeping any other parameters. */
function searchFor(search: string, tab: TabId, runId: string | null): string {
  const params = new URLSearchParams(search);
  if (tab === "overview") params.delete("tab");
  else params.set("tab", tab);
  if (runId) params.set("run", runId);
  else params.delete("run");
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** False once Setup says the company switched this module off; true while loading or unknown. */
function useModuleEnabled(companyId: string | null | undefined): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    setEnabled(null);
    moduleEnabled(companyId, PLUGIN_ID).then((value) => { if (live) setEnabled(value); }, () => { if (live) setEnabled(true); });
    return () => { live = false; };
  }, [companyId]);
  return enabled;
}

/** The company's people by name (for the approver picker); null while loading or when they could not be read. */
function usePeople(companyId: string | null | undefined): { people: DirectoryPerson[] | null; failed: boolean } {
  const [state, setState] = useState<{ people: DirectoryPerson[] | null; failed: boolean }>({ people: null, failed: false });
  useEffect(() => {
    if (!companyId) return;
    let live = true;
    setState({ people: null, failed: false });
    fetchPeople(companyId).then(
      (people) => { if (live) setState({ people, failed: false }); },
      () => { if (live) setState({ people: null, failed: true }); },
    );
    return () => { live = false; };
  }, [companyId]);
  return state;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function PayrollPage({ context }: PluginPageProps) {
  const enabled = useModuleEnabled(context.companyId);
  if (enabled === false) return <ModuleOff />;
  return <PayrollWorkspace context={context} />;
}

function ModuleOff() {
  const hostNavigation = useHostNavigation();
  return (
    <Page title="Payroll" description="South African payroll for your staff." accent="payroll">
      <Notice tone="info">
        Payroll is switched off for this company. Turn it on in <a {...hostNavigation.linkProps("/setup")}>Setup</a>.
      </Notice>
    </Page>
  );
}

function PayrollWorkspace({ context }: PluginPageProps) {
  const load = usePluginAction("payroll.load");
  const location = useHostLocation();
  const navigation = useHostNavigation();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [message, setMessageText] = useState("");
  const [messageBad, setMessageBad] = useState(false);
  const [tab, setTab] = useState<TabId>(() => (runFrom(location.search) ? "runs" : tabFrom(location.search) ?? "overview"));
  const [openRunId, setOpenRunId] = useState<string | null>(() => runFrom(location.search));
  // The module's own setup checklist drives the "Finish setting up" card on the overview.
  const [setupKey, setSetupKey] = useState(0);
  const setupStatus = usePluginSetupStatus(PLUGIN_ID, context.companyId, setupKey);
  const { people, failed: peopleFailed } = usePeople(context.companyId);

  const setMessage = (text: string) => {
    setMessageBad(false);
    setMessageText(text);
  };

  async function refresh() {
    setSnapshot((await load({ uiBase: await resolvePluginUiBase(PLUGIN_ID, import.meta.url) })) as Snapshot);
    setSetupKey((k) => k + 1);
  }

  useEffect(() => {
    if (!context.companyId) return;
    setSnapshot(null);
    refresh().catch((error: unknown) => {
      setMessageBad(true);
      setMessageText(errorText(error));
    });
  }, [context.companyId]);

  useEffect(() => {
    const runId = runFrom(location.search);
    const next = tabFrom(location.search);
    if (runId) {
      setTab("runs");
      setOpenRunId(runId);
    } else if (next) {
      setTab(next);
      setOpenRunId(null);
    }
  }, [location.search]);

  /** Switch tab (and optionally open a run), and keep the address in step so it can be shared. */
  function go(next: TabId, runId: string | null = null) {
    setTab(next);
    setOpenRunId(runId);
    navigation.navigate(`${PAGE_PATH}${searchFor(location.search, next, runId)}`, { replace: true });
  }

  async function run<T>(work: () => Promise<T>, success?: string): Promise<T | null> {
    setMessage("");
    try {
      const result = await work();
      await refresh();
      if (success) setMessage(success);
      return result;
    } catch (error) {
      setMessageBad(true);
      setMessageText(errorText(error));
      return null;
    }
  }

  /** After the approver is saved in the settings: new snapshot and setup status (a retry or two while the host settles). */
  async function afterApproverSaved(text: string) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await refresh();
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }
    setMessage(text);
  }

  const s = snapshot;
  const alerts = s ? pageAlerts(s) : [];
  const settingsLink = navigation.linkProps(s?.settingsHref || SETTINGS_FALLBACK) as unknown as Record<string, unknown>;
  // Tab badges only count what needs a person.
  const employeesNeeding = s ? s.employees.filter((e) => e.status === "active" && (!e.terms || !e.has.bank || !e.has.tax)).length : 0;
  const runsNeeding = s ? s.openRuns.filter((r) => r.status === "pending_approval" || r.status === "approved").length : 0;
  const rulesToCheck = s && s.rules.id && !s.rulesReviewed ? s.rules.unverified.length : 0;

  return (
    <Page
      title="Payroll"
      description="South African payroll for your staff. Nothing is paid or sent to SARS on its own."
      message={message || undefined}
      messageTone={messageBad ? "bad" : undefined}
      accent="payroll"
    >
      {s ? <AlertLines alerts={alerts} settingsLink={settingsLink} openTab={(next) => go(next)} /> : null}
      <Tabs
        tabs={[
          { id: "overview", label: "Overview", icon: LayoutDashboard },
          { id: "employees", label: "Employees", icon: Users, count: employeesNeeding || null, countTone: "warn" },
          { id: "runs", label: "Pay runs", icon: Banknote, count: runsNeeding || null, countTone: "warn" },
          { id: "payslips", label: "Payslips", icon: FileText },
          { id: "leave", label: "Leave", icon: Sun, count: s?.counts.pendingLeave || null, countTone: "warn" },
          { id: "statutory", label: "Statutory", icon: Stamp, count: rulesToCheck || null, countTone: "warn" },
        ]}
        active={tab}
        onChange={(id) => go(id as TabId)}
      />
      {!s ? <Muted>Loading…</Muted> : null}
      {s && tab === "overview" ? (
        <>
          {/* Only when something is wrong with the Payroll Clerk (it is staffed in Setup → Team). */}
          <ClerkBox hire={s.hire} run={run} />
          <GetStarted
            status={setupStatus}
            moduleName="Payroll"
            hasData={s.employees.length > 0 || s.runs.length > 0}
            linkFor={(href) => navigation.linkProps(href) as unknown as Record<string, unknown>}
          />
          <OverviewTab s={s} openRun={(id) => go("runs", id)} go={(next) => go(next)} />
        </>
      ) : null}
      {s && tab === "employees" ? <EmployeesTab s={s} run={run} settingsLink={settingsLink} /> : null}
      {s && tab === "runs" ? (
        <RunsTab
          s={s}
          run={run}
          openRunId={openRunId}
          setOpenRunId={(id) => go("runs", id)}
          setMessage={setMessage}
          people={people}
          peopleFailed={peopleFailed}
          companyId={context.companyId}
          onApproverSaved={afterApproverSaved}
          goEmployees={() => go("employees")}
        />
      ) : null}
      {s && tab === "payslips" ? <PayslipsTab run={run} setMessage={setMessage} go={(next) => go(next)} /> : null}
      {s && tab === "leave" ? <LeaveTab s={s} run={run} /> : null}
      {s && tab === "statutory" ? <StatutoryTab s={s} run={run} setMessage={setMessage} /> : null}
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

export function PayrollSidebar({ context }: PluginSidebarProps) {
  const hostNavigation = useHostNavigation();
  const enabled = useModuleEnabled(context.companyId);
  // The Cockpit's Clients / Marketing / Finance group shows this page instead (pib-plugin-ui NAV_GROUPS).
  const grouped = useGroupedNav("partnersinbiz.payroll");
  const href = hostNavigation.resolveHref("/payroll");
  const isActive = typeof window !== "undefined" && window.location.pathname === href;
  if (enabled === false || grouped !== false) return null;
  return (
    <a
      {...hostNavigation.linkProps("/payroll")}
      aria-current={isActive ? "page" : undefined}
      className={[
        "flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 text-(length:--text-compact) font-medium transition-colors",
        isActive ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      ].join(" ")}
      style={{ textDecoration: "none" }}
    >
      <span aria-hidden="true" className="relative shrink-0">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="6" width="20" height="12" rx="2" />
          <circle cx="12" cy="12" r="2.5" />
          <path d="M6 12h.01M18 12h.01" />
        </svg>
      </span>
      <span className="flex-1 truncate">Payroll</span>
    </a>
  );
}
