import { useEffect, useState, type MouseEvent } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import {
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
  formatDate,
  formatMoney,
  formatMoneyCompact,
  formatMonth,
  formatShortDate,
} from "@partnersinbiz/pib-plugin-ui";
import { BookkeeperBox, type HireView } from "./agent.js";
import { periodLabel } from "../domain/dates.js";
import { changeText, monthLabel, monthName, vatCategoryText, vatCountdown } from "./series.js";
import { Muted, type Account, type BankAccount } from "./shared.js";
export interface LoadResult {
  book: { companyId: string; currency: string; cutoverDate: string | null; openingJournalId: string | null; cutoverSkippedAt?: string | null };
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
    /** Every figure above is as at this date (today); nothing dated later counts. */
    asOf?: string;
    /** How many journals the book has (0 before anything was posted). */
    journalCount?: number;
    /** Journals and bank lines dated after today: left out of every figure and flagged. */
    future?: { journals: number; bankLines: number; items: Array<{ kind: "bank_line" | "journal"; id: string; date: string; label: string; amountMinor: number }> };
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

/** Short rand for chart axes and tooltips: `R 12.4k` (the shared compact format). */
export function randShort(minor: number): string {
  return formatMoneyCompact(minor, "ZAR");
}

/** "1–27 Sep" (or "1 Oct" on the first): what a month-to-date figure covers. */
function monthToDate(asOf: string): string {
  return Number(asOf.slice(8, 10)) <= 1 ? formatShortDate(asOf) : `1–${formatShortDate(asOf)}`;
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
  // Every figure on this page is as at this day: a journal or bank line dated later counts in none of them.
  const asOf = o.asOf ?? today;
  const asAt = `as at ${formatShortDate(asOf)}`;
  const future = o.future ?? { journals: 0, bankLines: 0, items: [] };
  const open = (o.bankLines.unreconciled ?? 0) + (o.bankLines.matching ?? 0);
  const months = trends?.months ?? [];
  const prev = months.length > 1 ? months[months.length - 2] : undefined;
  const vat = trends?.vat ?? null;
  const countdown = vat ? vatCountdown(vat, today) : null;
  const bankName = new Map(data.bankAccounts.map((b) => [b.id, b]));
  const link = (tab: string) => ({ href: `?tab=${tab}`, onClick: (e: MouseEvent<HTMLAnchorElement>) => { e.preventDefault(); onOpen(tab); } });

  const todo: Array<{ text: string; tone: Tone; label: string; tab?: string; action?: string }> = [];
  if (o.rejectedPostings > 0) todo.push({ text: `${o.rejectedPostings} posting${o.rejectedPostings === 1 ? " was" : "s were"} rejected. The books are missing ${o.rejectedPostings === 1 ? "it" : "them"} until the cause is fixed.`, tone: "bad", label: "Rejected", tab: "rejected", action: "Fix postings" });
  if (future.journals + future.bankLines > 0) {
    const what = [future.bankLines ? `${future.bankLines} bank line${future.bankLines === 1 ? "" : "s"}` : "", future.journals ? `${future.journals} journal${future.journals === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
    const first = future.items[0]?.date;
    todo.push({ text: `${what} dated after today${first ? ` (first ${formatShortDate(first)})` : ""}: ${future.journals + future.bankLines === 1 ? "it counts" : "they count"} in no figure here until then. Check the date on the statement.`, tone: "warn", label: "Date", tab: "bank", action: "Check dates" });
  }
  if (open > 0) todo.push({ text: `${open} bank line${open === 1 ? " is" : "s are"} not reconciled yet.`, tone: "warn", label: "Bank", tab: "bank", action: "Open Bank" });
  if (o.pendingApprovals > 0) todo.push({ text: `${o.pendingApprovals} manual journal${o.pendingApprovals === 1 ? " is" : "s are"} waiting for approval.`, tone: "warn", label: "Approve", tab: "drafts", action: "Open drafts" });
  if (countdown && countdown.tone !== "info" && countdown.tone !== "ok") todo.push({ text: `VAT return (VAT201) for ${periodLabel(vat!.start, vat!.end)}: ${countdown.text.toLowerCase()}.`, tone: countdown.tone, label: "VAT", tab: "vat", action: "Open VAT" });
  if (!data.book.openingJournalId && !data.book.cutoverSkippedAt) todo.push({ text: "No opening balances yet. Post the balances from your previous books under Cut-over, or say you started on these books.", tone: "info", label: "Set-up", tab: "cutover", action: "Open Cut-over" });
  const worst: Tone = todo.some((t) => t.tone === "bad") ? "bad" : todo.some((t) => t.tone === "warn") ? "warn" : todo.length ? "info" : "ok";

  const vatLabel = o.vatDueMinor >= 0 ? "VAT owed to SARS" : "VAT refund due";
  const yearEnd = monthName(data.settings.yearEndMonth) || "February";
  const setupRows: Array<{ label: string; on: boolean; text: string }> = [
    { label: "Legal name", on: Boolean(data.settings.legalName), text: data.settings.legalName || "Not set" },
    { label: "VAT", on: Boolean(data.settings.vatNumber) || data.settings.vatCategory === "none", text: data.settings.vatCategory === "none" ? "Not VAT registered" : `${data.settings.vatNumber || "VAT number not set"} · returns ${vatCategoryText(data.settings.vatCategory, data.settings.yearEndMonth).toLowerCase()}` },
    { label: "Financial year ends", on: true, text: `End of ${yearEnd}` },
    { label: "Smart matching (optional)", on: data.settings.jevConfigured, text: data.settings.jevConfigured ? "On: suggests categories for bank lines" : "Off (bank rules and matching still work)" },
    { label: "Private file storage", on: data.settings.r2Configured, text: data.settings.r2Configured ? "Set up" : "Not set up (statement files up to 1 MB)" },
    { label: "The Bookkeeper may accept bank suggestions", on: data.settings.agentsMayAcceptCategorisation, text: data.settings.agentsMayAcceptCategorisation ? "Yes (invoice matches only when exact)" : "No, a person accepts each one" },
  ];

  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      <div style={{ display: "grid", gridTemplateColumns: fluidColumns(150), gap: 10 }}>
        <KpiCard
          label="Cash and bank"
          value={formatMoney(o.cashMinor)}
          icon={Landmark}
          tone={o.cashMinor < 0 ? "bad" : undefined}
          delta={prev ? changeText(o.cashMinor, prev.closingCashMinor, randShort) : null}
          hint={asAt}
          sparkline={months.map((m) => m.closingCashMinor)}
          link={link("bank")}
        />
        <KpiCard label="Owed to you" value={formatMoney(o.receivablesMinor)} icon={HandCoins} hint={`Receivables, ${asAt}`} link={link("reports")} />
        <KpiCard label="You owe suppliers" value={formatMoney(o.payablesMinor)} icon={Receipt} hint={`Payables, ${asAt}`} />
        <KpiCard
          label={`Profit, ${formatMonth(o.month)}`}
          value={<span style={{ color: o.monthProfitMinor > 0 ? tone("ok").fg : o.monthProfitMinor < 0 ? tone("bad").fg : undefined }}>{formatMoney(o.monthProfitMinor)}</span>}
          icon={Scale}
          tone={o.monthProfitMinor < 0 ? "bad" : o.monthProfitMinor > 0 ? "ok" : undefined}
          hint={`${monthToDate(asOf)} · income ${randShort(o.monthRevenueMinor)} · costs ${randShort(o.monthExpensesMinor)}`}
          sparkline={months.map((m) => m.profitMinor)}
        />
        <KpiCard
          label={vatLabel}
          value={formatMoney(Math.abs(o.vatDueMinor))}
          icon={Calculator}
          tone={o.vatDueMinor > 0 ? "warn" : undefined}
          hint={data.currentVatPeriod ? `${periodLabel(data.currentVatPeriod.start, data.currentVatPeriod.end)} period, ${asAt}` : "Not VAT registered"}
          link={link("vat")}
        />
      </div>

      {todo.length ? (
        <SectionCard title="Needs attention" icon={TriangleAlert} tone={worst} strip={worst === "bad"} subtitle="Most urgent first.">
          <div style={{ display: "grid", gap: 6 }}>
            {todo.map((item) => (
              <div key={item.text} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "8px 10px", borderRadius: 9, border: `1px solid ${tokens.border}`, borderLeft: `3px solid ${tone(item.tone).solid}`, background: tokens.bg, minWidth: 0 }}>
                <Pill tone={item.tone} size="sm">{item.label}</Pill>
                <span style={{ flex: "1 1 220px", minWidth: 0, fontSize: 13, lineHeight: 1.45, overflowWrap: "anywhere" }}>{item.text}</span>
                {item.tab ? <Button type="button" variant="secondary" style={{ height: 32, fontSize: 12 }} onClick={() => onOpen(item.tab!)}>{item.action}</Button> : null}
              </div>
            ))}
          </div>
        </SectionCard>
      ) : (
        <SectionCard title="Needs attention" icon={TriangleAlert} tone="ok" subtitle="Nothing is waiting." />
      )}

      {trendError ? <Muted>Charts could not load: {trendError}</Muted> : null}

      <div style={{ display: "grid", gridTemplateColumns: fluidColumns(360), gap: 16, alignItems: "start" }}>
        <SectionCard title="Cash balance" icon={ChartLine} subtitle={`Cash and bank at each month end, last 12 months; this month ${asAt}.`}>
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
        <SectionCard title="Income and expenses" icon={ChartColumn} subtitle={`Per month from the journals, cost of sales included; this month ${monthToDate(asOf)}.`}>
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
        <SectionCard title="Expenses by account" icon={ChartPie} subtitle={trends ? `Financial year to date, from ${formatDate(trends.expenses.from)}.` : "Financial year to date."}>
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
        <SectionCard title="VAT return (VAT201)" icon={Calculator} tone={countdown?.tone === "bad" ? "bad" : countdown?.tone === "warn" ? "warn" : undefined} strip={countdown?.tone === "bad"} subtitle={vat ? `${periodLabel(vat.start, vat.end)} period` : "Not VAT registered"}>
          {vat && countdown ? (
            <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", minWidth: 0 }}>
              <ProgressRing value={countdown.elapsed} size={88} tone={countdown.tone} label={`VAT return due ${formatDate(vat.dueDate)}, ${countdown.text.toLowerCase()}`}>
                <div style={{ display: "grid", lineHeight: 1.1 }}>
                  <strong style={{ fontSize: 19 }}>{Math.abs(countdown.daysLeft)}</strong>
                  <span style={{ fontSize: 10.5, color: tokens.muted }}>{countdown.daysLeft < 0 ? "days late" : "days left"}</span>
                </div>
              </ProgressRing>
              <div style={{ display: "grid", gap: 4, flex: "1 1 160px", minWidth: 0 }}>
                <span style={{ fontSize: 12, color: tokens.muted }}>{vatLabel}, {asAt}</span>
                <strong style={{ fontSize: 20, fontVariantNumeric: "tabular-nums", color: o.vatDueMinor > 0 ? tone("warn").fg : tokens.fg, whiteSpace: "nowrap" }}>{formatMoney(Math.abs(o.vatDueMinor))}</strong>
                <span style={{ fontSize: 12.5, color: tone(countdown.tone).fg, fontWeight: 600 }}>{countdown.text} · {formatDate(vat.dueDate)}</span>
                <span style={{ fontSize: 11.5, color: tokens.muted }}>File on SARS eFiling by the last business day of the month after the period.</span>
              </div>
            </div>
          ) : <Muted>{trends ? "Choose your VAT category in the Accounting settings to track VAT returns." : "Loading…"}</Muted>}
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
                    valueText={r.open ? `${done} of ${r.total} · ${r.open} open` : `${done} of ${r.total}`}
                    tone={r.open ? "warn" : "ok"}
                  />
                );
              })}
            </div>
          ) : <Muted>No bank statements imported yet. Import one under Bank.</Muted>}
        </SectionCard>
        </div>
      </div>

      {/* Only when something is wrong with the Bookkeeper; it is staffed in Setup → Team. */}
      <BookkeeperBox hire={data.hire} refresh={refresh} onMessage={onMessage} />
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
