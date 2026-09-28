/**
 * Overview: what needs a person first ("To do"), then the numbers, the next
 * pay run and (once a run is locked) the EMP201 and the cost charts.
 */
import { useEffect, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import {
  Banknote,
  Button,
  CalendarCheck,
  ChartColumn,
  ChartPie,
  ColumnChart,
  DonutChart,
  KpiCard,
  ProgressRing,
  Receipt,
  SectionCard,
  Stamp,
  Sun,
  TriangleAlert,
  Users,
  Wallet,
  fluidColumns,
  formatDate,
  formatMonth,
  formatMoneyCompact,
  formatShortDate,
  tokens,
  tone,
} from "@partnersinbiz/pib-plugin-ui";
import { costPerRun, costSplit, daysUntil, emp201Month, periodText, plural, todoSteps } from "./series.js";
import { Muted, rand, RunStatus, small } from "./shared.js";
import type { Emp201FilingView, Emp201View, Snapshot, TabId } from "./types.js";

export function OverviewTab({ s, openRun, go }: { s: Snapshot; openRun: (id: string) => void; go: (tab: TabId) => void }) {
  const last = s.lastLocked;
  const next = s.openRuns[0] ?? null;
  const series = costPerRun(s.runs, 12);
  const prevRun = series.length > 1 ? series[series.length - 2] : undefined;
  const lastCost = series.length ? series[series.length - 1]!.employerCostMinor : null;
  const costDelta = lastCost != null && prevRun && prevRun.employerCostMinor ? Math.round(((lastCost - prevRun.employerCostMinor) / prevRun.employerCostMinor) * 100) : null;
  const active = s.employees.filter((e) => e.status === "active").length;
  const left = s.employees.length - active;
  const steps = todoSteps(s);
  const worst = steps.some((x) => x.tone === "bad") ? "bad" : steps.some((x) => x.tone === "warn") ? "warn" : "info";
  const split = last ? costSplit(last.totals) : [];

  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      {steps.length ? (
        <SectionCard title="To do" icon={TriangleAlert} tone={worst} strip={worst === "bad"}>
          <div style={{ display: "grid", gap: 6 }}>
            {steps.map((step) => (
              <div key={step.key} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "8px 10px", borderRadius: 9, border: `1px solid ${tokens.border}`, borderLeft: `3px solid ${tone(step.tone).solid}`, background: tokens.bg, minWidth: 0 }}>
                <span style={{ flex: "1 1 220px", minWidth: 0, fontSize: 13, lineHeight: 1.45, overflowWrap: "anywhere" }}>{step.text}</span>
                {step.action ? (
                  <Button type="button" variant="secondary" style={small} onClick={() => (step.action!.runId ? openRun(step.action!.runId) : step.action!.tab ? go(step.action!.tab) : undefined)}>{step.action.label}</Button>
                ) : null}
              </div>
            ))}
          </div>
        </SectionCard>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: fluidColumns(150), gap: 10 }}>
        <KpiCard
          label="Headcount"
          value={active}
          icon={Users}
          hint={left > 0 ? `${plural(left, "person has", "people have")} left` : "Employed now"}
          tone={s.counts.withoutTerms ? "warn" : undefined}
          link={{ href: "?tab=employees", onClick: (e) => { e.preventDefault(); go("employees"); } }}
        />
        <KpiCard
          label="Last run cost to company"
          value={last ? rand(last.totals.employerCostMinor) : "–"}
          icon={Wallet}
          delta={costDelta != null ? `${costDelta > 0 ? "+" : costDelta < 0 ? "−" : ""}${Math.abs(costDelta)}% vs the run before` : null}
          invert
          sparkline={series.map((r) => r.employerCostMinor)}
          hint={last ? last.number : "No pay run locked yet"}
        />
        <KpiCard label="Last run net pay" value={last ? rand(last.totals.netPayMinor) : "–"} icon={Banknote} hint={last ? `Paid ${formatShortDate(last.payDate)}` : undefined} />
        <KpiCard label="Monthly basic pay" value={rand(s.estimatedMonthlyBasicMinor)} icon={Receipt} hint="Estimate from current pay terms" />
        <KpiCard
          label="Leave to decide"
          value={s.counts.pendingLeave}
          icon={Sun}
          tone={s.counts.pendingLeave ? "warn" : undefined}
          hint={s.counts.pendingLeave ? "Waiting for a decision" : "Nothing waiting"}
          link={{ href: "?tab=leave", onClick: (e) => { e.preventDefault(); go("leave"); } }}
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: fluidColumns(320), gap: 16, alignItems: "start" }}>
        <SectionCard title="Next pay run" icon={CalendarCheck} tone={next ? (next.status === "pending_approval" ? "warn" : "info") : undefined}>
          {next ? (
            <div style={{ display: "grid", gap: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <strong style={{ fontSize: 15 }}>{next.number}</strong>
                <RunStatus status={next.status} />
              </div>
              <span style={{ fontSize: 13, color: tokens.muted }}>
                {periodText(next.periodStart, next.periodEnd)} · paid {formatDate(next.payDate)}{next.totals.employeeCount ? ` · ${plural(next.totals.employeeCount, "person", "people")}` : ""}
              </span>
              {next.totals.employerCostMinor ? <span style={{ fontSize: 13 }}>Cost to company <strong style={{ fontVariantNumeric: "tabular-nums" }}>{rand(next.totals.employerCostMinor)}</strong> · net pay {rand(next.totals.netPayMinor)}</span> : null}
              <div><Button type="button" onClick={() => openRun(next.id)}>Open</Button></div>
            </div>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              <Muted>{active ? "No pay run is open. Start the next one on the Pay runs tab." : "Add your employees first, then start a pay run."}</Muted>
              <div><Button type="button" variant="secondary" style={small} onClick={() => go(active ? "runs" : "employees")}>{active ? "Open pay runs" : "Open employees"}</Button></div>
            </div>
          )}
        </SectionCard>
        {/* The EMP201 only means something once a pay run is locked. */}
        {last ? <Emp201Card s={s} go={go} /> : null}
      </div>

      {series.length ? (
        <div style={{ display: "grid", gridTemplateColumns: fluidColumns(360), gap: 16, alignItems: "start" }}>
          <SectionCard title="Payroll cost per run" icon={ChartColumn} subtitle="Locked pay runs, all staff together: take-home pay, tax, deductions and employer costs.">
            <ColumnChart
              title="Payroll cost per run"
              data={series.map((r) => ({ label: r.label, title: r.title, values: r.values }))}
              series={[
                { key: "net", label: "Net pay", tone: "ok" },
                { key: "tax", label: "Income tax (PAYE) and UIF", tone: "info" },
                { key: "deductions", label: "Other deductions", tone: "neutral" },
                { key: "employer", label: "Employer costs", tone: "accent" },
              ]}
              height={130}
              axis="all"
              formatValue={(v) => formatMoneyCompact(v)}
              emptyText="No locked pay runs yet."
            />
          </SectionCard>
          {last && split.length ? (
            <SectionCard title="Where the money goes" icon={ChartPie} subtitle={`${last.number}, cost to company.`}>
              <DonutChart
                title="Cost split of the last run"
                size={120}
                centerValue={formatMoneyCompact(last.totals.employerCostMinor)}
                centerLabel="cost"
                segments={split.map((x) => ({ ...x, ...(x.key === "net" ? { tone: "ok" as const } : {}) }))}
                formatValue={(v) => formatMoneyCompact(v)}
              />
            </SectionCard>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The EMP201 for the month due next: the monthly PAYE, UIF and SDL declaration to SARS. */
function Emp201Card({ s, go }: { s: Snapshot; go: (tab: TabId) => void }) {
  const loadEmp201 = usePluginAction("payroll.emp201");
  const [e201, setE201] = useState<Emp201View | null>(null);
  const [filing, setFiling] = useState<Emp201FilingView | null>(null);
  const [failed, setFailed] = useState(false);
  const month = emp201Month(s.today);
  useEffect(() => {
    let live = true;
    setFailed(false);
    loadEmp201({ month })
      .then((r) => {
        if (!live) return;
        setE201((r as { emp201: Emp201View }).emp201);
        setFiling((r as { filing?: Emp201FilingView | null }).filing ?? null);
      })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [month]);

  const days = e201 ? daysUntil(s.today, e201.dueDate) : null;
  // Filed and paid: nothing is due any more.
  const ringTone = !filing && e201 && e201.totalPayableMinor > 0 && days != null ? (days < 0 ? "neutral" : days <= 7 ? "warn" : "info") : "neutral";
  const monthStart = `${month}-01`;
  const elapsed = e201 ? Math.min(1, Math.max(0, daysUntil(monthStart, s.today) / Math.max(1, daysUntil(monthStart, e201.dueDate)))) : 0;

  return (
    <SectionCard
      title={`EMP201 for ${formatMonth(month)}`}
      icon={Stamp}
      tone={ringTone === "warn" ? "warn" : undefined}
      subtitle="Your monthly declaration to SARS of PAYE (income tax), UIF (unemployment insurance) and SDL (skills development levy) from locked pay runs. You file and pay it on eFiling."
      actions={<Button type="button" variant="secondary" style={small} onClick={() => go("statutory")}>Details</Button>}
    >
      {failed ? <Muted>Couldn't load the EMP201 figures right now.</Muted> : !e201 ? <Muted>Loading…</Muted> : !e201.runs.length ? (
        <Muted>No pay run is locked for {formatMonth(month)} yet. Its EMP201 is due by {formatDate(e201.dueDate)}.</Muted>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", minWidth: 0 }}>
          <ProgressRing value={elapsed} size={84} tone={ringTone === "neutral" ? undefined : ringTone} label={`EMP201 for ${formatMonth(month)} due ${formatDate(e201.dueDate)}`}>
            <div style={{ display: "grid", lineHeight: 1.1 }}>
              <strong style={{ fontSize: 18 }}>{days != null ? Math.abs(days) : "–"}</strong>
              <span style={{ fontSize: 10.5, color: tokens.muted }}>{days != null && days < 0 ? "days ago" : "days left"}</span>
            </div>
          </ProgressRing>
          <div style={{ display: "grid", gap: 4, flex: "1 1 150px", minWidth: 0 }}>
            <span style={{ fontSize: 12, color: tokens.muted }}>To pay SARS</span>
            <strong style={{ fontSize: 20, fontVariantNumeric: "tabular-nums", color: e201.totalPayableMinor > 0 ? tone("warn").fg : tokens.fg }}>{rand(e201.totalPayableMinor)}</strong>
            {filing ? (
              <span style={{ fontSize: 12.5, fontWeight: 600, color: tone("ok").fg }}>Filed {formatDate(filing.filedOn)}</span>
            ) : (
              <span style={{ fontSize: 12.5, fontWeight: 600, color: ringTone === "neutral" ? tokens.muted : tone(ringTone).fg }}>
                Due {formatDate(e201.dueDate)}{days != null && days >= 0 ? ` · in ${plural(days, "day", "days")}` : ""}
              </span>
            )}
            <span style={{ fontSize: 11.5, color: tokens.muted }}>From {e201.runs.join(", ")}</span>
          </div>
        </div>
      )}
    </SectionCard>
  );
}
