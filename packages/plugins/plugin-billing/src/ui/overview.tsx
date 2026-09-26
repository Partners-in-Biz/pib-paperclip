import { useEffect, useMemo, useState, type MouseEvent } from "react";
import {
  Banknote,
  BarList,
  ChartColumn,
  ChartPie,
  CircleCheck,
  CircleX,
  ColumnChart,
  DonutChart,
  FileText,
  HandCoins,
  Hourglass,
  Pill,
  RefreshCw,
  Send,
  SectionCard,
  StackedBar,
  Timeline,
  TrendChart,
  TriangleAlert,
  Users,
  Activity,
  KpiCard,
  errorText,
  fluidColumns,
  tokens,
  tone,
  type LinkProps,
  type TimelineItem,
} from "@partnersinbiz/pib-plugin-ui";
import type { ClientScope } from "@partnersinbiz/pib-plugin-kit/client-ref";
import { Muted, money, statusLabel, type Call } from "./parts.js";
import {
  AGE_BUCKETS,
  AGE_TONE,
  OPEN_STATUSES,
  billingActivity,
  invoiceAgeing,
  invoiceMonths,
  invoiceStatusCounts,
  isOverdue,
  lastMonths,
  monthLabel,
  percentDelta,
  type AgeBuckets,
  type Tone,
} from "./series.js";
import type { Snapshot } from "./types.js";

export type OverviewTab = "invoices" | "quotes" | "payments" | "bills" | "expenses" | "time" | "retainers" | "reports";

/** The slice of `billing.reports` the Overview reads. */
export interface OverviewReports {
  currency: string;
  revenue: { months: Array<{ month: string; invoicedMinor: number; collectedMinor: number }> };
  clients: { clients: Array<{ clientKey: string; clientName: string; collectedMinor: number; lifetimePaidMinor: number; outstandingMinor: number }> };
  agedDebtors: { buckets: AgeBuckets; totalMinor: number; parties: Array<{ party: string; totalMinor: number }> };
  mrr: { mrrMinor: number; active: number };
  mrrTrend?: Array<{ month: string; mrrMinor: number; active: number }>;
}

/** Short money for chart axes and tooltips, e.g. "R 12,4 k". */
export function compactMoney(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-ZA", { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 }).format(minor / 100);
  } catch {
    return money(minor, currency);
  }
}

const KIND_ICON = { paid: CircleCheck, sent: Send, failed: CircleX, pop: FileText, bill: FileText, expense: FileText } as const;

