import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useHostLocation, useHostNavigation, type PluginPageProps, type PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import { Banknote, Button, ChartColumn, ClientWorkspaceBar, Coins, CreditCard, FileText, LayoutDashboard, Mail, Page, PageFrame, PageMessage, Receipt, RefreshCw, Tabs, Timer, errorText, tokens, type TabItem } from "@partnersinbiz/pib-plugin-ui";
import { useGroupedNav } from "@partnersinbiz/pib-plugin-ui";
import { clientScopeFromSearch, formatClientParam } from "@partnersinbiz/pib-plugin-kit/client-ref";
import { resolvePluginUiBase } from "@partnersinbiz/pib-plugin-kit/oauth-client";
import { moduleEnabled } from "@partnersinbiz/pib-plugin-kit/setup-client";
import { BillsTab, ExpensesTab } from "./costs.js";
import { InvoicesTab, NewDocumentModal } from "./invoices.js";
import { Overview } from "./overview.js";
import { BillingContext, Muted, useCall, type BillingApi } from "./parts.js";
import { PaymentsTab } from "./payments.js";
import { QuotesTab } from "./quotes.js";
import { RemindersTab, ReportsTab } from "./reports.js";
import { RetainersTab } from "./retainers.js";
import { TimeTab } from "./time.js";
import { isOverdue } from "./series.js";
import type { Snapshot } from "./types.js";

type TabId = "overview" | "invoices" | "quotes" | "payments" | "bills" | "expenses" | "time" | "retainers" | "reports" | "reminders";
const TAB_IDS: readonly TabId[] = ["overview", "invoices", "quotes", "payments", "bills", "expenses", "time", "retainers", "reports", "reminders"];

/** `?tab=invoices` (Cockpit links) opens that tab. */
function tabFromSearch(search: string): TabId {
  const value = new URLSearchParams(search).get("tab");
  return (TAB_IDS as readonly string[]).includes(value ?? "") ? (value as TabId) : "overview";
}

const PLUGIN_KEY = "partnersinbiz.billing";

/** null while loading, false when the company switched Billing off in Setup. */
function useModuleEnabled(companyId: string | null | undefined): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    setEnabled(null);
    moduleEnabled(companyId, PLUGIN_KEY).then((on) => {
      if (live) setEnabled(on);
    }).catch(() => {
      if (live) setEnabled(true);
    });
    return () => {
      live = false;
    };
  }, [companyId]);
  return enabled;
}

/** Page layout for a client workspace: the shared client bar replaces the page header. */
function WorkspacePage({ header, message, children }: { header: ReactNode; message?: string; children: ReactNode }) {
  return (
    <PageFrame accent="billing">
      {header}
      <PageMessage message={message} />
      {children}
    </PageFrame>
  );
}

