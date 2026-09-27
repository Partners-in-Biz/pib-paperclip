import { useEffect, useState } from "react";
import { DataTable } from "@paperclipai/plugin-sdk/ui";
import { BarList, Banknote, ChartColumn, Clock, ColumnChart, CreditCard, Field, HandCoins, Input, KpiCard, Mail, Receipt, RefreshCw, StackedBar, Timeline, TrendChart, Users, Coins, errorText, fluidColumns, tokens, tone } from "@partnersinbiz/pib-plugin-ui";
import { compactMoney } from "./overview.js";
import { Card, Money, Muted, Row, SmallButton, fmtDate, money, today, useBilling, words } from "./parts.js";
import { AGE_TONE, monthLabel, statusTone } from "./series.js";

type Bucket = { count: number; amountMinor: number };
interface Ageing { currency: string; buckets: Record<"0-30" | "31-60" | "61-90" | "90+", Bucket>; totalMinor: number; count: number; unconverted: number; parties: Array<{ party: string; totalMinor: number; "0-30": number; "31-60": number; "61-90": number; "90+": number }> }
interface Reports {
  currency: string;
  revenue: { months: Array<{ month: string; invoicedMinor: number; vatMinor: number; collectedMinor: number; invoices: number }>; invoicedMinor: number; collectedMinor: number; unconverted: number };
  clients: { clients: Array<{ clientKey: string; clientName: string; invoicedMinor: number; collectedMinor: number; outstandingMinor: number; lifetimePaidMinor: number; invoices: number; lastPaidAt: string | null }> };
  agedDebtors: Ageing;
  agedCreditors: Ageing;
  expenses: { categories: Array<{ category: string; totalMinor: number; vatClaimableMinor: number; count: number }>; totalMinor: number; vatClaimableMinor: number };
  mrr: { mrrMinor: number; arrMinor: number; active: number; newMrrMinor: number; churnedMrrMinor: number; churned: number; churnRate: number };
  mrrTrend?: Array<{ month: string; mrrMinor: number; active: number }>;
}

const BUCKETS = ["0-30", "31-60", "61-90", "90+"] as const;

