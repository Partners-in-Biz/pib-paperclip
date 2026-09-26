/**
 * Presentational pieces of the Cockpit (no host hooks, so they render in
 * tests). Layouts wrap and scroll instead of using fixed widths, so the page
 * works on a 375px phone. Colours come from the pib-plugin-ui palette
 * (`tone()`, module accents), which matches the host's status colours.
 */
import type { AnchorHTMLAttributes, CSSProperties, ReactNode } from "react";
import {
  Activity,
  BarChart,
  Banknote,
  Bot,
  ChartColumn,
  Circle,
  CircleQuestionMark,
  Eye,
  Funnel,
  Gauge,
  HeartPulse,
  Inbox,
  KeyRound,
  KpiCard,
  Megaphone,
  PackageCheck,
  Pill,
  ProgressBar,
  Scale,
  SectionCard,
  Server,
  StackedBar,
  StatusDot,
  Sun,
  Timeline,
  Users,
  Wallet,
  moduleAccent,
  moduleKeyOf,
  tokens,
  tone,
  useIsNarrow,
  type LucideIcon,
  type TimelineItem,
  type ToneInput,
} from "@partnersinbiz/pib-plugin-ui";
import {
  formatCents,
  hoursAgo,
  HEALTH_LABEL,
  KIND_LABEL,
  KPI_GROUP_TITLES,
  type ActivityGroup,
  type AgentRow,
  type HealthGroup,
  type HealthStatus,
  type KpiEntry,
  type RunLite,
  type Tone,
  type WaitingEntry,
} from "../merge.js";
import type { BackupInfo } from "../view.js";
import { healthCounts, runColumns, runsPerDay } from "./series.js";

export type LinkPropsFor = (href: string) => AnchorHTMLAttributes<HTMLAnchorElement>;

/** Solid colour per Cockpit tone (kept for callers; prefer `tone()`). */
export const TONE_COLOR: Record<Tone | HealthStatus, string> = {
  ok: tone("ok").solid,
  warn: tone("warn").solid,
  bad: tone("bad").solid,
  neutral: tone("neutral").solid,
};