export function Overview({ snapshot, scope, call, go, onOpenInvoice, now = new Date() }: {
  snapshot: Snapshot;
  scope: ClientScope;
  call: Call;
  go: (tab: OverviewTab) => void;
  onOpenInvoice: (id: string) => void;
  now?: Date;
}) {
  const currency = snapshot.defaults?.currency ?? "ZAR";
  const [reports, setReports] = useState<OverviewReports | null>(null);
  const [reportError, setReportError] = useState("");
  useEffect(() => {
    if (scope) return;
    let live = true;
    call<OverviewReports>("billing.reports", {}).then((r) => { if (live) setReports(r); }).catch((e: unknown) => { if (live) setReportError(errorText(e)); });
    return () => { live = false; };
  }, [scope ? `${scope.kind}:${scope.id}` : "own"]);

  const invoices = snapshot.invoices;
  const nowMs = now.getTime();
  const open = invoices.filter((i) => OPEN_STATUSES.has(i.status) && i.currency === currency);
  const owed = open.reduce((sum, i) => sum + (i.outstandingMinor ?? 0), 0);
  const overdue = invoices.filter((i) => i.currency === currency && isOverdue(i, nowMs));
  const overdueMinor = overdue.reduce((sum, i) => sum + (i.outstandingMinor ?? 0), 0);
  const checking = (snapshot.pops ?? []).filter((p) => p.status === "pending").length;
  const drafts = invoices.filter((i) => i.status === "draft").length;
  const failed = invoices.filter((i) => i.deliveryStatus === "failed").length;
  const months = useMemo(() => lastMonths(now, 12), [now.getUTCFullYear(), now.getUTCMonth()]);

  // Money in per month: the report (FX-converted, by payment date) for the whole book; the snapshot for one client.
  const monthly = useMemo(() => {
    if (!scope && reports) {
      const byMonth = new Map(reports.revenue.months.map((m) => [m.month, m]));
      return months.map((month) => ({ month, invoicedMinor: byMonth.get(month)?.invoicedMinor ?? 0, inMinor: byMonth.get(month)?.collectedMinor ?? 0 }));
    }
    return invoiceMonths(invoices, months, currency).map((m) => ({ month: m.month, invoicedMinor: m.invoicedMinor, inMinor: m.paidMinor }));
  }, [reports, invoices, months, currency, scope]);
  const cur = !scope && reports ? reports.currency : currency;
  const thisMonth = monthly[monthly.length - 1]?.inMinor ?? 0;
  const lastMonth = monthly[monthly.length - 2]?.inMinor ?? 0;
  const ageingBuckets = !scope && reports ? reports.agedDebtors.buckets : invoiceAgeing(invoices, currency, nowMs);
  const statusCounts = invoiceStatusCounts(invoices);
  const mrrTrend = reports?.mrrTrend ?? [];
  const mrrNow = reports?.mrr.mrrMinor ?? 0;
  const mrrPrev = mrrTrend.length > 1 ? mrrTrend[mrrTrend.length - 2]!.mrrMinor : mrrNow;
  const subscriptions = (snapshot.retainers?.subscriptions ?? []).filter((s) => s.status === "active");
  const retainerMinor = subscriptions.reduce((sum, s) => sum + s.priceMinor, 0);

  const link = (tab: OverviewTab): LinkProps => ({ href: `?tab=${tab}`, onClick: (event: MouseEvent<HTMLAnchorElement>) => { event.preventDefault(); go(tab); } });

  const todo: Array<{ text: string; tab: OverviewTab; tone: Tone; label: string }> = [];
  if (overdue.length) todo.push({ text: `${overdue.length} overdue invoice${overdue.length === 1 ? "" : "s"} · ${money(overdueMinor, currency)}`, tab: "invoices", tone: "bad", label: "Overdue" });
  if (failed) todo.push({ text: `${failed} invoice email${failed === 1 ? "" : "s"} failed`, tab: "invoices", tone: "bad", label: "Failed" });
  if (checking) todo.push({ text: `${checking} proof${checking === 1 ? "" : "s"} of payment to check`, tab: "payments", tone: "warn", label: "Check" });
  const draftExpenses = (snapshot.expenses ?? []).filter((e) => e.status === "draft" || e.needsReview).length;
  if (draftExpenses) todo.push({ text: `${draftExpenses} expense${draftExpenses === 1 ? "" : "s"} to check`, tab: "expenses", tone: "warn", label: "Review" });
  const billsDue = (snapshot.bills ?? []).filter((b) => b.outstandingMinor > 0 && b.dueDate && Date.parse(b.dueDate) < nowMs + 7 * 86_400_000).length;
  if (billsDue) todo.push({ text: `${billsDue} bill${billsDue === 1 ? "" : "s"} due within a week`, tab: "bills", tone: "warn", label: "Due" });
  if (drafts) todo.push({ text: `${drafts} draft invoice${drafts === 1 ? "" : "s"}`, tab: "invoices", tone: "info", label: "Draft" });
  const worst: Tone = todo.some((t) => t.tone === "bad") ? "bad" : todo.some((t) => t.tone === "warn") ? "warn" : "info";

  const columns = monthly.map((m) => ({ ...monthLabel(m.month), values: { invoiced: m.invoicedMinor, received: m.inMinor } }));
  const ageingTotal = AGE_BUCKETS.reduce((sum, b) => sum + ageingBuckets[b].amountMinor, 0);
  const lateTone = (bucket: (typeof AGE_BUCKETS)[number]) => (bucket === "61-90" ? `color-mix(in oklab, ${tone("bad").solid} 70%, ${tone("warn").solid})` : undefined);

  const topClients = (reports?.clients.clients ?? [])
    .map((c) => ({ label: c.clientName || c.clientKey, value: c.collectedMinor || 0 }))
    .filter((c) => c.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);

  const timeline: TimelineItem[] = billingActivity(snapshot).map((entry) => ({
    id: entry.id,
    at: entry.at,
    title: entry.title,
    detail: entry.detail,
    tone: entry.tone,
    icon: KIND_ICON[entry.kind],
    link: entry.invoiceId ? { href: "?tab=invoices", onClick: (event: MouseEvent<HTMLAnchorElement>) => { event.preventDefault(); onOpenInvoice(entry.invoiceId!); } } : null,
  }));

  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      <div style={{ display: "grid", gridTemplateColumns: fluidColumns(150), gap: 10 }}>
        <KpiCard label="Owed to you" value={money(owed, currency)} icon={HandCoins} hint={`${open.length} open invoice${open.length === 1 ? "" : "s"}`} link={link("invoices")} />
        <KpiCard
          label="Overdue"
          value={money(overdueMinor, currency)}
          tone={overdueMinor > 0 ? "bad" : undefined}
          icon={TriangleAlert}
          hint={overdue.length ? `${overdue.length} invoice${overdue.length === 1 ? "" : "s"}` : "Nothing overdue"}
          link={link("invoices")}
        />
        <KpiCard
          label="Received this month"
          value={<span style={{ color: thisMonth > 0 ? tone("ok").fg : undefined }}>{money(thisMonth, cur)}</span>}
          icon={Banknote}
          tone="ok"
          delta={percentDelta(thisMonth, lastMonth)}
          sparkline={monthly.map((m) => m.inMinor)}
          link={scope ? link("payments") : link("reports")}
        />
        {scope ? (
          <KpiCard label="Retainer" value={money(retainerMinor, currency)} icon={RefreshCw} hint={subscriptions.length ? `${subscriptions.length} active` : "No active retainer"} link={link("retainers")} />
        ) : (
          <KpiCard
            label="MRR"
            value={money(mrrNow, cur)}
            icon={RefreshCw}
            delta={reports ? percentDelta(mrrNow, mrrPrev) : null}
            hint={reports ? `${reports.mrr.active} retainer${reports.mrr.active === 1 ? "" : "s"}` : undefined}
            sparkline={mrrTrend.map((m) => m.mrrMinor)}
            link={link("retainers")}
          />
        )}
        <KpiCard label="Checking payment" value={checking} tone={checking ? "warn" : undefined} icon={FileText} hint={checking ? "Proofs of payment to check" : "Nothing to check"} link={link("payments")} />
      </div>

      {todo.length > 0 ? (
        <SectionCard title="Needs you" icon={TriangleAlert} tone={worst} strip={worst === "bad"} subtitle="Most urgent first.">
          <div style={{ display: "grid", gap: 6 }}>
            {todo.map((item) => (
              <button
                key={item.text}
                type="button"
                onClick={() => go(item.tab)}
                style={{ display: "flex", alignItems: "center", gap: 10, textAlign: "left", background: tokens.bg, border: `1px solid ${tokens.border}`, borderLeft: `3px solid ${tone(item.tone).solid}`, borderRadius: 9, padding: "8px 10px", fontSize: 13, color: tokens.fg, cursor: "pointer", fontFamily: "inherit", minWidth: 0 }}
              >
                <Pill tone={item.tone} size="sm">{item.label}</Pill>
                <span style={{ flex: "1 1 auto", minWidth: 0, overflowWrap: "anywhere" }}>{item.text}</span>
                <span aria-hidden="true" style={{ color: tokens.muted, fontWeight: 600 }}>→</span>
              </button>
            ))}
          </div>
        </SectionCard>
      ) : null}

      <SectionCard
        title="Money in per month"
        icon={ChartColumn}
        subtitle={scope ? "Invoiced and paid for this client, last 12 months." : "Invoiced (excl. VAT) and money received, last 12 months."}
      >
        {!scope && !reports && !reportError ? <Muted>Loading…</Muted> : null}
        {reportError ? <Muted>Reports could not load: {reportError}</Muted> : null}
        {scope || reports ? (
          <ColumnChart
            data={columns}
            series={[{ key: "invoiced", label: "Invoiced", tone: "neutral" }, { key: "received", label: "Received", tone: "ok" }]}
            stacked={false}
            height={132}
            axis="all"
            title="Money in per month"
            formatValue={(v) => compactMoney(v, cur)}
            emptyText="Nothing invoiced or received in the last 12 months."
          />
        ) : null}
      </SectionCard>

      <div style={{ display: "grid", gridTemplateColumns: fluidColumns(320), gap: 16, alignItems: "start" }}>
        <SectionCard title="Who owes you" icon={Hourglass} tone={ageingBuckets["90+"].amountMinor > 0 || ageingBuckets["61-90"].amountMinor > 0 ? "bad" : ageingBuckets["31-60"].amountMinor > 0 ? "warn" : undefined} subtitle={`${money(ageingTotal, cur)} by days past due.`}>
          {ageingTotal > 0 ? (
            <StackedBar
              title="Owed by days past due"
              height={12}
              segments={AGE_BUCKETS.map((b) => ({ key: b, label: `${b} days`, value: ageingBuckets[b].amountMinor, tone: AGE_TONE[b], color: lateTone(b) }))}
              formatValue={(v) => compactMoney(v, cur)}
            />
          ) : <Muted>Nobody owes you money right now.</Muted>}
          {!scope && reports && reports.agedDebtors.parties.length > 0 ? (
            <div style={{ display: "grid", gap: 6 }}>
              {reports.agedDebtors.parties.slice(0, 4).map((p) => (
                <div key={p.party} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13, minWidth: 0 }}>
                  <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{p.party}</span>
                  <span style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{money(p.totalMinor, cur)}</span>
                </div>
              ))}
            </div>
          ) : null}
        </SectionCard>

        <SectionCard title="Invoices by status" icon={ChartPie} subtitle={`${invoices.length} invoice${invoices.length === 1 ? "" : "s"}.`}>
          {invoices.length ? (
            <DonutChart
              title="Invoices by status"
              size={128}
              centerValue={invoices.length}
              centerLabel="invoices"
              segments={statusCounts.map((s) => ({ key: s.status, label: statusLabel(s.status), value: s.count, tone: s.tone }))}
            />
          ) : <Muted>No invoices yet.</Muted>}
        </SectionCard>

        {!scope ? (
          <SectionCard title="Recurring revenue" icon={RefreshCw} subtitle="MRR at each month end, from active retainers and repeating invoices.">
            {reports ? (
              <TrendChart
                title="MRR"
                labels={mrrTrend.map((m) => monthLabel(m.month).label)}
                series={[{ key: "mrr", label: "MRR", values: mrrTrend.map((m) => m.mrrMinor) }]}
                formatValue={(v) => compactMoney(v, cur)}
                height={120}
                emptyText="No retainers yet."
              />
            ) : <Muted>{reportError ? "Not available." : "Loading…"}</Muted>}
          </SectionCard>
        ) : null}

      </div>

      <div style={{ display: "grid", gridTemplateColumns: fluidColumns(360), gap: 16, alignItems: "start" }}>
        {!scope ? (
          <SectionCard title="Top clients" icon={Users} subtitle="Money received in the last 12 months.">
            {topClients.length ? <BarList bare title="Received per client" items={topClients.map((c) => ({ ...c, tone: "ok" as const }))} formatValue={(v) => compactMoney(v, cur)} /> : <Muted>{reports ? "No money received yet." : "Loading…"}</Muted>}
          </SectionCard>
        ) : null}

        <SectionCard title="Recent activity" icon={Activity} subtitle="Invoices sent and paid, and proofs of payment.">
          <Timeline items={timeline} now={now} dense empty="Nothing yet. Sent and paid invoices show here." />
        </SectionCard>
      </div>
    </div>
  );
}
