/**
 * Presentational pieces of the Cockpit (no host hooks, so they render in
 * tests). Layouts wrap and scroll instead of using fixed widths, so the page
 * works on a 375px phone.
 */
import type { AnchorHTMLAttributes, CSSProperties, ReactNode } from "react";
import { tokens } from "@partnersinbiz/pib-plugin-ui";
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
  type Tone,
  type WaitingEntry,
} from "../merge.js";
import type { BackupInfo } from "../view.js";

export type LinkPropsFor = (href: string) => AnchorHTMLAttributes<HTMLAnchorElement>;

export const TONE_COLOR: Record<Tone | HealthStatus, string> = {
  ok: "var(--chart-2)",
  warn: "var(--chart-4)",
  bad: "var(--destructive)",
  neutral: "var(--muted-foreground)",
};

/** Wrapping grid: as many columns of at least `min` as fit, one column on a phone. */
export function grid(min: number, gap = 12): CSSProperties {
  return { display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(min(${min}px, 100%), 1fr))`, gap };
}

export function Light({ status, label, size = 10 }: { status: HealthStatus; label?: string; size?: number }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}>
      <span
        aria-hidden="true"
        style={{
          width: size,
          height: size,
          borderRadius: 999,
          background: TONE_COLOR[status],
          boxShadow: `0 0 0 3px color-mix(in oklab, ${TONE_COLOR[status]} 22%, transparent)`,
          flexShrink: 0,
        }}
      />
      {label === undefined ? HEALTH_LABEL[status] : label}
    </span>
  );
}

export function Chip({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone | HealthStatus }) {
  const bg = tone === "neutral" ? tokens.secondary : `color-mix(in oklab, ${TONE_COLOR[tone]} 18%, transparent)`;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", minHeight: 22, padding: "0 8px", borderRadius: 999, fontSize: 11.5, fontWeight: 600, background: bg, color: tone === "neutral" ? tokens.secondaryFg : tokens.fg, whiteSpace: "nowrap" }}>
      {children}
    </span>
  );
}

export function Card({ title, actions, children, id }: { title: string; actions?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section id={id} style={{ display: "grid", gap: 12, padding: "clamp(12px, 3.5vw, 18px)", borderRadius: 14, border: `1px solid ${tokens.border}`, background: tokens.card, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 12, fontWeight: 650, letterSpacing: "0.06em", textTransform: "uppercase", color: tokens.muted }}>{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
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

const KIND_TONE: Record<WaitingEntry["kind"], Tone> = { money: "bad", legal: "bad", grant: "warn", judgement: "warn", review: "neutral", other: "neutral" };

export function WaitingList({ items, linkFor, now, limit }: { items: WaitingEntry[]; linkFor: LinkPropsFor; now: Date; limit?: number }) {
  if (items.length === 0) return <Muted>Nothing waits on you. The agents have what they need.</Muted>;
  const shown = limit ? items.slice(0, limit) : items;
  return (
    <div style={{ display: "grid" }}>
      {shown.map((item, index) => (
        <div key={item.key} style={{ display: "grid", gap: 4, padding: "10px 0", borderTop: index === 0 ? "none" : `1px solid ${tokens.border}` }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Chip tone={KIND_TONE[item.kind]}>{KIND_LABEL[item.kind]}</Chip>
            <Anchor href={item.href} linkFor={linkFor} style={{ fontSize: 13.5, fontWeight: 600, minWidth: 0, overflowWrap: "anywhere", flex: "1 1 200px" }}>{item.title}</Anchor>
            <OpenLink href={item.href} linkFor={linkFor} />
          </div>
          <div style={{ fontSize: 12.5, color: tokens.muted, lineHeight: 1.45, overflowWrap: "anywhere" }}>
            {item.why}
            <span> · {item.sourceTitle}</span>
            {since(item.since, now) ? <span> · {since(item.since, now)}</span> : null}
          </div>
        </div>
      ))}
      {limit && items.length > limit ? <Muted>And {items.length - limit} more.</Muted> : null}
    </div>
  );
}

export function KpiTile({ kpi, linkFor }: { kpi: KpiEntry; linkFor: LinkPropsFor }) {
  const tone = kpi.tone ?? "neutral";
  return (
    <Anchor href={kpi.href} linkFor={linkFor} style={{ display: "grid", gap: 4, padding: 12, borderRadius: 12, border: `1px solid ${tone === "bad" || tone === "warn" ? `color-mix(in oklab, ${TONE_COLOR[tone]} 55%, ${tokens.border})` : tokens.border}`, background: tokens.bg, minWidth: 0 }}>
      <span style={{ fontSize: 12, color: tokens.muted, overflowWrap: "anywhere" }}>{kpi.label}</span>
      <span style={{ fontSize: 20, fontWeight: 650, letterSpacing: "-0.02em", overflowWrap: "anywhere", color: tone === "bad" ? "var(--destructive)" : tokens.fg }}>{kpi.value}</span>
      <span style={{ fontSize: 11.5, color: tokens.muted, overflowWrap: "anywhere" }}>{[kpi.delta, kpi.pluginTitle].filter(Boolean).join(" · ")}</span>
    </Anchor>
  );
}

export function KpiGroup({ group, kpis, linkFor }: { group: keyof typeof KPI_GROUP_TITLES; kpis: KpiEntry[]; linkFor: LinkPropsFor }) {
  return (
    <Card title={KPI_GROUP_TITLES[group]}>
      {kpis.length === 0
        ? <Muted>No numbers reported yet.</Muted>
        : <div style={grid(150, 10)}>{kpis.map((kpi) => <KpiTile key={`${kpi.plugin}:${kpi.key}`} kpi={kpi} linkFor={linkFor} />)}</div>}
    </Card>
  );
}

export function ActivityList({ groups, linkFor, now }: { groups: ActivityGroup[]; linkFor: LinkPropsFor; now: Date }) {
  if (groups.length === 0) return <Muted>No agent activity in this period.</Muted>;
  return (
    <div style={grid(280, 12)}>
      {groups.map((group) => (
        <div key={group.key} style={{ display: "grid", gap: 6, padding: 12, borderRadius: 12, border: `1px solid ${tokens.border}`, background: tokens.bg, minWidth: 0, alignContent: "start" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <Anchor href={group.agentId ? `/agents/${group.agentId}` : null} linkFor={linkFor} style={{ fontSize: 13.5, fontWeight: 650 }}>{group.name}</Anchor>
            {group.runs.total > 0 ? <Chip tone={group.runs.failed > 0 ? "warn" : "neutral"}>{group.runs.total} {group.runs.total === 1 ? "run" : "runs"}{group.runs.failed ? `, ${group.runs.failed} failed` : ""}</Chip> : null}
          </div>
          {group.lines.length === 0 ? <Muted>Ran, nothing notable logged.</Muted> : (
            <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
              {group.lines.map((line, index) => (
                <li key={index} style={{ fontSize: 12.5, lineHeight: 1.45, overflowWrap: "anywhere" }}>
                  <Anchor href={line.href} linkFor={linkFor}>{line.text}</Anchor>
                  <span style={{ color: tokens.muted }}> · {since(line.at, now)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

function budgetBar(row: AgentRow) {
  if (row.budgetRatio === null) return <span style={{ color: tokens.muted }}>{formatCents(row.spentMonthlyCents)} (no budget)</span>;
  const percent = Math.min(100, Math.round(row.budgetRatio * 100));
  const tone: HealthStatus = row.budgetRatio >= 1 ? "bad" : row.budgetRatio >= 0.8 ? "warn" : "ok";
  return (
    <div style={{ display: "grid", gap: 4, minWidth: 120 }}>
      <span>{formatCents(row.spentMonthlyCents)} of {formatCents(row.budgetMonthlyCents)} · {Math.round(row.budgetRatio * 100)}%</span>
      <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} style={{ height: 6, borderRadius: 999, background: tokens.secondary, overflow: "hidden" }}>
        <div style={{ width: `${percent}%`, height: "100%", background: TONE_COLOR[tone] }} />
      </div>
    </div>
  );
}

const th: CSSProperties = { textAlign: "left", fontSize: 11.5, fontWeight: 600, color: tokens.muted, padding: "8px 10px", borderBottom: `1px solid ${tokens.border}`, whiteSpace: "nowrap" };
const td: CSSProperties = { fontSize: 12.5, padding: "10px", borderBottom: `1px solid ${tokens.border}`, verticalAlign: "top" };

export function AgentsTable({ rows, linkFor, now }: { rows: AgentRow[]; linkFor: LinkPropsFor; now: Date }) {
  if (rows.length === 0) return <Muted>No agents yet.</Muted>;
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
          {rows.map((row) => (
            <tr key={row.id}>
              <td style={td}>
                <Anchor href={`/agents/${row.urlKey || row.id}`} linkFor={linkFor} style={{ fontWeight: 600 }}>{row.name}</Anchor>
                {row.title ? <div style={{ color: tokens.muted, fontSize: 11.5 }}>{row.title}</div> : null}
                {row.alertText ? <div style={{ marginTop: 4 }}><Chip tone={row.alert === "error" || (row.budgetRatio ?? 0) >= 1 ? "bad" : "warn"}>{row.alert === "error" ? "Error" : "Budget 80%+"}</Chip></div> : null}
              </td>
              <td style={td}>
                <Chip tone={row.status === "error" ? "bad" : row.status === "paused" || row.status === "pending_approval" ? "warn" : "neutral"}>{row.status.replace(/_/g, " ") || "unknown"}</Chip>
                {row.alertText ? <div style={{ color: tokens.muted, fontSize: 11.5, marginTop: 4, maxWidth: 220 }}>{row.alertText}</div> : null}
              </td>
              <td style={{ ...td, whiteSpace: "nowrap" }}>
                {since(row.lastRunAt, now) ?? "Never"}
                {row.runs.total ? <div style={{ color: tokens.muted, fontSize: 11.5 }}>{row.runs.total} runs in 7 days{row.runs.failed ? `, ${row.runs.failed} failed` : ""}</div> : null}
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
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function HealthList({ groups, linkFor, now, backup }: { groups: HealthGroup[]; linkFor: LinkPropsFor; now: Date; backup: BackupInfo | null }) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {backup ? (
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 13 }}>
          <Light status={backup.status} label="" />
          <strong>Last database backup</strong>
          <span style={{ color: tokens.muted }}>{backup.text}{backup.status !== "ok" ? " Backups run hourly; check the server." : ""}</span>
        </div>
      ) : null}
      {groups.length === 0 ? <Muted>No plugin has reported health yet.</Muted> : groups.map((group) => (
        <details key={group.plugin} open={group.status !== "ok"} style={{ borderRadius: 12, border: `1px solid ${tokens.border}`, background: tokens.bg, padding: "10px 12px" }}>
          <summary style={{ cursor: "pointer", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", listStyle: "none" }}>
            <Light status={group.status} label="" />
            <strong style={{ fontSize: 13.5 }}>{group.title}</strong>
            <span style={{ fontSize: 12.5, color: tokens.muted }}>
              {group.checks.filter((c) => c.status !== "ok").length === 0 ? `${group.checks.length} ${group.checks.length === 1 ? "check" : "checks"} ok` : `${group.checks.filter((c) => c.status !== "ok").length} of ${group.checks.length} need attention`}
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
                {check.detail ? <div style={{ fontSize: 12.5, color: tokens.muted, overflowWrap: "anywhere" }}>{check.detail}{check.since && check.status !== "ok" ? ` Since ${since(check.since, now)}.` : ""}</div> : null}
                {check.fix && check.status !== "ok" ? <div style={{ fontSize: 12.5, overflowWrap: "anywhere" }}><span style={{ color: tokens.muted }}>Fix: </span>{check.fix}</div> : null}
              </div>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}

/** The dashboard widget body. */
export function TodayCard({ waiting, health, today, headline, linkFor }: { waiting: number; health: HealthStatus; today: string; headline: KpiEntry[]; linkFor: LinkPropsFor }) {
  return (
    <div style={{ display: "grid", gap: 12, padding: 16, borderRadius: 14, border: `1px solid ${tokens.border}`, background: tokens.card, color: tokens.fg }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 14 }}>Company today</strong>
        <a {...linkFor("/cockpit")} style={{ fontSize: 13, fontWeight: 600, color: tokens.primary, textDecoration: "none" }}>Open Cockpit →</a>
      </div>
      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
        <Light status={health} />
        <a {...linkFor("/cockpit")} style={{ fontSize: 13, fontWeight: 600, color: tokens.fg, textDecoration: "none" }}>
          {waiting === 0 ? "Nothing waiting on you" : `${waiting} waiting on you`}
        </a>
      </div>
      <p style={{ margin: 0, fontSize: 12.5, color: tokens.muted, lineHeight: 1.45 }}>{today}</p>
      {headline.length > 0 ? <div style={grid(120, 8)}>{headline.map((kpi) => <KpiTile key={`${kpi.plugin}:${kpi.key}`} kpi={kpi} linkFor={linkFor} />)}</div> : null}
    </div>
  );
}