function AgeingTable({ title, ageing, owedToYou }: { title: string; ageing: Ageing; owedToYou: boolean }) {
  const cur = ageing.currency;
  const late = (b: (typeof BUCKETS)[number]) => (b === "61-90" ? `color-mix(in oklab, ${tone("bad").solid} 70%, ${tone("warn").solid})` : undefined);
  const worst = ageing.buckets["90+"].amountMinor > 0 || ageing.buckets["61-90"].amountMinor > 0 ? "bad" : ageing.buckets["31-60"].amountMinor > 0 ? "warn" : undefined;
  const cell = (minor: number, b: (typeof BUCKETS)[number]) => (minor > 0 && b !== "0-30" ? <span style={{ color: tone(AGE_TONE[b]).fg, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{money(minor, cur)}</span> : money(minor, cur));
  return (
    <Card title={title} icon={owedToYou ? HandCoins : CreditCard} tone={worst} subtitle={`${money(ageing.totalMinor, cur)} across ${ageing.count} item${ageing.count === 1 ? "" : "s"}.`}>
      {ageing.totalMinor > 0 ? (
        <StackedBar title={title} height={12} segments={BUCKETS.map((b) => ({ key: b, label: `${b} days`, value: ageing.buckets[b].amountMinor, tone: AGE_TONE[b], color: late(b) }))} formatValue={(v) => compactMoney(v, cur)} />
      ) : null}
      {ageing.parties.length > 0 ? (
        <DataTable
          columns={[
            { key: "party", header: "Who" },
            ...BUCKETS.map((b) => ({ key: b, header: b, render: (value: unknown) => cell(Number(value), b) })),
            { key: "total", header: "Total", render: (value: unknown) => <strong style={{ fontVariantNumeric: "tabular-nums" }}>{money(Number(value), cur)}</strong> },
          ]}
          rows={ageing.parties.map((p) => ({ id: p.party, party: p.party, "0-30": p["0-30"], "31-60": p["31-60"], "61-90": p["61-90"], "90+": p["90+"], total: p.totalMinor }))}
        />
      ) : <Muted>Nothing owed.</Muted>}
      {ageing.unconverted ? <Muted>{ageing.unconverted} item(s) in another currency have no FX rate yet and are left out.</Muted> : null}
    </Card>
  );
}

export function ReportsTab() {
  const { call, say } = useBilling();
  const [from, setFrom] = useState(`${new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 11, 1)).toISOString().slice(0, 7)}-01`);
  const [to, setTo] = useState(today());
  const [data, setData] = useState<Reports | null>(null);
  const load = () => call<Reports>("billing.reports", { from, to }).then(setData).catch((e: unknown) => say(errorText(e)));
  useEffect(() => {
    void load();
  }, []);
  if (!data) return <Muted>Building reports…</Muted>;
  const cur = data.currency;
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <Row style={{ alignItems: "end" }}>
        <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <SmallButton style={{ height: 36 }} onClick={() => void load()}>Update</SmallButton>
        <Muted>Amounts in {cur}; foreign invoices convert at their own rate or the latest daily rate.</Muted>
      </Row>
      <div style={{ display: "grid", gridTemplateColumns: fluidColumns(150), gap: 10 }}>
        <KpiCard label="Invoiced (excl. VAT)" value={money(data.revenue.invoicedMinor, cur)} icon={Receipt} sparkline={data.revenue.months.map((m) => m.invoicedMinor)} />
        <KpiCard label="Collected" value={<span style={{ color: data.revenue.collectedMinor > 0 ? tone("ok").fg : undefined }}>{money(data.revenue.collectedMinor, cur)}</span>} tone="ok" icon={Banknote} sparkline={data.revenue.months.map((m) => m.collectedMinor)} />
        <KpiCard label="Owed to you" value={money(data.agedDebtors.totalMinor, cur)} icon={HandCoins} tone={data.agedDebtors.buckets["90+"].amountMinor > 0 ? "bad" : undefined} hint={`${data.agedDebtors.count} invoice${data.agedDebtors.count === 1 ? "" : "s"}`} />
        <KpiCard label="You owe suppliers" value={money(data.agedCreditors.totalMinor, cur)} icon={CreditCard} hint={`${data.agedCreditors.count} bill${data.agedCreditors.count === 1 ? "" : "s"}`} />
      </div>
      <Card title="Money per month" icon={ChartColumn} subtitle={`Invoiced (excl. VAT) by send month and collected by payment month, in ${cur}.`}>
        <ColumnChart
          data={data.revenue.months.map((m) => ({ ...monthLabel(m.month), values: { invoiced: m.invoicedMinor, collected: m.collectedMinor } }))}
          series={[{ key: "invoiced", label: "Invoiced", tone: "neutral" }, { key: "collected", label: "Collected", tone: "ok" }]}
          stacked={false}
          height={140}
          title="Money per month"
          formatValue={(v) => compactMoney(v, cur)}
        />
      </Card>
      <Card title="Recurring revenue" icon={RefreshCw} subtitle="From active retainers and repeating invoices.">
        <div style={{ display: "grid", gridTemplateColumns: fluidColumns(140), gap: 10 }}>
          <KpiCard size="sm" label="MRR" value={money(data.mrr.mrrMinor, cur)} />
          <KpiCard size="sm" label="ARR" value={money(data.mrr.arrMinor, cur)} />
          <KpiCard size="sm" label="Active retainers" value={data.mrr.active} />
          <KpiCard size="sm" label="New MRR (30 days)" value={money(data.mrr.newMrrMinor, cur)} tone={data.mrr.newMrrMinor > 0 ? "ok" : undefined} />
          <KpiCard size="sm" label="Churned MRR (30 days)" value={money(data.mrr.churnedMrrMinor, cur)} tone={data.mrr.churnedMrrMinor > 0 ? "bad" : undefined} />
          <KpiCard size="sm" label="Churn (30 days)" value={`${Math.round(data.mrr.churnRate * 1000) / 10}%`} tone={data.mrr.churnRate > 0.05 ? "warn" : undefined} />
        </div>
        {data.mrrTrend && data.mrrTrend.length > 1 ? (
          <TrendChart title="MRR" labels={data.mrrTrend.map((m) => monthLabel(m.month).label)} series={[{ key: "mrr", label: "MRR", values: data.mrrTrend.map((m) => m.mrrMinor) }]} formatValue={(v) => compactMoney(v, cur)} height={120} />
        ) : null}
      </Card>
      <AgeingTable title="Aged debtors (days past due)" ageing={data.agedDebtors} owedToYou />
      <AgeingTable title="Aged creditors (days past due)" ageing={data.agedCreditors} owedToYou={false} />
      <Card title="Client value" icon={Users} subtitle="Sorted by money paid, all time.">
        {data.clients.clients.length === 0 ? <Muted>No invoices yet.</Muted> : (
          <DataTable
            columns={[
              { key: "clientName", header: "Client" },
              { key: "invoiced", header: "Invoiced in period" },
              { key: "collected", header: "Collected in period", render: (value: unknown) => <Money minor={Number(value)} currency={cur} kind={Number(value) > 0 ? "in" : null} /> },
              { key: "owed", header: "Owed now" },
              { key: "lifetime", header: "Paid, all time" },
              { key: "last", header: "Last paid" },
            ]}
            rows={data.clients.clients.map((c) => ({ id: c.clientKey, clientName: c.clientName || c.clientKey, invoiced: money(c.invoicedMinor, cur), collected: c.collectedMinor, owed: money(c.outstandingMinor, cur), lifetime: money(c.lifetimePaidMinor, cur), last: fmtDate(c.lastPaidAt) }))}
          />
        )}
      </Card>
      <Card title="Expenses and bills by category" icon={Coins} subtitle={`${money(data.expenses.totalMinor, cur)} in the period, ${money(data.expenses.vatClaimableMinor, cur)} input VAT to claim.`}>
        {data.expenses.categories.length === 0 ? <Muted>No expenses in this period.</Muted> : (
          <BarList bare title="Spend by category" items={data.expenses.categories.slice(0, 8).map((c) => ({ label: c.category.replace(/_/g, " "), value: c.totalMinor }))} formatValue={(v) => compactMoney(v, cur)} />
        )}
        {data.expenses.categories.length === 0 ? null : (
          <DataTable
            columns={[{ key: "category", header: "Category" }, { key: "total", header: "Total" }, { key: "vat", header: "Input VAT to claim" }, { key: "count", header: "Items" }]}
            rows={data.expenses.categories.map((c) => ({ id: c.category, category: c.category.replace(/_/g, " "), total: money(c.totalMinor, cur), vat: money(c.vatClaimableMinor, cur), count: c.count }))}
          />
        )}
      </Card>
    </div>
  );
}

interface Dunning {
  enabled: boolean;
  stages: Array<{ daysAfterDue: number; subject: string; body: string }>;
  next: Array<{ invoiceId: string; number: string; stage: number; daysOverdue: number }>;
  optOuts: Array<{ kind: string; id: string; reason: string | null }>;
  recent: Array<{ invoiceId: string; number: string; stage: number; status: string; createdAt: string | null; error: string | null }>;
}

export function RemindersTab() {
  const { call, run, say, snapshot } = useBilling();
  const [data, setData] = useState<Dunning | null>(null);
  const load = () => call<Dunning>("billing.dunning", {}).then(setData).catch((e: unknown) => say(errorText(e)));
  useEffect(() => {
    void load();
  }, []);
  if (!data) return <Muted>Loading…</Muted>;
  const nameOf = (kind: string, id: string) => (snapshot.clients ?? []).find((c) => c.kind === kind && c.id === id)?.name ?? id;
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <Card title="Payment reminders" icon={Mail} tone={data.enabled ? "ok" : "neutral"} actions={<span style={{ fontSize: 12, fontWeight: 600, color: data.enabled ? tone("ok").fg : tokens.muted }}>{data.enabled ? "On" : "Off"}</span>}>
        <Muted>{data.enabled
          ? "On. Each morning the latest due stage is emailed once per invoice, from the Mailbox."
          : "Off. The Account Manager asks for each reminder from its weekly Overdue invoices issue, and a person approves every email. To send them by themselves, switch them on in Settings → Plugins → Billing → Payment reminders."} Invoices waiting on a proof-of-payment check get no reminder.</Muted>
        <div style={{ display: "grid", gap: 6 }}>
          {data.stages.map((stage, i) => (
            <div key={i} style={{ padding: "8px 10px", borderRadius: 8, background: tokens.secondary, fontSize: 13 }}>
              <strong>Stage {i + 1}</strong> · {stage.daysAfterDue} day{stage.daysAfterDue === 1 ? "" : "s"} after the due date · “{stage.subject}”
            </div>
          ))}
        </div>
      </Card>
      <Card title={`Due today (${data.next.length})`} icon={Clock} tone={data.next.length ? "warn" : undefined} actions={data.next.length ? <SmallButton variant="primary" onClick={() => void run(async () => { await call("billing.run-dunning", {}); await load(); }, "Reminders queued in the Mailbox")}>Send now</SmallButton> : null}>
        {data.next.length === 0 ? <Muted>No reminders are due.</Muted> : (
          <Timeline dense items={data.next.map((n) => ({ id: n.invoiceId, title: `${n.number} · stage ${n.stage}`, detail: `${n.daysOverdue} days overdue`, tone: n.daysOverdue > 30 ? "bad" : "warn" }))} />
        )}
      </Card>
      <Card title="Clients who get no reminders">
        {data.optOuts.length === 0 ? <Muted>None. Stop reminders for a client from their Billing workspace (Payments tab).</Muted> : data.optOuts.map((o) => (
          <Row key={`${o.kind}:${o.id}`} style={{ justifyContent: "space-between", fontSize: 13 }}>
            <span>{nameOf(o.kind, o.id)}{o.reason ? ` · ${o.reason}` : ""}</span>
            <SmallButton onClick={() => void run(async () => { await call("billing.set-dunning-optout", { client: `${o.kind}:${o.id}`, optOut: false }); await load(); }, "Reminders on for this client")}>Send reminders again</SmallButton>
          </Row>
        ))}
      </Card>
      {data.recent.length > 0 ? (
        <Card title="Sent" icon={Mail}>
          <Timeline dense limit={12} items={data.recent.map((r, i) => ({ id: `${r.invoiceId}:${r.stage}:${i}`, at: r.createdAt, title: `${r.number} · reminder ${r.stage}`, detail: r.error ? `${words(r.status)}: ${r.error}` : words(r.status), tone: statusTone(r.status) === "info" ? "ok" : statusTone(r.status) }))} />
        </Card>
      ) : null}
    </div>
  );
}
