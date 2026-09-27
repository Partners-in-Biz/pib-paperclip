import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useHostLocation, useHostNavigation, type PluginPageProps, type PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import { Button, ClientWorkspaceBar, Coins, FileText, LayoutDashboard, Page, PageFrame, PageMessage, Receipt, RefreshCw, Tabs, Timer, errorText, tokens, useUrlTab, type TabItem } from "@partnersinbiz/pib-plugin-ui";
import { GetStarted, useGroupedNav, usePluginSetupStatus } from "@partnersinbiz/pib-plugin-ui";
import { clientScopeFromSearch, formatClientParam } from "@partnersinbiz/pib-plugin-kit/client-ref";
import { resolvePluginUiBase } from "@partnersinbiz/pib-plugin-kit/oauth-client";
import { moduleEnabled } from "@partnersinbiz/pib-plugin-kit/setup-client";
import { BillsTab, ExpensesTab } from "./costs.js";
import { InvoicesTab, NewDocumentModal } from "./invoices.js";
import { Overview } from "./overview.js";
import { BillingContext, Muted, SectionNav, money, useCall, type BillingApi } from "./parts.js";
import { CreditNotesSection, PaymentsTab } from "./payments.js";
import { QuotesTab } from "./quotes.js";
import { RemindersTab, ReportsTab } from "./reports.js";
import { RetainersTab } from "./retainers.js";
import { TimeTab } from "./time.js";
import { draftsToSend, isOverdue, waitingOnPerson } from "./series.js";
import type { Snapshot } from "./types.js";
import { openFormFor, resolveView, sectionsFor, tabsFor, TOP_TABS, VIEW_IDS, viewForTab, type TopTab, type View } from "./views.js";

