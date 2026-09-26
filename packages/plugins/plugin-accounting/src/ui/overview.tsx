import { useEffect, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import {
  Bot,
  Button,
  Calculator,
  ChartColumn,
  ChartLine,
  ChartPie,
  ColumnChart,
  DonutChart,
  HandCoins,
  Landmark,
  KpiCard,
  Pill,
  ProgressBar,
  ProgressRing,
  Receipt,
  Scale,
  SectionCard,
  Settings,
  StatusDot,
  TrendChart,
  TriangleAlert,
  Wallet,
  errorText,
  fluidColumns,
  tokens,
  tone,
} from "@partnersinbiz/pib-plugin-ui";
import { BookkeeperPanel, type HireView } from "./agent.js";
import { changeText, monthLabel, vatCountdown } from "./series.js";
import { Muted, rand, type Account, type BankAccount } from "./shared.js";
export interface LoadResult {
  book: { companyId: string; currency: string; cutoverDate: string | null; openingJournalId: string | null };
  settings: {
    saved: boolean;
    legalName: string;
    vatNumber: string;
    vatCategory: string;
    yearEndMonth: number;
    agentsMayAcceptCategorisation: boolean;
    jevConfigured: boolean;
    r2Configured: boolean;
  };
  overview: {
    cashMinor: number;
    receivablesMinor: number;
    payablesMinor: number;
    vatDueMinor: number;
    month: string;
    monthRevenueMinor: number;
    monthExpensesMinor: number;
    monthProfitMinor: number;
    bankLines: Record<string, number>;
    rejectedPostings: number;
    pendingApprovals: number;
  };
  roleGaps: string[];
  bankAccounts: BankAccount[];
  accounts: Account[];
  currentVatPeriod: { start: string; end: string } | null;
  hire: HireView | null;
}

/** What `accounting.trends` returns. */
export interface Trends {
  months: Array<{ month: string; incomeMinor: number; expensesMinor: number; profitMinor: number; closingCashMinor: number }>;
  expenses: { from: string; to: string; split: Array<{ label: string; code: string | null; amountMinor: number }> };
  reconciliation: Array<{ bankAccountId: string; reconciled: number; excluded: number; open: number; total: number }>;
  vat: { start: string; end: string; dueDate: string } | null;
}

/** Short rand for chart axes and tooltips: R 12.4k. */
export function randShort(minor: number): string {
  const v = minor / 100;
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}R ${(abs / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
  if (abs >= 1_000) return `${sign}R ${(abs / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${sign}R ${Math.round(abs)}`;
}

function fmtDay(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return `${d.getUTCDate()} ${monthLabel(iso.slice(0, 7)).label} ${d.getUTCFullYear()}`;
}

type Tone = "ok" | "warn" | "bad" | "info" | "neutral";

export function OverviewTab({ data, onMessage, onOpen, refresh, today = new Date().toISOString().slice(0, 10) }: { data: LoadResult; onMessage: (m: string) => void; onOpen: (tab: string) => void; refresh: () => Promise<void>; today?: string }) {
  const loadTrends = usePluginAction("accounting.trends");
  const [trends, setTrends] = useState<Trends | null>(null);
  const [trendError, setTrendError] = useState("");
  useEffect(() => {
    let live = true;
    loadTrends({ months: 12 }).then((t) => { if (live) setTrends(t as Trends); }).catch((e: unknown) => { if (live) setTrendError(errorText(e)); });
    return () => { live = false; };
  }, [data.book.companyId]);

  const o = data.overview;
  const open = (o.bankLines.unreconciled ?? 0) + (o.bankLines.matching ?? 0);
  const months = trends?.months ?? [];
  const prev = months.length > 1 ? months[months.length - 2] : undefined;
  const vat = trends?.vat ?? null;
  const countdown = vat ? vatCountdown(vat, today) : null;
  const bankName = new Map(data.bankAccounts.map((b) => [b.id, b]));

  const todo: Array<{ text: string; tone: Tone; label: string; tab?: string; action?: string }> = [];
  if (o.rejectedPostings > 0) todo.push({ text: `${o.rejectedPostings} posting${o.rejectedPostings === 1 ? " was" : "s were"} rejected. The books are missing ${o.rejectedPostings === 1 ? "it" : "them"} until the cause is fixed.`, tone: "bad", label: "Rejected", tab: "journals", action: "Open Journals" });
  if (open > 0) todo.push({ text: `${open} bank line${open === 1 ? " is" : "s are"} not reconciled yet.`, tone: "warn", label: "Bank", tab: "bank", action: "Open Bank" });
  if (o.pendingApprovals > 0) todo.push({ text: `${o.pendingApprovals} manual journal${o.pendingApprovals === 1 ? " is" : "s are"} waiting for approval (Journals → Drafts).`, tone: "warn", label: "Approve", tab: "journals", action: "Open Journals" });
  if (countdown && countdown.tone !== "info" && countdown.tone !== "ok") todo.push({ text: `VAT201 for ${vat!.start} to ${vat!.end}: ${countdown.text.toLowerCase()}.`, tone: countdown.tone, label: "VAT", tab: "vat", action: "Open VAT" });
  if (!data.book.openingJournalId) todo.push({ text: "No opening balances yet. Import the trial balance at your cut-over date under Cut-over before relying on the balance sheet.", tone: "info", label: "Set-up", tab: "cutover", action: "Open Cut-over" });
  const worst: Tone = todo.some((t) => t.tone === "bad") ? "bad" : todo.some((t) => t.tone === "warn") ? "warn" : todo.length ? "info" : "ok";

  const vatLabel = o.vatDueMinor >= 0 ? "VAT owed to SARS" : "VAT refund due";
  const setupRows: Array<{ label: string; on: boolean; text: string }> = [
    { label: "Legal name", on: Boolean(data.settings.legalName), text: data.settings.legalName || "Not set" },
    { label: "VAT", on: Boolean(data.settings.vatNumber), text: `${data.settings.vatNumber || "Number not set"} · category ${data.settings.vatCategory}` },
    { label: "Year end", on: true, text: `Month ${data.settings.yearEndMonth}` },
    { label: "Jev decisions", on: data.settings.jevConfigured, text: data.settings.jevConfigured ? "On" : "Off (bank rules and matching still work)" },
    { label: "Private file storage", on: data.settings.r2Configured, text: data.settings.r2Configured ? "Set up" : "Not set up (imports up to 1 MB)" },
    { label: "Agents may accept bank suggestions", on: data.settings.agentsMayAcceptCategorisation, text: data.settings.agentsMayAcceptCategorisation ? "Yes (exact invoice matches only)" : "No" },
  ];

  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      <div style={{ display: "grid", gridTemplateColumns: fluidColumns(150), gap: 10 }}>
        <KpiCard
          label="Cash and bank"
          value={rand(o.cashMinor)}
          icon={Landmark}
          tone={o.cashMinor < 0 ? "bad" : undefined}
          delta={prev ? changeText(o.cashMinor, prev.closingCashMinor, randShort) : null}
          sparkline={months.map((m) => m.closingCashMinor)}
          link={{ href: "?tab=bank", onClick: (e) => { e.preventDefault(); onOpen("bank"); } }}
        />
        <KpiCard label="Receivables (AR)" value={rand(o.receivablesMinor)} icon={HandCoins} hint="Owed to you" link={{ href: "?tab=reports", onClick: (e) => { e.preventDefault(); onOpen("reports"); } }} />
        <KpiCard label="Payables (AP)" value={rand(o.payablesMinor)} icon={Receipt} hint="You owe suppliers" />
        <KpiCard
          label={`Profit, ${monthLabel(o.month).title}`}
          value={<span style={{ color: o.monthProfitMinor > 0 ? tone("ok").fg : o.monthProfitMinor < 0 ? tone("bad").fg : undefined }}>{rand(o.monthProfitMinor)}</span>}
          icon={Scale}
          tone={o.monthProfitMinor < 0 ? "bad" : o.monthProfitMinor > 0 ? "ok" : undefined}
          hint={`Income ${randShort(o.monthRevenueMinor)} · costs ${randShort(o.monthExpensesMinor)}`}
          sparkline={months.map((m) => m.profitMinor)}
        />
        <KpiCard
          label={vatLabel}
          value={rand(Math.abs(o.vatDueMinor))}
          icon={Calculator}
          tone={o.vatDueMinor > 0 ? "warn" : undefined}
          hint={data.currentVatPeriod ? `Period ${data.currentVatPeriod.start} to ${data.currentVatPeriod.end}` : "Not VAT-registered"}
          link={{ href: "?tab=vat", onClick: (e) => { e.preventDefault(); onOpen("vat"); } }}
        />
      </div>

      {todo.length ? (
        <SectionCard title="Needs attention" icon={TriangleAlert} tone={worst} strip={worst === "bad"} subtitle="Most urgent first.">
          <div style={{ display: "grid", gap: 6 }}>
            {todo.map((item) => (
              <div key={item.text} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "8px 10px", borderRadius: 9, border: `1px solid ${tokens.border}`, borderLeft: `3px solid ${tone(item.tone).solid}`, background: tokens.bg, minWidth: 0 }}>
                <Pill tone={item.tone} size="sm">{item.label}</Pill>
                <span style={{ flex: "1 1 220px", minWidth: 0, fontSize: 13, lineHeight: 1.45, overflowWrap: "anywhere" }}>{item.text}</span>
                {item.tab ? <Button type="button" variant="secondary" style={{ height: 28, fontSize: 12 }} onClick={() => onOpen(item.tab!)}>{item.action}</Button> : null}
              </div>
            ))}
          </div>
        </SectionCard>
      ) : (
        <SectionCard title="Needs attention" icon={TriangleAlert} tone="ok" subtitle="Nothing is waiting." />
      )}

      {trendError ? <Muted>Charts could not load: {trendError}</Muted> : null}

      <div style={{ display: "grid", gridTemplateColumns: fluidColumns(360), gap: 16, alignItems: "start" }}>
        <SectionCard title="Cash balance" icon={ChartLine} subtitle="Cash and bank at each month end, last 12 months.">
          {trends ? (
            <TrendChart
              title="Cash balance"
              labels={months.map((m) => monthLabel(m.month).label)}
              series={[{ key: "cash", label: "Cash and bank", values: months.map((m) => m.closingCashMinor), tone: months.some((m) => m.closingCashMinor < 0) && o.cashMinor < 0 ? "bad" : undefined }]}
              formatValue={randShort}
              height={130}
            />
          ) : <Muted>Loading…</Muted>}
        </SectionCard>
        <SectionCard title="Income and expenses" icon={ChartColumn} subtitle="Per month from the journals, cost of sales included.">
          {trends ? (
            <ColumnChart
              title="Income and expenses"
              data={months.map((m) => ({ ...monthLabel(m.month), values: { income: Math.max(0, m.incomeMinor), expenses: Math.max(0, m.expensesMinor) } }))}
              series={[{ key: "income", label: "Income", tone: "ok" }, { key: "expenses", label: "Expenses", tone: "neutral" }]}
              stacked={false}
              height={130}
              axis="all"
              formatValue={randShort}
              emptyText="No income or expenses in the last 12 months."
            />
          ) : <Muted>Loading…</Muted>}
        </SectionCard>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: fluidColumns(360), gap: 16, alignItems: "start" }}>
        <SectionCard title="Expenses by account" icon={ChartPie} subtitle={trends ? `Financial year to date, from ${trends.expenses.from}.` : "Financial year to date."}>
          {!trends ? <Muted>Loading…</Muted> : trends.expenses.split.length ? (
            <DonutChart
              title="Expenses by account"
              size={124}
              centerValue={randShort(trends.expenses.split.reduce((s, x) => s + x.amountMinor, 0))}
              centerLabel="spent"
              segments={trends.expenses.split.map((x) => ({ key: x.code ?? "other", label: x.label, value: x.amountMinor, ...(x.code ? {} : { tone: "neutral" as const }) }))}
              formatValue={randShort}
            />
          ) : <Muted>No expenses this financial year.</Muted>}
        </SectionCard>

        <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
        <SectionCard title="VAT201" icon={Calculator} tone={countdown?.tone === "bad" ? "bad" : countdown?.tone === "warn" ? "warn" : undefined} strip={countdown?.tone === "bad"} subtitle={vat ? `Period ${vat.start} to ${vat.end}` : "Not VAT-registered"}>
          {vat && countdown ? (
            <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", minWidth: 0 }}>
              <ProgressRing value={countdown.elapsed} size={88} tone={countdown.tone} label={`VAT201 due ${fmtDay(vat.dueDate)}, ${countdown.text.toLowerCase()}`}>
                <div style={{ display: "grid", lineHeight: 1.1 }}>
                  <strong style={{ fontSize: 19 }}>{Math.abs(countdown.daysLeft)}</strong>
                  <span style={{ fontSize: 10.5, color: tokens.muted }}>{countdown.daysLeft < 0 ? "days late" : "days left"}</span>
                </div>
              </ProgressRing>
              <div style={{ display: "grid", gap: 4, flex: "1 1 160px", minWidth: 0 }}>
                <span style={{ fontSize: 12, color: tokens.muted }}>{vatLabel}</span>
                <strong style={{ fontSize: 20, fontVariantNumeric: "tabular-nums", color: o.vatDueMinor > 0 ? tone("warn").fg : tokens.fg }}>{rand(Math.abs(o.vatDueMinor))}</strong>
                <span style={{ fontSize: 12.5, color: tone(countdown.tone).fg, fontWeight: 600 }}>{countdown.text} · {fmtDay(vat.dueDate)}</span>
                <span style={{ fontSize: 11.5, color: tokens.muted }}>eFiling: last business day of the month after the period.</span>
              </div>
            </div>
          ) : <Muted>{trends ? "Choose a VAT category in the Accounting settings to track VAT201 returns." : "Loading…"}</Muted>}
        </SectionCard>

        <SectionCard title="Bank reconciliation" icon={Wallet} tone={open ? "warn" : "ok"} subtitle="Lines reconciled or excluded, per bank account.">
          {!trends ? <Muted>Loading…</Muted> : trends.reconciliation.length ? (
            <div style={{ display: "grid", gap: 12 }}>
              {trends.reconciliation.map((r) => {
                const b = bankName.get(r.bankAccountId);
                const done = r.reconciled + r.excluded;
                return (
                  <ProgressBar
                    key={r.bankAccountId}
                    done={done}
                    total={r.total}
                    label={b ? `${b.name}${b.numberLast4 ? ` ••${b.numberLast4}` : ""}` : "Bank account"}
                    valueText={r.open ? `${done}/${r.total} · ${r.open} open` : `${done}/${r.total}`}
                    tone={r.open ? "warn" : "ok"}
                  />
                );
              })}
            </div>
          ) : <Muted>No bank statements imported yet. Import one under Bank.</Muted>}
        </SectionCard>
        </div>
      </div>

      <SectionCard title="Bookkeeper agent" icon={Bot}>
        <BookkeeperPanel hire={data.hire} refresh={refresh} onMessage={onMessage} />
      </SectionCard>
      <SectionCard title="Set-up" icon={Settings}>
        <div style={{ display: "grid", gap: 8 }}>
          {setupRows.map((row) => (
            <div key={row.label} style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 13, flexWrap: "wrap", minWidth: 0 }}>
              <StatusDot tone={row.on ? "ok" : "neutral"} label={row.on ? "On" : "Off"} />
              <span style={{ fontWeight: 600 }}>{row.label}</span>
              <span style={{ color: tokens.muted, minWidth: 0, overflowWrap: "anywhere" }}>{row.text}</span>
            </div>
          ))}
        </div>
      </SectionCard>
    </div>
  );
}
