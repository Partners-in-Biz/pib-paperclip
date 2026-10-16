import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import {
  useHostLocation,
  useHostNavigation,
  type PluginPageProps,
  type PluginSidebarProps,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import { teamSetupPath } from "@partnersinbiz/pib-plugin-kit/team";
import { Activity, Bot, Building2, Button, EmptyState, HeartPulse, Inbox, Lightbulb, PageFrame, PageHeader, PageMessage, Tabs, Workflow, tokens, tone } from "@partnersinbiz/pib-plugin-ui";
import { MODULES } from "@partnersinbiz/pib-plugin-kit/setup";
import { PLUGIN_KEY } from "../constants.js";
import { KPI_GROUP_TITLES, type RunLite } from "../merge.js";
import type { CockpitView, LoadResult } from "../view.js";
import { ActivityList, AgentsTable, Card, HealthList, HealthSummary, KpiGroup, Light, Muted, TodayCard, TodayHero, WaitingKinds, WaitingList, grid, type LinkPropsFor } from "./components.js";
import { uiBase, useCockpitData, useSidebarView } from "./data.js";
import { FlowsPanel, FlowsSummary } from "./flows.js";
import { dedupeKpis, visibleKpis } from "./kpis.js";
import { runAlert, runStats } from "./series.js";
import { MemoryPanel } from "./memory.js";
import { installationIdFromUiBase, settingsPath } from "./memory-model.js";
import { ProfilePanel } from "./profile.js";

export { ClientsNav, FinanceNav, MarketingNav } from "./nav.js";

export { buildView } from "../view.js";

function useLinkFor(): LinkPropsFor {
  const navigation = useHostNavigation();
  return (href: string) => navigation.linkProps(href);
}

/**
 * The company prefix from a host path (`/PAR/dashboard` gives `PAR`). The
 * dashboard hands widgets no `companyPrefix`, so the host cannot prefix their
 * links and `/billing` opens "Organization not found". Null for a path with
 * only one segment.
 */
export function prefixFromPath(pathname: string | null | undefined): string | null {
  const [first, second] = (pathname ?? "").split("/").filter(Boolean);
  return first && second && /^[A-Za-z][A-Za-z0-9]{0,9}$/.test(first) ? first : null;
}

/** Prefix a relative host path with the company prefix; paths that already carry it or are absolute urls stay. */
export function withCompanyPrefix(href: string, prefix: string | null): string {
  if (!prefix || !href.startsWith("/") || href.startsWith("//")) return href;
  const first = href.split(/[/?#]/)[1] ?? "";
  return first.toUpperCase() === prefix.toUpperCase() ? href : `/${prefix.toUpperCase()}${href}`;
}

function useWidgetLinkFor(context: { companyPrefix?: string | null }): LinkPropsFor {
  const navigation = useHostNavigation();
  const location = useHostLocation();
  const prefix = context.companyPrefix || prefixFromPath(location.pathname);
  return (href: string) => navigation.linkProps(withCompanyPrefix(href, prefix));
}

function Shell({ children }: { children: ReactNode }) {
  return <PageFrame accent="cockpit">{children}</PageFrame>;
}

const TAB_IDS = ["overview", "flows", "profile", "memory"] as const;
type TabId = (typeof TAB_IDS)[number];

/** `?tab=flows`, `?tab=profile` and `?tab=memory` open those tabs; anything else is the overview. */
export function tabFromSearch(search: string | null | undefined): TabId {
  const value = new URLSearchParams(search ?? "").get("tab");
  return (TAB_IDS as readonly string[]).includes(value ?? "") ? (value as TabId) : "overview";
}

/**
 * The team is staffed in Setup → Team now (the Cockpit has no Team tab). An
 * old `/cockpit?tab=team` link goes there; null for every other address.
 */
export function movedTabTarget(search: string | null | undefined): string | null {
  return new URLSearchParams(search ?? "").get("tab") === "team" ? teamSetupPath() : null;
}

/** "Fix in Setup": a small primary link to Setup → Team (the host only styles its own class names). */
export const setupLinkStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  height: 32,
  padding: "0 12px",
  borderRadius: 8,
  background: tokens.primary,
  color: tokens.primaryFg,
  fontSize: 13,
  fontWeight: 600,
  textDecoration: "none",
  whiteSpace: "nowrap",
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function CockpitPage({ context }: PluginPageProps) {
  const companyId = context.companyId;
  const location = useHostLocation();
  const navigation = useHostNavigation();
  const linkFor = useLinkFor();
  const [tab, setTab] = useState<TabId>(() => tabFromSearch(location.search));
  const [windowHours, setWindowHours] = useState(24);
  const data = useCockpitData(companyId, { windowHours });
  const [memoryTick, setMemoryTick] = useState(0);
  const [profileTick, setProfileTick] = useState(0);
  const moved = movedTabTarget(location.search);

  // Follow the address (a `/cockpit?tab=memory` link while the page is open).
  useEffect(() => {
    setTab(tabFromSearch(location.search));
  }, [location.search]);

  // `?tab=team` (old links): the team lives in Setup → Team.
  useEffect(() => {
    if (moved) navigation.navigate(moved, { replace: true });
  }, [moved]);

  const selectTab = (id: TabId) => {
    setTab(id);
    navigation.navigate(id === "overview" ? "/cockpit" : `/cockpit?tab=${id}`, { replace: true });
  };

  if (!companyId) {
    return <Shell><PageHeader title="Cockpit" description="Open a company first." /><EmptyState title="No company selected" /></Shell>;
  }

  const view = data.view;
  const memoryTab = tab === "memory";
  const profileTab = tab === "profile";
  const pageTab = memoryTab || profileTab;
  const settingsHref = settingsPath(data.raw?.installed?.[PLUGIN_KEY]?.id ?? installationIdFromUiBase(uiBase()));
  return (
    <Shell>
      <PageHeader
        title="Cockpit"
        description="What needs you, what the agents did, and how the company is doing."
        actions={(
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {/* Setup leaves the sidebar once it is finished; it stays one click away here (the team is staffed there). */}
            <a
              {...linkFor("/setup")}
              style={{ display: "inline-flex", alignItems: "center", height: 34, padding: "0 12px", borderRadius: 8, border: `1px solid ${tokens.border}`, fontSize: 13, fontWeight: 600, color: tokens.fg, textDecoration: "none" }}
            >
              Setup
            </a>
            <Button
              type="button"
              variant="secondary"
              onClick={() => (memoryTab ? setMemoryTick((n) => n + 1) : profileTab ? setProfileTick((n) => n + 1) : void data.reload())}
              disabled={!pageTab && data.loading}
            >
              {!pageTab && data.loading ? "Loading…" : "Refresh"}
            </Button>
          </div>
        )}
      />
      <PageMessage message={data.error || undefined} tone={data.error ? "bad" : undefined} />
      {moved ? <Muted>The team moved to <a {...linkFor(moved)} style={{ color: tokens.primary, fontWeight: 600 }}>Setup → Team</a>.</Muted> : null}
      <Tabs
        tabs={[
          { id: "overview", label: "Overview", icon: Activity, count: view?.waiting.length || null, countTone: view?.waiting.some((w) => w.kind === "money" || w.kind === "legal") ? "bad" : "warn" },
          { id: "flows", label: "Flows", icon: Workflow, count: view?.flows.stuck.length || null, countTone: "warn" },
          { id: "profile", label: "Profile", icon: Building2 },
          { id: "memory", label: "Memory", icon: Lightbulb },
        ]}
        active={tab}
        onChange={(id) => selectTab(id as TabId)}
      />
      {memoryTab ? (
        <MemoryPanel key={companyId} agents={data.raw?.agents ?? []} linkFor={linkFor} settingsHref={settingsHref} refreshKey={memoryTick} />
      ) : profileTab ? (
        <ProfilePanel
          key={companyId}
          refreshKey={profileTick}
          linkFor={linkFor}
          billingSettingsHref={settingsPath(data.raw?.installed?.[MODULES.billing.plugins[0]]?.id ?? null)}
          accountingSettingsHref={settingsPath(data.raw?.installed?.[MODULES.accounting.plugins[0]]?.id ?? null)}
        />
      ) : view && tab === "flows" ? (
        <FlowsPanel view={view.flows} linkFor={linkFor} focus={location.hash} />
      ) : view ? (
        <Overview view={view} load={data.raw!.load} runs={data.raw!.runs} linkFor={linkFor} windowHours={windowHours} onWindow={setWindowHours} />
      ) : <Muted>{data.loading ? "Loading the Cockpit…" : "Nothing to show yet."}</Muted>}
    </Shell>
  );
}

const NUMBER_GROUPS = ["money", "pipeline", "marketing", "delivery"] as const;

export function Overview({ view, load, runs, linkFor, windowHours, onWindow, now = new Date() }: {
  view: CockpitView;
  load: LoadResult;
  /** Host heartbeat runs, for the runs-per-day chart and the Today card's run line. */
  runs?: RunLite[];
  linkFor: LinkPropsFor;
  windowHours: number;
  onWindow: (hours: number) => void;
  now?: Date;
}) {
  const [showAllNumbers, setShowAllNumbers] = useState(false);
  const [showAllChecks, setShowAllChecks] = useState(false);
  const accent = tone("accent");
  const toggle = (
    <div role="group" aria-label="Period" style={{ display: "inline-flex", border: `1px solid ${tokens.border}`, borderRadius: 9, overflow: "hidden" }}>
      {[{ h: 24, label: "24 hours" }, { h: 168, label: "7 days" }].map(({ h, label }) => (
        <button
          key={h}
          type="button"
          aria-pressed={windowHours === h}
          onClick={() => onWindow(h)}
          style={{ appearance: "none", border: "none", minHeight: 32, padding: "6px 12px", fontSize: 12.5, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", background: windowHours === h ? accent.soft : "transparent", color: windowHours === h ? accent.fg : tokens.muted }}
        >
          {label}
        </button>
      ))}
    </div>
  );
  const agentAlerts = view.agents.filter((a) => a.alert).length;
  const activeAgents = view.agents.length ? view.agents.filter((a) => ["active", "running", "idle"].includes(a.status)).length : null;
  const failing = view.healthGroups.reduce((sum, g) => sum + g.checks.filter((c) => c.status !== "ok").length, 0);
  const warnings = view.healthGroups.reduce((sum, g) => sum + g.checks.filter((c) => c.status === "warn").length, 0);
  const totalChecks = view.healthGroups.reduce((sum, g) => sum + g.checks.length, 0);
  // Failing runs lead the Today card, over the same period as "What the agents did".
  const runLine = runs ? runAlert(runStats(runs, now, windowHours * 3_600_000), windowHours) : null;
  const numbers = NUMBER_GROUPS.map((group) => ({ group, all: dedupeKpis(view.kpis[group]), shown: visibleKpis(view.kpis[group], showAllNumbers) }));
  const totalNumbers = numbers.reduce((sum, g) => sum + g.all.length, 0);
  const shownNumbers = numbers.reduce((sum, g) => sum + g.shown.length, 0);
  const quietGroups = numbers.filter((g) => g.all.length > 0 && g.shown.length === 0).map((g) => KPI_GROUP_TITLES[g.group]);
  const smallToggle = { minHeight: 40 } as const;
  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      <TodayHero health={view.health} today={view.today} waiting={view.waiting} problems={view.problems} warnings={warnings} agentAlerts={agentAlerts} activeAgents={activeAgents} runAlert={runLine} linkFor={linkFor}>
        {!load.roles?.operatorAgentId ? (
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "10px 12px", borderRadius: 12, background: accent.soft, border: `1px solid ${accent.border}` }}>
            <Bot size={16} color={accent.solid} aria-hidden="true" style={{ flexShrink: 0 }} />
            <span style={{ fontSize: 13, color: tokens.fg, lineHeight: 1.5, flex: "1 1 220px" }}>No Operator yet. The Operator checks all of this every morning and sends you one short brief.</span>
            <a {...linkFor(teamSetupPath("operator"))} style={setupLinkStyle}>Fix in Setup</a>
          </div>
        ) : null}
      </TodayHero>

      <Card
        id="waiting"
        title={`Waiting on you${view.waiting.length ? ` (${view.waiting.length})` : ""}`}
        icon={Inbox}
        tone={view.waiting.some((w) => w.kind === "money" || w.kind === "legal") ? "bad" : view.waiting.length ? "warn" : "ok"}
        subtitle={view.waiting.some((w) => w.ask) ? "Questions from agents first, then decisions only you can make." : "Decisions only you can make, most urgent first."}
        actions={<WaitingKinds items={view.waiting} />}
      >
        <WaitingList items={view.waiting} linkFor={linkFor} now={now} />
      </Card>

      <FlowsSummary view={view.flows} linkFor={linkFor} />

      <div style={{ display: "grid", gap: 10, minWidth: 0 }}>
        {shownNumbers > 0 || showAllNumbers ? (
          <div style={grid(420, 16)}>
            {numbers.filter((g) => showAllNumbers || g.shown.length > 0).map((g) => (
              <KpiGroup key={g.group} group={g.group} kpis={g.shown} hidden={g.all.length - g.shown.length} linkFor={linkFor} now={now} />
            ))}
          </div>
        ) : null}
        {totalNumbers > shownNumbers || showAllNumbers ? (
          <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", minWidth: 0 }}>
            <Muted>
              {showAllNumbers
                ? `All ${totalNumbers} numbers, zeros included.`
                : shownNumbers === 0
                  ? `No numbers need you: all ${totalNumbers} are at zero.`
                  : `${totalNumbers - shownNumbers} more ${totalNumbers - shownNumbers === 1 ? "number is" : "numbers are"} at zero${quietGroups.length ? ` (nothing to report in ${quietGroups.join(", ")})` : ""}.`}
            </Muted>
            <Button type="button" variant="secondary" style={smallToggle} onClick={() => setShowAllNumbers((v) => !v)} aria-expanded={showAllNumbers}>
              {showAllNumbers ? "Show fewer numbers" : "Show all numbers"}
            </Button>
          </div>
        ) : null}
      </div>

      <Card title="What the agents did" icon={Activity} subtitle={windowHours === 24 ? "The last 24 hours" : "The last 7 days"} actions={toggle}>
        <ActivityList groups={view.activity} linkFor={linkFor} now={now} runs={runs} />
      </Card>

      <Card
        id="agents"
        title="Agents"
        icon={Bot}
        subtitle="Status, spend against budget, and quality this month."
        actions={<a {...linkFor("/costs")} style={{ display: "inline-flex", alignItems: "center", minHeight: 32, fontSize: 13, fontWeight: 600, color: tokens.primary, textDecoration: "none" }}>Costs →</a>}
      >
        <AgentsTable rows={view.agents} linkFor={linkFor} now={now} />
      </Card>

      <Card
        id="health"
        title="System health"
        icon={HeartPulse}
        tone={view.health}
        strip={view.health !== "ok"}
        subtitle={failing ? `${view.problems} ${view.problems === 1 ? "problem" : "problems"} · ${warnings} ${warnings === 1 ? "warning" : "warnings"}. The checks that pass are hidden.` : "Every check passes."}
        actions={(
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Light status={view.health} />
            {totalChecks > failing || showAllChecks ? (
              <Button type="button" variant="secondary" style={smallToggle} onClick={() => setShowAllChecks((v) => !v)} aria-expanded={showAllChecks}>
                {showAllChecks ? "Show problems only" : `Show all ${totalChecks} checks`}
              </Button>
            ) : null}
          </div>
        )}
      >
        <HealthSummary groups={view.healthGroups} />
        {load.healthIssueId ? (
          <a {...linkFor(`/issues/${load.healthIssueId}`)} style={{ fontSize: 13, fontWeight: 600, color: tokens.primary, textDecoration: "none" }}>Open the System health issue →</a>
        ) : null}
        <HealthList groups={view.healthGroups} linkFor={linkFor} now={now} backup={view.backup} showAll={showAllChecks} />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard widget and sidebar
// ---------------------------------------------------------------------------

export function CompanyTodayWidget({ context }: PluginWidgetProps) {
  const data = useCockpitData(context.companyId, { light: true });
  const linkFor = useWidgetLinkFor(context);
  if (!context.companyId || !data.view) return null;
  return <TodayCard waiting={data.view.waiting.length} health={data.view.health} today={data.view.today} headline={data.view.headline} linkFor={linkFor} />;
}

export function CockpitSidebar({ context }: PluginSidebarProps) {
  const hostNavigation = useHostNavigation();
  const location = useHostLocation();
  // Shared with the Clients / Marketing / Finance groups: one light load for the whole sidebar.
  const view = useSidebarView(context.companyId, location.pathname);
  const waiting = view?.waiting.length ?? 0;
  const urgent = view?.waiting.some((w) => w.kind === "money" || w.kind === "legal") ?? false;
  const health = view?.health ?? "ok";
  const href = hostNavigation.resolveHref("/cockpit");
  const isActive = typeof window !== "undefined" && window.location.pathname === href;
  return (
    <a
      {...hostNavigation.linkProps("/cockpit")}
      aria-current={isActive ? "page" : undefined}
      className={[
        "flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 text-(length:--text-compact) font-medium transition-colors",
        isActive ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      ].join(" ")}
      style={{ textDecoration: "none" }}
    >
      <span aria-hidden="true" className="relative shrink-0">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 12l4-4" />
          <path d="M12 7v1M7 12h1M16 12h1" />
        </svg>
        {health !== "ok" ? (
          <span style={{ position: "absolute", top: -2, right: -2, width: 7, height: 7, borderRadius: 999, background: tone(health).solid }} />
        ) : null}
      </span>
      <span className="flex-1 truncate">Cockpit</span>
      {waiting ? (
        <span
          aria-label={`${waiting} waiting on you${urgent ? " (money or legal)" : ""}`}
          style={{ minWidth: 18, height: 18, padding: "0 5px", borderRadius: 999, fontSize: 11, fontWeight: 650, display: "inline-grid", placeItems: "center", background: tone(urgent ? "bad" : "warn").soft, color: tone(urgent ? "bad" : "warn").fg }}
        >
          {waiting}
        </span>
      ) : null}
    </a>
  );
}
