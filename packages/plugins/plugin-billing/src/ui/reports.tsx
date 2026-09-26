import { useEffect, useState } from "react";
import { DataTable, MetricCard } from "@paperclipai/plugin-sdk/ui";
import { BarChart, Field, Input, StatRow, errorText, tokens } from "@partnersinbiz/pib-plugin-ui";
import { Card, Muted, Row, SmallButton, Status, fmtDate, money, today, useBilling } from "./parts.js";

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
}

const BUCKETS = ["0-30", "31-60", "61-90", "90+"] as const;

function AgeingTable({ title, ageing }: { title: string; ageing: Ageing }) {
  const cur = ageing.currency;
  return (
    <Card title={title}>
      <StatRow>
        {BUCKETS.map((b) => <MetricCard key={b} label={`${b} days`} value={money(ageing.buckets[b].amountMinor, cur)} />)}
      </StatRow>
      {ageing.parties.length > 0 ? (
        <DataTable
          columns={[
            { key: "party", header: "Who" },
            ...BUCKETS.map((b) => ({ key: b, header: b })),
            { key: "total", header: "Total" },
          ]}
          rows={ageing.parties.map((p) => ({ id: p.party, party: p.party, "0-30": money(p["0-30"], cur), "31-60": money(p["31-60"], cur), "61-90": money(p["61-90"], cur), "90+": money(p["90+"], cur), total: money(p.totalMinor, cur) }))}
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
      <StatRow>
        <MetricCard label="Invoiced (excl. VAT)" value={money(data.revenue.invoicedMinor, cur)} />
        <MetricCard label="Collected" value={money(data.revenue.collectedMinor, cur)} />
        <MetricCard label="Owed to you" value={money(data.agedDebtors.totalMinor, cur)} />
        <MetricCard label="You owe suppliers" value={money(data.agedCreditors.totalMinor, cur)} />
      </StatRow>
      <Card title="Recurring revenue">
        <StatRow>
          <MetricCard label="MRR" value={money(data.mrr.mrrMinor, cur)} />
          <MetricCard label="ARR" value={money(data.mrr.arrMinor, cur)} />
          <MetricCard label="Active retainers" value={data.mrr.active} />
          <MetricCard label="New MRR (30 days)" value={money(data.mrr.newMrrMinor, cur)} />
          <MetricCard label="Churned MRR (30 days)" value={money(data.mrr.churnedMrrMinor, cur)} />
          <MetricCard label="Churn (30 days)" value={`${Math.round(data.mrr.churnRate * 1000) / 10}%`} />
        </StatRow>
      </Card>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14 }}>
        <BarChart title={`Invoiced per month (${cur}, excl. VAT)`} items={data.revenue.months.map((m) => ({ label: m.month, value: Math.round(m.invoicedMinor / 100) }))} />
        <BarChart title={`Collected per month (${cur})`} items={data.revenue.months.map((m) => ({ label: m.month, value: Math.round(m.collectedMinor / 100) }))} />
      </div>
      <AgeingTable title="Aged debtors (days past due)" ageing={data.agedDebtors} />
      <AgeingTable title="Aged creditors (days past due)" ageing={data.agedCreditors} />
      <Card title="Client value">
        {data.clients.clients.length === 0 ? <Muted>No invoices yet.</Muted> : (
          <DataTable
            columns={[
              { key: "clientName", header: "Client" },
              { key: "invoiced", header: "Invoiced in period" },
              { key: "collected", header: "Collected in period" },
              { key: "owed", header: "Owed now" },
              { key: "lifetime", header: "Paid, all time" },
              { key: "last", header: "Last paid" },
            ]}
            rows={data.clients.clients.map((c) => ({ id: c.clientKey, clientName: c.clientName || c.clientKey, invoiced: money(c.invoicedMinor, cur), collected: money(c.collectedMinor, cur), owed: money(c.outstandingMinor, cur), lifetime: money(c.lifetimePaidMinor, cur), last: fmtDate(c.lastPaidAt) }))}
          />
        )}
      </Card>
      <Card title="Expenses and bills by category">
        {data.expenses.categories.length === 0 ? <Muted>No expenses in this period.</Muted> : (
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
      <Card title="Payment reminders">
        <Muted>{data.enabled ? "On. Each morning the latest due stage is emailed once per invoice, from the Mailbox." : "Off. Switch them on in Settings → Plugins → Billing → Payment reminders."} Invoices waiting on a proof-of-payment check get no reminder.</Muted>
        <div style={{ display: "grid", gap: 6 }}>
          {data.stages.map((stage, i) => (
            <div key={i} style={{ padding: "8px 10px", borderRadius: 8, background: tokens.secondary, fontSize: 13 }}>
              <strong>Stage {i + 1}</strong> · {stage.daysAfterDue} day{stage.daysAfterDue === 1 ? "" : "s"} after the due date · “{stage.subject}”
            </div>
          ))}
        </div>
      </Card>
      <Card title={`Due today (${data.next.length})`} actions={data.next.length ? <SmallButton variant="primary" onClick={() => void run(async () => { await call("billing.run-dunning", {}); await load(); }, "Reminders queued in the Mailbox")}>Send now</SmallButton> : null}>
        {data.next.length === 0 ? <Muted>No reminders are due.</Muted> : data.next.map((n) => <Muted key={n.invoiceId}>{n.number} · stage {n.stage} · {n.daysOverdue} days overdue</Muted>)}
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
        <Card title="Sent">
          {data.recent.map((r, i) => (
            <Row key={i} style={{ justifyContent: "space-between", fontSize: 13 }}>
              <span>{r.number} · stage {r.stage} · {fmtDate(r.createdAt)}{r.error ? ` · ${r.error}` : ""}</span>
              <Status status={r.status} />
            </Row>
          ))}
        </Card>
      ) : null}
    </div>
  );
}
