import { useEffect, useMemo, useState, type ReactNode } from "react";
import { MetricCard, useHostLocation, useHostNavigation, type PluginPageProps, type PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import { BarChart, Button, ClientWorkspaceBar, Page, PageFrame, PageMessage, StatRow, Tabs, errorText, tokens } from "@partnersinbiz/pib-plugin-ui";
import { clientScopeFromSearch, formatClientParam } from "@partnersinbiz/pib-plugin-kit/client-ref";
import { resolvePluginUiBase } from "@partnersinbiz/pib-plugin-kit/oauth-client";
import { moduleEnabled } from "@partnersinbiz/pib-plugin-kit/setup-client";
import { BillsTab, ExpensesTab } from "./costs.js";
import { InvoicesTab, NewDocumentModal } from "./invoices.js";
import { BillingContext, Muted, money, useCall, type BillingApi } from "./parts.js";
import { PaymentsTab } from "./payments.js";
import { QuotesTab } from "./quotes.js";
import { RemindersTab, ReportsTab } from "./reports.js";
import { RetainersTab } from "./retainers.js";
import { TimeTab } from "./time.js";
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

const OPEN = new Set(["sent", "viewed", "overdue", "partially_paid", "payment_pending_verification"]);

/** Page layout for a client workspace: the shared client bar replaces the page header. */
function WorkspacePage({ header, message, children }: { header: ReactNode; message?: string; children: ReactNode }) {
  return (
    <PageFrame>
      {header}
      <PageMessage message={message} />
      {children}
    </PageFrame>
  );
}

function Overview({ snapshot, go }: { snapshot: Snapshot; go: (tab: TabId) => void }) {
  const currency = snapshot.defaults?.currency ?? "ZAR";
  const invoices = snapshot.invoices;
  const owed = invoices.filter((i) => OPEN.has(i.status) && i.currency === currency).reduce((sum, i) => sum + (i.outstandingMinor ?? 0), 0);
  const overdue = invoices.filter((i) => OPEN.has(i.status) && (i.outstandingMinor ?? 0) > 0 && (i.status === "overdue" || (i.dueAt && Date.parse(i.dueAt) < Date.now())));
  const checking = (snapshot.pops ?? []).filter((p) => p.status === "pending").length;
  const drafts = invoices.filter((i) => i.status === "draft").length;
  const failed = invoices.filter((i) => i.deliveryStatus === "failed").length;
  const byStatus = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const invoice of invoices) counts[invoice.status] = (counts[invoice.status] ?? 0) + 1;
    return counts;
  }, [invoices]);
  const todo: Array<{ text: string; tab: TabId }> = [];
  if (checking) todo.push({ text: `${checking} proof${checking === 1 ? "" : "s"} of payment to check`, tab: "payments" });
  if (failed) todo.push({ text: `${failed} invoice email${failed === 1 ? "" : "s"} failed`, tab: "invoices" });
  if (overdue.length) todo.push({ text: `${overdue.length} overdue invoice${overdue.length === 1 ? "" : "s"}`, tab: "invoices" });
  if (drafts) todo.push({ text: `${drafts} draft invoice${drafts === 1 ? "" : "s"}`, tab: "invoices" });
  const draftExpenses = (snapshot.expenses ?? []).filter((e) => e.status === "draft" || e.needsReview).length;
  if (draftExpenses) todo.push({ text: `${draftExpenses} expense${draftExpenses === 1 ? "" : "s"} to check`, tab: "expenses" });
  const billsDue = (snapshot.bills ?? []).filter((b) => b.outstandingMinor > 0 && b.dueDate && Date.parse(b.dueDate) < Date.now() + 7 * 86_400_000).length;
  if (billsDue) todo.push({ text: `${billsDue} bill${billsDue === 1 ? "" : "s"} due within a week`, tab: "bills" });
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <StatRow>
        <MetricCard label="Owed to you" value={money(owed, currency)} />
        <MetricCard label="Overdue" value={overdue.length} />
        <MetricCard label="Checking payment" value={checking} />
        <MetricCard label="Invoices" value={invoices.length} />
      </StatRow>
      {todo.length > 0 ? (
        <section style={{ display: "grid", gap: 6, padding: 14, borderRadius: 12, border: `1px solid ${tokens.border}`, background: tokens.card }}>
          <h3 style={{ margin: 0, fontSize: 12, fontWeight: 650, letterSpacing: "0.06em", textTransform: "uppercase", color: tokens.muted }}>Needs you</h3>
          {todo.map((item) => (
            <button key={item.text} type="button" onClick={() => go(item.tab)} style={{ textAlign: "left", background: tokens.secondary, border: 0, borderRadius: 8, padding: "8px 10px", fontSize: 13, color: tokens.fg, cursor: "pointer", fontFamily: "inherit" }}>{item.text} →</button>
          ))}
        </section>
      ) : null}
      <BarChart title="Invoices by status" items={Object.entries(byStatus).map(([label, value]) => ({ label: label.replace(/_/g, " "), value }))} />
    </div>
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
      <Page title="Billing" description="Invoices, quotes, payments, bills, expenses, time and retainers.">
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
  const tabs: Array<{ id: TabId; label: string }> = [
    { id: "overview", label: "Overview" },
    { id: "invoices", label: `Invoices (${snapshot.invoices.length})` },
    { id: "quotes", label: `Quotes (${snapshot.quotes?.length ?? 0})` },
    { id: "payments", label: pending ? `Payments (${pending} to check)` : "Payments" },
    ...(scope ? [] : [{ id: "bills" as const, label: `Bills (${snapshot.bills?.length ?? 0})` }, { id: "expenses" as const, label: `Expenses (${snapshot.expenses?.length ?? 0})` }]),
    { id: "time", label: "Time" },
    { id: "retainers", label: "Retainers" },
    ...(scope ? [] : [{ id: "reports" as const, label: "Reports" }, { id: "reminders" as const, label: "Reminders" }]),
  ];

  const draftInvoiceButton = <Button type="button" onClick={() => setCreating(true)}>+ Draft invoice</Button>;
  const pageMessage = message
    || (scope && loaded && client && !client.found ? `${client.name ?? "This client"} is not in the Billing client list yet. Run the CRM "resync" action so new invoices pick up the CRM name.` : undefined)
    || (loaded && snapshot.settingsSaved === false ? "Billing settings are not saved for this company. Open Settings → Plugins → Billing, add your business, VAT and EFT details, and click Save — they print on every invoice." : undefined);

  const body = (
    <BillingContext.Provider value={api}>
      <Tabs tabs={tabs} active={tab} onChange={(id) => setTab(id as TabId)} />
      {!loaded ? <Muted>Loading…</Muted> : null}
      {loaded && tab === "overview" ? <Overview snapshot={snapshot} go={setTab} /> : null}
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
    >
      {body}
    </Page>
  );
}

export function BillingSidebar({ context }: PluginSidebarProps) {
  // Nothing while the company has Billing switched off (shown as usual while loading).
  if (useModuleEnabled(context.companyId) === false) return null;
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