const PLUGIN_KEY = "partnersinbiz.billing";
const TAB_ICON: Record<TopTab, TabItem["icon"]> = { overview: LayoutDashboard, invoices: Receipt, quotes: FileText, recurring: RefreshCw, costs: Coins, time: Timer };

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
  // "Finish setting up Billing" on the overview until its required setup is done.
  const setupStatus = usePluginSetupStatus(PLUGIN_KEY, context.companyId);
  const scope = useMemo(() => clientScopeFromSearch(location.search), [location.search]);
  const scopeKey = scope ? formatClientParam(scope) : "own";
  const call = useCall();
  const [snapshot, setSnapshot] = useState<Snapshot>({ invoices: [] });
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  // `?tab=` is a tab or a section (payments, reminders, bills…); every pre-0.4 value still opens the same place.
  const [view, setView] = useUrlTab<View>(VIEW_IDS, "overview", { path: "/billing", search: location.search, navigate: navigation.navigate });
  const { tab, section } = resolveView(view, Boolean(scope));
  const [openInvoice, setOpenInvoice] = useState<string | null>(null);
  const [openQuote, setOpenQuote] = useState<string | null>(null);
  const [creating, setCreating] = useState<"invoice" | "quote" | null>(null);
  const [prefillDeal, setPrefillDeal] = useState<string | null>(null);
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
    setOpenQuote(null);
    refresh().catch((error: unknown) => setMessage(errorText(error)));
  }, [context.companyId, scopeKey, enabled === false]);

  // A deep link (the CRM deal drawer's "Draft a quote"): ?tab=quotes&new=1&client=company:<id>&dealId=<id>
  // opens the new-quote form for that client and deal; `tab=invoices` does the same for an invoice. The one-off
  // `new` and `dealId` are then taken out of the address, so a refresh does not open the form again.
  useEffect(() => {
    if (!loaded) return;
    const params = new URLSearchParams(location.search);
    if (params.get("new") !== "1") return;
    const kind = openFormFor(params.get("tab"));
    if (kind) {
      setPrefillDeal(params.get("dealId")?.trim() || null);
      setCreating(kind);
    }
    params.delete("new");
    params.delete("dealId");
    const rest = params.toString();
    navigation.navigate(`/billing${rest ? `?${rest}` : ""}`, { replace: true });
  }, [loaded, location.search]);

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
    setView("invoices");
    setOpenInvoice(id);
  };
  const openQuoteTab = (id: string) => {
    setView("quotes");
    setOpenQuote(id);
  };

  const pending = (snapshot.pops ?? []).filter((p) => p.status === "pending").length;
  const overdueCount = snapshot.invoices.filter((i) => isOverdue(i)).length;
  const failedCount = snapshot.invoices.filter((i) => i.deliveryStatus === "failed").length;
  const billsDue = (snapshot.bills ?? []).filter((b) => b.outstandingMinor > 0 && b.dueDate && Date.parse(b.dueDate) < Date.now() + 7 * 86_400_000).length;
  const expensesToCheck = (snapshot.expenses ?? []).filter((e) => e.status === "draft" || e.needsReview).length;
  const running = (snapshot.time ?? []).filter((t) => t.running).length;
  const waiting = waitingOnPerson(snapshot, money).length;
  const drafts = draftsToSend(snapshot);
  const quoteDrafts = drafts.filter((d) => d.kind === "quote").length;
  const invoiceDrafts = drafts.length - quoteDrafts;
  const counts: Record<TopTab, Pick<TabItem, "count" | "countTone">> = {
    overview: { count: waiting || null, countTone: "warn" },
    invoices: { count: overdueCount + failedCount || invoiceDrafts || null, countTone: overdueCount || failedCount ? "bad" : "info" },
    quotes: { count: quoteDrafts || null, countTone: "info" },
    recurring: { count: null },
    costs: { count: billsDue + expensesToCheck || null, countTone: "warn" },
    time: { count: running || null, countTone: "info" },
  };
  const tabs: TabItem[] = tabsFor(Boolean(scope)).map((id) => ({ id, label: TOP_TABS.find((t) => t.id === id)!.label, icon: TAB_ICON[id], ...counts[id] }));
  const sectionCount: Partial<Record<View, { count: number | null; tone?: "warn" | "bad" | "info" }>> = {
    payments: { count: pending || null, tone: "warn" },
    expenses: { count: expensesToCheck || null, tone: "warn" },
    bills: { count: billsDue || null, tone: "warn" },
  };
  const sections = sectionsFor(tab, Boolean(scope)).map((s) => ({ id: s.view, label: s.label, count: sectionCount[s.view]?.count ?? null, tone: sectionCount[s.view]?.tone }));

  // One main action, and it follows the open tab. A list with nothing in it offers it in its empty state instead.
  const invoiceCount = snapshot.invoices.length;
  const quoteCount = (snapshot.quotes ?? []).length;
  const headerAction = !loaded
    ? null
    : tab === "quotes"
      ? (quoteCount > 0 ? <Button type="button" onClick={() => setCreating("quote")}>+ Draft quote</Button> : null)
      : tab === "overview" || (tab === "invoices" && !(section === "invoices" && invoiceCount === 0))
        ? <Button type="button" onClick={() => setCreating("invoice")}>+ Draft invoice</Button>
        : null;
  // The module already has real data: the setup card starts as one line.
  const hasData = invoiceCount + quoteCount + (snapshot.bills ?? []).length + (snapshot.expenses ?? []).length + (snapshot.time ?? []).length > 0;
  const pageMessage = message
    || (scope && loaded && client && !client.found ? `${client.name ?? "This client"} is not in Billing's client list yet. The CRM shares new clients within 15 minutes; until then new documents use the name typed on them.` : undefined)
    || (loaded && snapshot.settingsSaved === false ? "Billing settings are not saved for this company. Open Settings → Plugins → Billing, add your business, VAT and EFT details, and click Save — they print on every invoice." : undefined);

  const body = (
    <BillingContext.Provider value={api}>
      <Tabs tabs={tabs} active={tab} onChange={(id) => setView(viewForTab(id as TopTab))} />
      <SectionNav items={sections} active={section} onChange={(id) => setView(id as View)} />
      {!loaded ? <Muted>Loading…</Muted> : null}
      {!scope && section === "overview" ? <GetStarted status={setupStatus} moduleName="Billing" hasData={hasData} linkFor={(href) => navigation.linkProps(href) as unknown as Record<string, unknown>} /> : null}
      {loaded && section === "overview" ? <Overview snapshot={snapshot} scope={scope} call={call} go={setView} onOpenInvoice={openInvoiceTab} onOpenQuote={openQuoteTab} /> : null}
      {loaded && section === "reports" && !scope ? <ReportsTab /> : null}
      {loaded && section === "invoices" ? <InvoicesTab openId={openInvoice} setOpenId={setOpenInvoice} onCreate={() => setCreating("invoice")} /> : null}
      {loaded && section === "payments" ? <PaymentsTab onOpenInvoice={openInvoiceTab} /> : null}
      {loaded && section === "credit-notes" ? <CreditNotesSection onOpenInvoice={openInvoiceTab} /> : null}
      {loaded && section === "reminders" && !scope ? <RemindersTab /> : null}
      {loaded && section === "quotes" ? <QuotesTab onOpenInvoice={openInvoiceTab} openId={openQuote} setOpenId={setOpenQuote} onCreate={() => setCreating("quote")} /> : null}
      {loaded && (section === "retainers" || section === "repeating") ? <RetainersTab onOpenInvoice={openInvoiceTab} part={section} /> : null}
      {loaded && section === "bills" && !scope ? <BillsTab /> : null}
      {loaded && section === "expenses" && !scope ? <ExpensesTab /> : null}
      {loaded && section === "time" ? <TimeTab onOpenInvoice={openInvoiceTab} /> : null}
      <NewDocumentModal kind="invoice" open={creating === "invoice"} dealId={prefillDeal} onClose={() => { setCreating(null); setPrefillDeal(null); }} onCreated={openInvoiceTab} />
      <NewDocumentModal kind="quote" open={creating === "quote"} dealId={prefillDeal} onClose={() => { setCreating(null); setPrefillDeal(null); }} onCreated={openQuoteTab} />
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
            actions={headerAction}
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
      description="PiB's invoices, quotes, payments, retainers, bills and time. Agents draft and ask; a person approves sending and money."
      message={pageMessage}
      actions={headerAction}
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
