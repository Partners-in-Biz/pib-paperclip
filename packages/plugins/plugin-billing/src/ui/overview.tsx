import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { useHostNavigation } from "@paperclipai/plugin-sdk/ui";
import {
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
  Stamp,
  errorText,
  fluidColumns,
  formatMoneyCompact,
  formatShortDate,
  relativeTime,
  tokens,
  tone,
  type LinkProps,
  type TimelineItem,
} from "@partnersinbiz/pib-plugin-ui";
import type { ClientScope } from "@partnersinbiz/pib-plugin-kit/client-ref";
import { IssueLink, Muted, SmallButton, money, statusLabel, type Call } from "./parts.js";
import {
  AGE_BUCKETS,
  AGE_TONE,
  OPEN_STATUSES,
  billingActivity,
  draftsToSend,
  futurePaymentsText,
  invoiceAgeing,
  invoiceMonths,
  invoiceStatusCounts,
  isOverdue,
  lastMonths,
  monthLabel,
  percentDelta,
  waitingOnPerson,
  type AgeBuckets,
  type Tone,
  type WaitingEntry,
} from "./series.js";
import type { Snapshot } from "./types.js";
import type { View } from "./views.js";

/** The slice of `billing.reports` the Overview reads. */
export interface OverviewReports {
  currency: string;
  revenue: { months: Array<{ month: string; invoicedMinor: number; collectedMinor: number }> };
  clients: { clients: Array<{ clientKey: string; clientName: string; collectedMinor: number; lifetimePaidMinor: number; outstandingMinor: number }> };
  agedDebtors: { buckets: AgeBuckets; totalMinor: number; parties: Array<{ party: string; totalMinor: number }> };
  mrr: { mrrMinor: number; active: number };
  mrrTrend?: Array<{ month: string; mrrMinor: number; active: number }>;
}

/** Short money for chart axes and tight tiles, e.g. "R 7.5k" (the shared compact format). */
export function compactMoney(minor: number, currency: string): string {
  return formatMoneyCompact(minor, currency);
}

/** "1–27 Sep" (or "1 Oct" on the first): what "this month" covers as at `asOf`. */
export function monthToDate(asOf: string): string {
  return Number(asOf.slice(8, 10)) <= 1 ? formatShortDate(asOf) : `1–${formatShortDate(asOf)}`;
}

const KIND_ICON = { paid: CircleCheck, sent: Send, failed: CircleX, pop: FileText, bill: FileText, expense: FileText } as const;
const WAIT_LABEL: Record<WaitingEntry["kind"], { label: string; tone: Tone }> = {
  money: { label: "Money", tone: "bad" },
  check: { label: "Check", tone: "warn" },
  send: { label: "Send", tone: "info" },
};
const ROUTE_WORDS: Record<string, string> = { operator: "the Operator", owner: "you", bookkeeper: "the Bookkeeper", none: "nobody" };