export function BillingPage({ context }: PluginPageProps) {
  const location = useHostLocation();
  const navigation = useHostNavigation();
  const scope = useMemo(() => clientScopeFromSearch(location.search), [location.search]);
  const scopeKey = scope ? formatClientParam(scope) : "own";
  const call = useCall();
  const [snapshot, setSnapshot] = useState<Snapshot>({ invoices: [] });
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<TabId>(() => tabFromSearch(location.search));
  const [openInvoice, setOpenInvoice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const enabled = useModuleEnabled(context.companyId);

  async function refresh() {
    const next = await call<Snapshot>("billing.load", { client: scope, uiBase: await resolvePluginUiBase(PLUGIN_KEY, import.meta.url) });
    setSnapshot(next);
    setLoaded(true);
  }

  useEffect(() => {
    if (!context.companyId || enabled === false) return;
    setLoaded(false);
    setMessage("");
    setOpenInvoice(null);
    if (scope && ["bills", "expenses", "reports", "reminders"].includes(tab)) setTab("overview");
    refresh().catch((error: unknown) => setMessage(errorText(error)));
  }, [context.companyId, scopeKey, enabled === false]);

  if (enabled === false) {
    return (
      <Page title="Billing" description="Invoices, quotes, payments, bills, expenses, time and retainers." accent="billing">
        <p style={{ margin: 0, fontSize: 14, color: tokens.fg, lineHeight: 1.5 }}>
          This module is switched off for this company. Turn it on in{" "}
          <a {...navigation.linkProps("/setup")} style={{ color: tokens.primary, fontWeight: 600 }}>Setup</a>.
        </p>
      </Page>
    );
  }

  const client = snapshot.client ?? null;
  const clientName = client?.name ?? "this client";
  const api: BillingApi = {
    call,
    snapshot,
    scope,
    clientName,
    refresh,
    say: setMessage,
    async run(work, success) {
      setMessage("");
      try {
        await work();
        await refresh();
        setMessage(success);
        return true;
      } catch (error) {
        setMessage(errorText(error));
        return false;
      }
    },
  };

  const openInvoiceTab = (id: string) => {
    setTab("invoices");
    setOpenInvoice(id);
  };

  const pending = (snapshot.pops ?? []).filter((p) => p.status === "pending").length;
  const overdueCount = snapshot.invoices.filter((i) => isOverdue(i)).length;
  const failedCount = snapshot.invoices.filter((i) => i.deliveryStatus === "failed").length;
  const billsDue = (snapshot.bills ?? []).filter((b) => b.outstandingMinor > 0 && b.dueDate && Date.parse(b.dueDate) < Date.now() + 7 * 86_400_000).length;
  const expensesToCheck = (snapshot.expenses ?? []).filter((e) => e.status === "draft" || e.needsReview).length;
  const running = (snapshot.time ?? []).filter((t) => t.running).length;
  const tabs: Array<TabItem & { id: TabId }> = [
    { id: "overview", label: "Overview", icon: LayoutDashboard, count: overdueCount + failedCount + pending || null, countTone: overdueCount + failedCount ? "bad" : "warn" },
    { id: "invoices", label: "Invoices", icon: Receipt, count: snapshot.invoices.length, countTone: overdueCount || failedCount ? "bad" : undefined },
    { id: "quotes", label: "Quotes", icon: FileText, count: snapshot.quotes?.length ?? 0 },
    { id: "payments", label: "Payments", icon: Banknote, count: pending || null, countTone: "warn" },
    ...(scope ? [] : [
      { id: "bills" as const, label: "Bills", icon: CreditCard, count: snapshot.bills?.length ?? 0, countTone: billsDue ? "warn" as const : undefined },
      { id: "expenses" as const, label: "Expenses", icon: Coins, count: snapshot.expenses?.length ?? 0, countTone: expensesToCheck ? "warn" as const : undefined },
    ]),
    { id: "time", label: "Time", icon: Timer, count: running || null, countTone: "info" },
    { id: "retainers", label: "Retainers", icon: RefreshCw },
    ...(scope ? [] : [{ id: "reports" as const, label: "Reports", icon: ChartColumn }, { id: "reminders" as const, label: "Reminders", icon: Mail }]),
  ];

  const draftInvoiceButton = <Button type="button" onClick={() => setCreating(true)}>+ Draft invoice</Button>;
  const pageMessage = message
    || (scope && loaded && client && !client.found ? `${client.name ?? "This client"} is not in the Billing client list yet. Run the CRM "resync" action so new invoices pick up the CRM name.` : undefined)
    || (loaded && snapshot.settingsSaved === false ? "Billing settings are not saved for this company. Open Settings → Plugins → Billing, add your business, VAT and EFT details, and click Save — they print on every invoice." : undefined);

  const body = (
    <BillingContext.Provider value={api}>
      <Tabs tabs={tabs} active={tab} onChange={(id) => setTab(id as TabId)} />
      {!loaded ? <Muted>Loading…</Muted> : null}
      {loaded && tab === "overview" ? <Overview snapshot={snapshot} scope={scope} call={call} go={setTab} onOpenInvoice={openInvoiceTab} /> : null}
      {loaded && tab === "invoices" ? <InvoicesTab openId={openInvoice} setOpenId={setOpenInvoice} /> : null}
      {loaded && tab === "quotes" ? <QuotesTab onOpenInvoice={openInvoiceTab} /> : null}
      {loaded && tab === "payments" ? <PaymentsTab onOpenInvoice={openInvoiceTab} /> : null}
      {loaded && tab === "bills" && !scope ? <BillsTab /> : null}
      {loaded && tab === "expenses" && !scope ? <ExpensesTab /> : null}
      {loaded && tab === "time" ? <TimeTab onOpenInvoice={openInvoiceTab} /> : null}
      {loaded && tab === "retainers" ? <RetainersTab onOpenInvoice={openInvoiceTab} /> : null}
      {loaded && tab === "reports" && !scope ? <ReportsTab /> : null}
      {loaded && tab === "reminders" && !scope ? <RemindersTab /> : null}
      <NewDocumentModal kind="invoice" open={creating} onClose={() => setCreating(false)} onCreated={openInvoiceTab} />
    </BillingContext.Provider>
  );

  if (scope) {
    return (
      <WorkspacePage
        header={(
          <ClientWorkspaceBar
            client={{ kind: scope.kind, id: scope.id, name: client?.name ?? (loaded ? "Unknown client" : "Loading…"), detail: client?.detail ?? null }}
            active="billing"
            linkProps={navigation.linkProps}
            ownPath="/billing"
            ownLabel="All billing"
            actions={draftInvoiceButton}
          />
        )}
        message={pageMessage}
      >
        {body}
      </WorkspacePage>
    );
  }

  return (
    <Page
      title="Billing"
      description="PiB's invoices, quotes, payments, bills, expenses, time and retainers. Agents draft; a person approves sending and confirms money."
      message={pageMessage}
      actions={draftInvoiceButton}
      accent="billing"
    >
      {body}
    </Page>
  );
}

export function BillingSidebar({ context }: PluginSidebarProps) {
  // Nothing while the company has Billing switched off (shown as usual while loading).
  const enabled = useModuleEnabled(context.companyId);
  // The Cockpit's Clients / Marketing / Finance group shows this page instead (pib-plugin-ui NAV_GROUPS).
  const grouped = useGroupedNav("partnersinbiz.billing");
  if (enabled === false || grouped !== false) return null;
  return (
    <SidebarNavLink to="/billing" label="Billing" icon={(
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" />
        <path d="M16 8H8" /><path d="M16 12H8" /><path d="M12 16H8" />
      </svg>
    )} />
  );
}

function SidebarNavLink({ to, label, icon }: { to: string; label: string; icon: ReactNode }) {
  const hostNavigation = useHostNavigation();
  const href = hostNavigation.resolveHref(to);
  const isActive = typeof window !== "undefined" && window.location.pathname === href;
  return (
    <a
      {...hostNavigation.linkProps(to)}
      aria-current={isActive ? "page" : undefined}
      className={[
        "flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 text-(length:--text-compact) font-medium transition-colors",
        isActive ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      ].join(" ")}
      style={{ textDecoration: "none" }}
    >
      <span aria-hidden="true" className="relative shrink-0">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
    </a>
  );
}