/** Wrapping grid: as many columns of at least `min` as fit, one column on a phone. */
export function grid(min: number, gap = 12): CSSProperties {
  return { display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(min(${min}px, 100%), 1fr))`, gap };
}

/** A coloured health light with its label ("All good", "Needs attention", "Problems"). */
export function Light({ status, label, size = 10 }: { status: HealthStatus; label?: string; size?: number }) {
  const text = label === undefined ? HEALTH_LABEL[status] : label;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", color: text ? tone(status).fg : undefined }}>
      <StatusDot tone={status} size={size} halo pulse={status === "bad" && size >= 10} label={text ? undefined : HEALTH_LABEL[status]} />
      {text}
    </span>
  );
}

export function Chip({ children, tone: t = "neutral", icon }: { children: ReactNode; tone?: ToneInput; icon?: LucideIcon }) {
  return <Pill tone={t} icon={icon}>{children}</Pill>;
}

export function Card({ title, actions, children, id, icon, subtitle, tone: t, strip }: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  id?: string;
  icon?: LucideIcon;
  subtitle?: ReactNode;
  tone?: ToneInput;
  strip?: boolean;
}) {
  return <SectionCard id={id} title={title} icon={icon} subtitle={subtitle} tone={t} strip={strip} actions={actions}>{children}</SectionCard>;
}

export function Muted({ children }: { children: ReactNode }) {
  return <p style={{ margin: 0, fontSize: 13, color: tokens.muted, lineHeight: 1.5 }}>{children}</p>;
}

function Anchor({ href, linkFor, children, style }: { href: string | null | undefined; linkFor: LinkPropsFor; children: ReactNode; style?: CSSProperties }) {
  if (!href) return <span style={style}>{children}</span>;
  const external = /^https?:\/\//i.test(href);
  const props = external ? { href, target: "_blank", rel: "noreferrer" } : linkFor(href);
  return <a {...props} style={{ color: "inherit", textDecoration: "none", ...style }}>{children}</a>;
}

function linkOf(href: string | null | undefined, linkFor: LinkPropsFor): AnchorHTMLAttributes<HTMLAnchorElement> | null {
  if (!href) return null;
  return /^https?:\/\//i.test(href) ? { href, target: "_blank", rel: "noreferrer" } : linkFor(href);
}

function OpenLink({ href, linkFor, label = "Open" }: { href: string | null | undefined; linkFor: LinkPropsFor; label?: string }) {
  if (!href) return null;
  const external = /^https?:\/\//i.test(href);
  return (
    <Anchor href={href} linkFor={linkFor} style={{ fontSize: 13, fontWeight: 600, color: tokens.primary, whiteSpace: "nowrap" }}>
      {label}{external ? " ↗" : " →"}
    </Anchor>
  );
}

function since(iso: string | null | undefined, now: Date): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : hoursAgo(now.getTime() - t);
}

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------

/** The hero card: health light, the one-line summary and four quick counts. */
export function TodayHero({ health, today, waiting, problems, agentAlerts, activeAgents, children }: {
  health: HealthStatus;
  today: string;
  waiting: WaitingEntry[];
  problems: number;
  agentAlerts: number;
  activeAgents: number | null;
  children?: ReactNode;
}) {
  const urgent = waiting.filter((item) => item.kind === "money" || item.kind === "legal").length;
  return (
    <Card title="Today" icon={Sun} tone={health} strip actions={<Light status={health} />}>
      <p style={{ margin: 0, fontSize: 15, fontWeight: 600, lineHeight: 1.45 }}>{today}</p>
      <div style={grid(150, 10)}>
        <KpiCard
          size="sm"
          label="Waiting on you"
          value={waiting.length}
          tone={urgent ? "bad" : waiting.length ? "warn" : "ok"}
          hint={urgent ? `${urgent} money or legal` : waiting.length ? "Your decisions" : "Nothing to decide"}
          icon={Inbox}
        />
        <KpiCard size="sm" label="Problems to fix" value={problems} tone={problems ? "bad" : "ok"} hint={problems ? "See System health" : "All systems ok"} icon={HeartPulse} />
        <KpiCard size="sm" label="Agent alerts" value={agentAlerts} tone={agentAlerts ? "warn" : "ok"} hint={agentAlerts ? "Budget or errors" : "No alerts"} icon={Bot} />
        <KpiCard size="sm" label="Agents working" value={activeAgents ?? "–"} hint={activeAgents === null ? "Agents not loaded" : "Active or idle now"} icon={Activity} />
      </div>
      {children}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Waiting on you
// ---------------------------------------------------------------------------

export const KIND_TONE: Record<WaitingEntry["kind"], ToneInput> = { money: "bad", legal: "warn", grant: "info", judgement: "accent", review: "neutral", other: "neutral" };
export const KIND_ICON: Record<WaitingEntry["kind"], LucideIcon> = { money: Banknote, legal: Scale, grant: KeyRound, judgement: CircleQuestionMark, review: Eye, other: Circle };

export function WaitingList({ items, linkFor, now, limit }: { items: WaitingEntry[]; linkFor: LinkPropsFor; now: Date; limit?: number }) {
  if (items.length === 0) return <Muted>Nothing waits on you. The agents have what they need.</Muted>;
  const shown = limit ? items.slice(0, limit) : items;
  return (
    <div style={{ display: "grid" }}>
      {shown.map((item, index) => {
        const t = tone(KIND_TONE[item.kind]);
        return (
          <div key={item.key} style={{ display: "grid", gridTemplateColumns: "3px minmax(0, 1fr)", gap: 12, padding: "10px 0", borderTop: index === 0 ? "none" : `1px solid ${tokens.border}` }}>
            <span aria-hidden="true" style={{ borderRadius: 999, background: t.solid, opacity: item.kind === "review" || item.kind === "other" ? 0.5 : 1 }} />
            <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <Pill tone={KIND_TONE[item.kind]} icon={KIND_ICON[item.kind]}>{KIND_LABEL[item.kind]}</Pill>
                <Anchor href={item.href} linkFor={linkFor} style={{ fontSize: 13.5, fontWeight: 600, minWidth: 0, overflowWrap: "anywhere", flex: "1 1 200px" }}>{item.title}</Anchor>
                <OpenLink href={item.href} linkFor={linkFor} />
              </div>
              <div style={{ fontSize: 12.5, color: tokens.muted, lineHeight: 1.45, overflowWrap: "anywhere" }}>
                {item.why}
                <span> · {item.sourceTitle}</span>
                {since(item.since, now) ? <span> · {since(item.since, now)}</span> : null}
              </div>
            </div>
          </div>
        );
      })}
      {limit && items.length > limit ? <Muted>And {items.length - limit} more.</Muted> : null}
    </div>
  );
}

/** Counts per kind as toned pills (for the Waiting card header). */
export function WaitingKinds({ items }: { items: WaitingEntry[] }) {
  const counts = new Map<WaitingEntry["kind"], number>();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  if (counts.size === 0) return null;
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {[...counts.entries()].map(([kind, count]) => <Pill key={kind} tone={KIND_TONE[kind]} size="sm" dot>{count} {KIND_LABEL[kind].toLowerCase()}</Pill>)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPIs
// ---------------------------------------------------------------------------

export const KPI_GROUP_ICON: Record<keyof typeof KPI_GROUP_TITLES, LucideIcon> = {
  money: Wallet,
  pipeline: Funnel,
  marketing: Megaphone,
  delivery: PackageCheck,
  people: Users,
  other: ChartColumn,
};

export function KpiTile({ kpi, linkFor, size = "md" }: { kpi: KpiEntry; linkFor: LinkPropsFor; size?: "sm" | "md" }) {
  const accent = moduleAccent(kpi.plugin);
  const toned = kpi.tone && kpi.tone !== "neutral" ? kpi.tone : undefined;
  return (
    <KpiCard
      size={size}
      label={kpi.label}
      value={kpi.value}
      tone={kpi.tone ?? "neutral"}
      delta={kpi.delta ?? null}
      deltaTone={toned}
      hint={kpi.pluginTitle}
      icon={moduleKeyOf(kpi.plugin) ? accent.icon : undefined}
      iconAccent={moduleKeyOf(kpi.plugin) ? accent : undefined}
      link={linkOf(kpi.href, linkFor)}
    />
  );
}

export function KpiGroup({ group, kpis, linkFor }: { group: keyof typeof KPI_GROUP_TITLES; kpis: KpiEntry[]; linkFor: LinkPropsFor }) {
  const bad = kpis.filter((k) => k.tone === "bad").length;
  const warn = kpis.filter((k) => k.tone === "warn").length;
  return (
    <Card
      title={KPI_GROUP_TITLES[group]}
      icon={KPI_GROUP_ICON[group]}
      actions={bad ? <Pill tone="bad" size="sm" dot>{bad} to fix</Pill> : warn ? <Pill tone="warn" size="sm" dot>{warn} to watch</Pill> : null}
    >
      {kpis.length === 0
        ? <Muted>No numbers reported yet.</Muted>
        : <div style={grid(150, 10)}>{kpis.map((kpi) => <KpiTile key={`${kpi.plugin}:${kpi.key}`} kpi={kpi} linkFor={linkFor} />)}</div>}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// What the agents did
// ---------------------------------------------------------------------------

export const RUN_SERIES = [
  { key: "succeeded", label: "Succeeded", tone: "ok" as const },
  { key: "failed", label: "Failed", tone: "bad" as const },
  { key: "other", label: "Other", tone: "neutral" as const },
];

/** Runs per day for the last 14 days, stacked like the host's Run Activity chart. */
export function RunsChart({ runs, now }: { runs: RunLite[]; now: Date }) {
  const days = runsPerDay(runs, now, 14);
  const total = days.reduce((sum, d) => sum + d.total, 0);
  const failed = days.reduce((sum, d) => sum + d.failed, 0);
  return (
    <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: tokens.muted }}>Runs per day · last 14 days</span>
        {total ? (
          <span style={{ fontSize: 12, color: tokens.muted, fontVariantNumeric: "tabular-nums" }}>
            {total} runs · <span style={{ color: failed ? tone("bad").fg : tone("ok").fg, fontWeight: 600 }}>{Math.round(((total - failed) / total) * 100)}% succeeded</span>
          </span>
        ) : null}
      </div>
      <BarChart data={runColumns(days)} series={RUN_SERIES} title="Agent runs per day" unit="runs" height={88} emptyText="No runs in the last 14 days." />
    </div>
  );
}

/** Every activity line, newest first, with the agent as meta. */
export function activityItems(groups: ActivityGroup[], linkFor: LinkPropsFor): TimelineItem[] {
  const items: Array<TimelineItem & { t: number }> = [];
  for (const group of groups) {
    for (const [index, line] of group.lines.entries()) {
      items.push({
        id: `${group.key}:${index}`,
        t: Date.parse(line.at),
        at: line.at,
        title: line.text,
        link: linkOf(line.href, linkFor),
        tone: group.agentId ? "info" : "accent",
        meta: <Pill size="sm" tone={group.agentId ? "neutral" : "accent"} icon={group.agentId ? Bot : undefined}>{group.name}</Pill>,
        detail: line.source,
      });
    }
  }
  return items.sort((a, b) => (Number.isNaN(b.t) ? 0 : b.t) - (Number.isNaN(a.t) ? 0 : a.t)).map(({ t: _t, ...item }) => item);
}

export function ActivityList({ groups, linkFor, now, runs }: { groups: ActivityGroup[]; linkFor: LinkPropsFor; now: Date; runs?: RunLite[] }) {
  const withRuns = groups.filter((g) => g.runs.total > 0);
  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      {runs ? <RunsChart runs={runs} now={now} /> : null}
      {withRuns.length > 0 ? (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }} aria-label="Runs in this period">
          {withRuns.map((g) => (
            <Anchor key={g.key} href={g.agentId ? `/agents/${g.agentId}` : null} linkFor={linkFor}>
              <Pill tone={g.runs.failed > 0 ? "warn" : "neutral"} icon={Bot}>{g.name}: {g.runs.total} {g.runs.total === 1 ? "run" : "runs"}{g.runs.failed ? `, ${g.runs.failed} failed` : ""}</Pill>
            </Anchor>
          ))}
        </div>
      ) : null}
      {groups.length === 0
        ? <Muted>No agent activity in this period.</Muted>
        : <Timeline items={activityItems(groups, linkFor)} now={now} limit={12} empty="Ran, nothing notable logged." />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export function agentTone(status: string): { tone: ToneInput; pulse: boolean } {
  if (status === "error") return { tone: "bad", pulse: false };
  if (status === "running") return { tone: "info", pulse: true };
  if (status === "paused" || status === "pending_approval") return { tone: "warn", pulse: false };
  if (status === "active" || status === "idle") return { tone: "ok", pulse: false };
  return { tone: "neutral", pulse: false };
}

function budgetBar(row: AgentRow) {
  if (row.budgetRatio === null) return <span style={{ color: tokens.muted }}>{formatCents(row.spentMonthlyCents)} (no budget)</span>;
  return (
    <div style={{ display: "grid", gap: 5, minWidth: 120 }}>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatCents(row.spentMonthlyCents)} of {formatCents(row.budgetMonthlyCents)} · {Math.round(row.budgetRatio * 100)}%</span>
      <ProgressBar value={row.budgetRatio} tone="budget" size="sm" ariaLabel={`${row.name} budget used`} />
    </div>
  );
}

const th: CSSProperties = { textAlign: "left", fontSize: 11.5, fontWeight: 600, color: tokens.muted, padding: "8px 10px", borderBottom: `1px solid ${tokens.border}`, whiteSpace: "nowrap" };
const td: CSSProperties = { fontSize: 12.5, padding: "10px", borderBottom: `1px solid ${tokens.border}`, verticalAlign: "top" };

/** One agent as a card (phones). */
export function AgentCard({ row, linkFor, now }: { row: AgentRow; linkFor: LinkPropsFor; now: Date }) {
  const status = agentTone(row.status);
  const alertTone = row.alert === "error" || (row.budgetRatio ?? 0) >= 1 ? "bad" : "warn";
  return (
    <div style={{ display: "grid", gap: 8, padding: 12, borderRadius: 12, border: `1px solid ${row.alert ? tone(alertTone).border : tokens.border}`, background: tokens.bg, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <StatusDot tone={status.tone} pulse={status.pulse} size={8} />
        <Anchor href={`/agents/${row.urlKey || row.id}`} linkFor={linkFor} style={{ fontWeight: 650, fontSize: 14, flex: "1 1 120px", minWidth: 0, overflowWrap: "anywhere" }}>{row.name}</Anchor>
        <Pill tone={status.tone} dot size="sm">{row.status.replace(/_/g, " ") || "unknown"}</Pill>
      </div>
      {row.title ? <div style={{ color: tokens.muted, fontSize: 12 }}>{row.title}</div> : null}
      {row.alertText ? <div style={{ fontSize: 12, color: tone(alertTone).fg, lineHeight: 1.45 }}>{row.alertText}</div> : null}
      <div style={{ fontSize: 12.5 }}>{budgetBar(row)}</div>
      <div style={{ fontSize: 12, color: tokens.muted }}>
        Last run {since(row.lastRunAt, now) ?? "never"}
        {row.runs.total ? <> · {row.runs.total} runs in 7 days{row.runs.failed ? <span style={{ color: tone("bad").fg, fontWeight: 600 }}>, {row.runs.failed} failed</span> : ""}</> : null}
      </div>
      {row.quality.length ? <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{row.quality.map((q) => <Chip key={q.key} tone={q.tone ?? "neutral"}>{q.label}: {q.value}</Chip>)}</div> : null}
    </div>
  );
}

export function AgentsTable({ rows, linkFor, now }: { rows: AgentRow[]; linkFor: LinkPropsFor; now: Date }) {
  const narrow = useIsNarrow();
  if (rows.length === 0) return <Muted>No agents yet.</Muted>;
  if (narrow) return <div style={{ display: "grid", gap: 10 }}>{rows.map((row) => <AgentCard key={row.id} row={row} linkFor={linkFor} now={now} />)}</div>;
  return (
    <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch", margin: "0 -4px", padding: "0 4px" }}>
      <table style={{ width: "100%", minWidth: 640, borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={th}>Agent</th>
            <th style={th}>Status</th>
            <th style={th}>Last run</th>
            <th style={th}>Spend this month</th>
            <th style={th}>Quality</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const status = agentTone(row.status);
            return (
              <tr key={row.id}>
                <td style={td}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <StatusDot tone={status.tone} pulse={status.pulse} size={8} />
                    <Anchor href={`/agents/${row.urlKey || row.id}`} linkFor={linkFor} style={{ fontWeight: 600 }}>{row.name}</Anchor>
                  </span>
                  {row.title ? <div style={{ color: tokens.muted, fontSize: 11.5, paddingLeft: 16 }}>{row.title}</div> : null}
                  {row.alertText ? <div style={{ marginTop: 4, paddingLeft: 16 }}><Chip tone={row.alert === "error" || (row.budgetRatio ?? 0) >= 1 ? "bad" : "warn"}>{row.alert === "error" ? "Error" : "Budget 80%+"}</Chip></div> : null}
                </td>
                <td style={td}>
                  <Pill tone={status.tone} dot>{row.status.replace(/_/g, " ") || "unknown"}</Pill>
                  {row.alertText ? <div style={{ color: tokens.muted, fontSize: 11.5, marginTop: 4, maxWidth: 220 }}>{row.alertText}</div> : null}
                </td>
                <td style={{ ...td, whiteSpace: "nowrap" }}>
                  {since(row.lastRunAt, now) ?? "Never"}
                  {row.runs.total ? (
                    <div style={{ color: tokens.muted, fontSize: 11.5 }}>
                      {row.runs.total} runs in 7 days{row.runs.failed ? <span style={{ color: tone("bad").fg, fontWeight: 600 }}>, {row.runs.failed} failed</span> : ""}
                    </div>
                  ) : null}
                </td>
                <td style={td}>{budgetBar(row)}</td>
                <td style={td}>
                  {row.quality.length === 0 ? <span style={{ color: tokens.muted }}>—</span> : (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {row.quality.map((q) => <Chip key={q.key} tone={q.tone ?? "neutral"}>{q.label}: {q.value}</Chip>)}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// System health
// ---------------------------------------------------------------------------

function groupIcon(plugin: string): LucideIcon {
  if (plugin === "host") return Server;
  if (plugin === "agents") return Bot;
  return moduleKeyOf(plugin) ? moduleAccent(plugin).icon : Gauge;
}

/** Checks per status as pills and one distribution bar. */
export function HealthSummary({ groups }: { groups: HealthGroup[] }) {
  const counts = healthCounts(groups);
  const total = counts.ok + counts.warn + counts.bad;
  if (total === 0) return null;
  return (
    <div style={{ display: "grid", gap: 10, minWidth: 0 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Pill tone="ok" dot>{counts.ok} ok</Pill>
        <Pill tone={counts.warn ? "warn" : "neutral"} dot>{counts.warn} {counts.warn === 1 ? "warning" : "warnings"}</Pill>
        <Pill tone={counts.bad ? "bad" : "neutral"} dot>{counts.bad} {counts.bad === 1 ? "problem" : "problems"}</Pill>
      </div>
      <StackedBar
        title="Health checks"
        height={8}
        legend={false}
        segments={[
          { key: "bad", label: "Problems", value: counts.bad, tone: "bad" },
          { key: "warn", label: "Warnings", value: counts.warn, tone: "warn" },
          { key: "ok", label: "Ok", value: counts.ok, tone: "ok" },
        ]}
      />
    </div>
  );
}

export function HealthList({ groups, linkFor, now, backup }: { groups: HealthGroup[]; linkFor: LinkPropsFor; now: Date; backup: BackupInfo | null }) {
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {backup ? (
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 13, padding: "10px 12px", borderRadius: 12, border: `1px solid ${backup.status === "ok" ? tokens.border : tone(backup.status).border}`, background: backup.status === "ok" ? tokens.bg : tone(backup.status).soft }}>
          <Light status={backup.status} label="" />
          <strong>Last database backup</strong>
          <span style={{ color: tokens.muted }}>{backup.text}{backup.status !== "ok" ? " Backups run hourly; check the server." : ""}</span>
        </div>
      ) : null}
      {groups.length === 0 ? <Muted>No plugin has reported health yet.</Muted> : groups.map((group) => {
        const failing = group.checks.filter((c) => c.status !== "ok").length;
        const t = tone(group.status);
        const Glyph = groupIcon(group.plugin);
        return (
          <details key={group.plugin} open={group.status !== "ok"} style={{ borderRadius: 12, border: `1px solid ${group.status === "ok" ? tokens.border : t.border}`, background: group.status === "ok" ? tokens.bg : `linear-gradient(180deg, ${t.soft}, transparent 80%), ${tokens.bg}`, padding: "10px 12px" }}>
            <summary style={{ cursor: "pointer", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", listStyle: "none" }}>
              <Light status={group.status} label="" />
              <Glyph size={15} strokeWidth={2} color={tokens.muted} aria-hidden="true" style={{ flexShrink: 0 }} />
              <strong style={{ fontSize: 13.5 }}>{group.title}</strong>
              <span style={{ fontSize: 12.5, color: failing ? t.fg : tokens.muted, fontWeight: failing ? 600 : 400 }}>
                {failing === 0 ? `${group.checks.length} ${group.checks.length === 1 ? "check" : "checks"} ok` : `${failing} of ${group.checks.length} need attention`}
              </span>
            </summary>
            <div style={{ display: "grid", marginTop: 8 }}>
              {group.checks.map((check) => (
                <div key={check.key} style={{ display: "grid", gap: 3, padding: "8px 0", borderTop: `1px solid ${tokens.border}` }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <Light status={check.status} label="" size={8} />
                    <span style={{ fontSize: 13, fontWeight: 600, flex: "1 1 180px", minWidth: 0, overflowWrap: "anywhere" }}>{check.title}</span>
                    {check.status !== "ok" ? <OpenLink href={check.href} linkFor={linkFor} label="Fix" /> : null}
                  </div>
                  {check.detail ? <div style={{ fontSize: 12.5, color: tokens.muted, overflowWrap: "anywhere", paddingLeft: 16 }}>{check.detail}{check.since && check.status !== "ok" ? ` Since ${since(check.since, now)}.` : ""}</div> : null}
                  {check.fix && check.status !== "ok" ? <div style={{ fontSize: 12.5, overflowWrap: "anywhere", paddingLeft: 16 }}><span style={{ color: tokens.muted }}>Fix: </span>{check.fix}</div> : null}
                </div>
              ))}
            </div>
          </details>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard widget
// ---------------------------------------------------------------------------

/** The dashboard widget body. */
export function TodayCard({ waiting, health, today, headline, linkFor }: { waiting: number; health: HealthStatus; today: string; headline: KpiEntry[]; linkFor: LinkPropsFor }) {
  const accent = moduleAccent("cockpit");
  const t = tone(health);
  return (
    <div style={{ position: "relative", display: "grid", gap: 12, padding: 16, borderRadius: 14, border: `1px solid ${tokens.border}`, background: tokens.card, color: tokens.fg, minWidth: 0 }}>
      <span aria-hidden="true" style={{ position: "absolute", top: -1, left: -1, right: -1, height: 3, borderRadius: "14px 14px 0 0", background: t.solid }} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
          <span aria-hidden="true" style={{ width: 28, height: 28, borderRadius: 8, display: "inline-grid", placeItems: "center", background: accent.soft, boxShadow: `inset 0 0 0 1px ${accent.border}` }}>
            <Gauge size={15} color={accent.solid} strokeWidth={2} />
          </span>
          <strong style={{ fontSize: 14 }}>Company today</strong>
        </span>
        <a {...linkFor("/cockpit")} style={{ fontSize: 13, fontWeight: 600, color: tokens.primary, textDecoration: "none" }}>Open Cockpit →</a>
      </div>
      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
        <Light status={health} size={12} />
        <a {...linkFor("/cockpit")} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, color: tokens.fg, textDecoration: "none" }}>
          <Inbox size={14} color={waiting ? tone("warn").solid : tokens.muted} aria-hidden="true" />
          {waiting === 0 ? "Nothing waiting on you" : `${waiting} waiting on you`}
        </a>
      </div>
      <p style={{ margin: 0, fontSize: 12.5, color: tokens.muted, lineHeight: 1.45 }}>{today}</p>
      {headline.length > 0 ? <div style={grid(130, 8)}>{headline.map((kpi) => <KpiTile key={`${kpi.plugin}:${kpi.key}`} kpi={kpi} linkFor={linkFor} size="sm" />)}</div> : null}
    </div>
  );
}