const rowStyle = { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" as const, background: tokens.bg, border: `1px solid ${tokens.border}`, borderRadius: 9, padding: "8px 10px", fontSize: 13, color: tokens.fg, minWidth: 0 };

export function Overview({ snapshot, scope, call, go, onOpenInvoice, onOpenQuote, now = new Date() }: {
  snapshot: Snapshot;
  scope: ClientScope;
  call: Call;
  go: (view: View) => void;
  onOpenInvoice: (id: string) => void;
  onOpenQuote: (id: string) => void;
  now?: Date;
}) {
  const nav = useHostNavigation();
  const currency = snapshot.defaults?.currency ?? "ZAR";
  const [reports, setReports] = useState<OverviewReports | null>(null);
  const [reportError, setReportError] = useState("");
  // The same report (money in by payment date, as at today) for the whole book and for one client.
  const scopeKey = scope ? `${scope.kind}:${scope.id}` : "own";
  useEffect(() => setReports(null), [scopeKey]);
  useEffect(() => {
    let live = true;
    call<OverviewReports>("billing.reports", scope ? { client: scope } : {}).then((r) => { if (live) { setReports(r); setReportError(""); } }).catch((e: unknown) => { if (live) setReportError(errorText(e)); });
    return () => { live = false; };
  }, [scopeKey, snapshot]);

  const invoices = snapshot.invoices;
  const nowMs = now.getTime();
  // Every money figure here is as at this day: a payment dated later counts nowhere yet and is flagged.
  const asOf = snapshot.asOf ?? now.toISOString().slice(0, 10);
  const asAt = `as at ${formatShortDate(asOf)}`;
  const futureText = futurePaymentsText(snapshot.futurePayments ?? [], formatShortDate);
  const open = invoices.filter((i) => OPEN_STATUSES.has(i.status) && i.currency === currency);
  const owed = open.reduce((sum, i) => sum + (i.outstandingMinor ?? 0), 0);
  const overdue = invoices.filter((i) => i.currency === currency && isOverdue(i, nowMs));
  const overdueMinor = overdue.reduce((sum, i) => sum + (i.outstandingMinor ?? 0), 0);
  const failed = invoices.filter((i) => i.deliveryStatus === "failed").length;
  const waiting = useMemo(() => waitingOnPerson(snapshot, money), [snapshot]);
  const drafts = useMemo(() => draftsToSend(snapshot, nowMs), [snapshot, nowMs]);
  const staleDrafts = drafts.filter((d) => d.stale).length;
  const draftsMinor = drafts.filter((d) => d.currency === currency).reduce((sum, d) => sum + d.totalMinor, 0);
  const draftsIssue = (snapshot.workIssues ?? []).find((w) => w.kind === "drafts") ?? null;
  const overdueIssue = (snapshot.workIssues ?? []).find((w) => w.kind === "overdue") ?? null;
  const months = useMemo(() => lastMonths(now, 12), [now.getUTCFullYear(), now.getUTCMonth()]);

  // Money in per month: the report (FX-converted, by payment date, as at today), for the book or this client.
  const monthly = useMemo(() => {
    if (reports) {
      const byMonth = new Map(reports.revenue.months.map((m) => [m.month, m]));
      return months.map((month) => ({ month, invoicedMinor: byMonth.get(month)?.invoicedMinor ?? 0, inMinor: byMonth.get(month)?.collectedMinor ?? 0 }));
    }
    return invoiceMonths(invoices, months, currency).map((m) => ({ month: m.month, invoicedMinor: m.invoicedMinor, inMinor: m.paidMinor }));
  }, [reports, invoices, months, currency]);
  const cur = reports ? reports.currency : currency;
  const thisMonth = monthly[monthly.length - 1]?.inMinor ?? 0;
  const lastMonth = monthly[monthly.length - 2]?.inMinor ?? 0;
  const ageingBuckets = reports ? reports.agedDebtors.buckets : invoiceAgeing(invoices, currency, nowMs);
  const statusCounts = invoiceStatusCounts(invoices);
  const mrrTrend = reports?.mrrTrend ?? [];

  const link = (view: View): LinkProps => ({ href: `?tab=${view}`, onClick: (event: MouseEvent<HTMLAnchorElement>) => { event.preventDefault(); go(view); } });

  const attention: Array<{ text: string; view: View; tone: Tone; label: string }> = [];
  if (futureText) attention.push({ text: futureText, view: "payments", tone: "warn", label: "Date" });
  if (overdue.length) attention.push({ text: `${overdue.length} overdue invoice${overdue.length === 1 ? "" : "s"} · ${money(overdueMinor, currency)}`, view: "invoices", tone: "bad", label: "Overdue" });
  if (failed) attention.push({ text: `${failed} invoice email${failed === 1 ? "" : "s"} failed: retry from the invoice`, view: "invoices", tone: "bad", label: "Failed" });
  const draftExpenses = (snapshot.expenses ?? []).filter((e) => e.status === "draft" || e.needsReview).length;
  if (draftExpenses) attention.push({ text: `${draftExpenses} expense${draftExpenses === 1 ? "" : "s"} to check`, view: "expenses", tone: "warn", label: "Review" });
  const billsDue = (snapshot.bills ?? []).filter((b) => b.outstandingMinor > 0 && b.dueDate && Date.parse(b.dueDate) < nowMs + 7 * 86_400_000).length;
  if (billsDue) attention.push({ text: `${billsDue} bill${billsDue === 1 ? "" : "s"} due within a week`, view: "bills", tone: "warn", label: "Due" });

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

  const team = snapshot.team ?? null;

  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      <div style={{ display: "grid", gridTemplateColumns: fluidColumns(150), gap: 10 }}>
        <KpiCard label="Owed to you" value={money(owed, currency)} icon={HandCoins} hint={`${open.length} open invoice${open.length === 1 ? "" : "s"} · ${asAt}`} link={link("invoices")} />
        <KpiCard
          label="Overdue"
          value={money(overdueMinor, currency)}
          tone={overdueMinor > 0 ? "bad" : undefined}
          icon={TriangleAlert}
          hint={overdue.length ? `${overdue.length} invoice${overdue.length === 1 ? "" : "s"} · ${asAt}` : `Nothing overdue · ${asAt}`}
          link={link("invoices")}
        />
        <KpiCard
          label="Drafts to send"
          value={drafts.length}
          tone={staleDrafts ? "warn" : undefined}
          icon={Send}
          hint={drafts.length ? `${money(draftsMinor, currency)}${staleDrafts ? ` · ${staleDrafts} over a day` : ""}` : "Nothing waiting"}
          link={link("invoices")}
        />
        <KpiCard label="Waiting on you" value={waiting.length} tone={waiting.length ? "warn" : undefined} icon={Stamp} hint={waiting.length ? "Approvals and checks" : "Nothing to decide"} />
      </div>

      {team && !team.accountManager ? (
        <div role="status" style={{ ...rowStyle, borderLeft: `3px solid ${tone(team.via === "none" ? "bad" : "warn").solid}` }}>
          <span style={{ flex: "1 1 220px", minWidth: 0, overflowWrap: "anywhere" }}>
            {team.via === "none"
              ? "No Account Manager is running and no Operator or owner is set, so Billing's follow-ups (drafts to send, overdue invoices, quote replies) are not assigned to anyone."
              : `No Account Manager is running, so drafts to send, overdue follow-ups and quote replies go to ${ROUTE_WORDS[team.via] ?? "the Operator"}.`}
          </span>
          <a {...nav.linkProps(team.setupHref)} style={{ display: "inline-flex", alignItems: "center", height: 28, padding: "0 10px", borderRadius: 8, background: tokens.primary, color: tokens.primaryFg, fontSize: 12, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" }}>Fix in Setup</a>
        </div>
      ) : null}

      <SectionCard
        title="Waiting on you"
        icon={Stamp}
        tone={waiting.some((w) => w.kind === "money") ? "bad" : waiting.length ? "warn" : "ok"}
        strip={waiting.length > 0}
        subtitle={waiting.length ? "Only a person can decide these. Open the issue, check it, then mark it done (or cancel it to refuse)." : undefined}
      >
        {waiting.length === 0 ? <Muted>Nothing is waiting on you. Send approvals, payment checks and money decisions land here.</Muted> : (
          <div style={{ display: "grid", gap: 6 }}>
            {waiting.slice(0, 12).map((item) => (
              <div key={item.key} style={{ ...rowStyle, borderLeft: `3px solid ${tone(WAIT_LABEL[item.kind].tone).solid}` }}>
                <Pill tone={WAIT_LABEL[item.kind].tone} size="sm">{WAIT_LABEL[item.kind].label}</Pill>
                <span style={{ flex: "1 1 180px", minWidth: 0, overflowWrap: "anywhere" }}>{item.title}</span>
                {item.invoiceId ? <SmallButton onClick={() => onOpenInvoice(item.invoiceId!)}>Invoice</SmallButton> : item.quoteId ? <SmallButton onClick={() => onOpenQuote(item.quoteId!)}>Quote</SmallButton> : null}
                {item.issueId ? <IssueLink issueId={item.issueId} /> : <span style={{ fontSize: 12, color: tokens.muted }}>On the Billing page</span>}
              </div>
            ))}
            {waiting.length > 12 ? <Muted>And {waiting.length - 12} more. Every one is also in the Cockpit's Waiting on you.</Muted> : null}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Drafts to send"
        icon={Send}
        tone={staleDrafts ? "warn" : undefined}
        subtitle={drafts.length ? `The Account Manager checks each and asks for approval. Drafts over a day old are on its daily "Drafts to send" issue.` : undefined}
        actions={draftsIssue ? <IssueLink issueId={draftsIssue.issueId}>Drafts issue</IssueLink> : null}
      >
        {drafts.length === 0 ? <Muted>Nothing waiting: every draft is sent or waiting for approval. Draft an invoice or quote to start.</Muted> : (
          <div style={{ display: "grid", gap: 6 }}>
            {drafts.slice(0, 8).map((d) => (
              <button
                key={`${d.kind}:${d.id}`}
                type="button"
                onClick={() => (d.kind === "invoice" ? onOpenInvoice(d.id) : onOpenQuote(d.id))}
                style={{ ...rowStyle, textAlign: "left", cursor: "pointer", fontFamily: "inherit", borderLeft: `3px solid ${tone(d.stale ? "warn" : "info").solid}` }}
              >
                <Pill tone={d.kind === "invoice" ? "info" : "neutral"} size="sm">{d.kind === "invoice" ? "Invoice" : "Quote"}</Pill>
                <span style={{ flex: "1 1 160px", minWidth: 0, overflowWrap: "anywhere" }}>
                  <strong>{d.who}</strong>{d.note ? <span style={{ color: tokens.muted }}> · {d.note}</span> : null}
                </span>
                <span style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{money(d.totalMinor, d.currency)}</span>
                <span style={{ fontSize: 12, color: d.stale ? tone("warn").fg : tokens.muted, whiteSpace: "nowrap" }}>{relativeTime(d.createdAt, now) ?? ""}</span>
              </button>
            ))}
            {drafts.length > 8 ? <Muted>And {drafts.length - 8} more on the Invoices and Quotes tabs.</Muted> : null}
          </div>
        )}
      </SectionCard>

      {attention.length > 0 ? (
        <SectionCard title="Needs attention" icon={TriangleAlert} tone={attention.some((a) => a.tone === "bad") ? "bad" : "warn"} subtitle={overdueIssue ? undefined : "Most urgent first."} actions={overdueIssue ? <IssueLink issueId={overdueIssue.issueId}>Overdue issue</IssueLink> : null}>
          <div style={{ display: "grid", gap: 6 }}>
            {attention.map((item) => (
              <button
                key={item.text}
                type="button"
                onClick={() => go(item.view)}
                style={{ ...rowStyle, textAlign: "left", cursor: "pointer", fontFamily: "inherit", borderLeft: `3px solid ${tone(item.tone).solid}` }}
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
        subtitle={`${money(thisMonth, cur)} received ${monthToDate(asOf)}${percentDelta(thisMonth, lastMonth) ? ` (${percentDelta(thisMonth, lastMonth)})` : ""}. Invoiced (excl. VAT) and money received${scope ? " for this client" : ""}, last 12 months.`}
        actions={<SmallButton onClick={() => go(scope ? "payments" : "reports")}>{scope ? "Payments" : "Reports"}</SmallButton>}
      >
        {!reports && !reportError ? <Muted>Loading…</Muted> : null}
        {reportError ? <Muted>Reports could not load: {reportError}</Muted> : null}
        {reports || reportError ? (
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
        <SectionCard title="Who owes you" icon={Hourglass} tone={ageingBuckets["90+"].amountMinor > 0 || ageingBuckets["61-90"].amountMinor > 0 ? "bad" : ageingBuckets["31-60"].amountMinor > 0 ? "warn" : undefined} subtitle={`${money(ageingTotal, cur)} ${asAt}, by days past due.`}>
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
          ) : <Muted>No invoices yet. Draft one with + Draft invoice at the top.</Muted>}
        </SectionCard>

        {!scope ? (
          <SectionCard title="Recurring revenue" icon={RefreshCw} subtitle={reports ? `MRR ${money(reports.mrr.mrrMinor, cur)} from ${reports.mrr.active} retainer${reports.mrr.active === 1 ? "" : "s"} and repeating invoices.` : "MRR at each month end."}>
            {reports ? (
              <TrendChart
                title="MRR"
                labels={mrrTrend.map((m) => monthLabel(m.month).label)}
                series={[{ key: "mrr", label: "MRR", values: mrrTrend.map((m) => m.mrrMinor) }]}
                formatValue={(v) => compactMoney(v, cur)}
                height={120}
                emptyText="No retainers yet. Put a client on one under Recurring."
              />
            ) : <Muted>{reportError ? "Not available." : "Loading…"}</Muted>}
          </SectionCard>
        ) : null}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: fluidColumns(360), gap: 16, alignItems: "start" }}>
        {!scope ? (
          <SectionCard title="Top clients" icon={Users} subtitle={`Money received in the last 12 months, ${asAt}.`}>
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
