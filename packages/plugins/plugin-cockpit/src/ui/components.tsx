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
  ChevronRight,
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
  MessageCircleQuestionMark,
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
  formatShortDate,
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
import { TEAM_SETUP_PATH } from "@partnersinbiz/pib-plugin-kit/team";
import { ASK_KIND_LABEL, askTone } from "../ask-model.js";
import type { BackupInfo } from "../view.js";
import { plainDetail } from "../plain.js";
import { kpiParts, readableDates } from "./kpis.js";
import { healthCounts, runColumns, runsPerDay } from "./series.js";

export type LinkPropsFor = (href: string) => AnchorHTMLAttributes<HTMLAnchorElement>;

/** Solid colour per Cockpit tone (kept for callers; prefer `tone()`). */
export const TONE_COLOR: Record<Tone | HealthStatus, string> = {
  ok: tone("ok").solid,
  warn: tone("warn").solid,
  bad: tone("bad").solid,
  neutral: tone("neutral").solid,
};

/** Wrapping grid: as many columns of at least `min` as fit, one column on a phone. `fill` stretches the items across the row. */
export function grid(min: number, gap = 12, fill = false): CSSProperties {
  return { display: "grid", gridTemplateColumns: `repeat(${fill ? "auto-fit" : "auto-fill"}, minmax(min(${min}px, 100%), 1fr))`, gap };
}

/** At most `lines` lines of text, cut with an ellipsis (long "why" texts on a phone). */
export function clampLines(lines: number): CSSProperties {
  return { display: "-webkit-box", WebkitLineClamp: lines, WebkitBoxOrient: "vertical", overflow: "hidden" };
}

/** A small "Details" disclosure for raw technical text (an API error, an adapter message). */
export function Details({ raw, label = "Details" }: { raw: string | null | undefined; label?: string }) {
  if (!raw) return null;
  return (
    <details style={{ minWidth: 0 }}>
      <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 600, color: tokens.muted, minHeight: 24, display: "inline-flex", alignItems: "center" }}>{label}</summary>
      <code style={{ display: "block", marginTop: 4, padding: "6px 8px", borderRadius: 8, background: tokens.secondary, color: tokens.fg, fontSize: 11.5, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{raw}</code>
    </details>
  );
}

/** Anchor props that scroll to a section of this page (`#health`) without leaving it. */
export function sectionLink(id: string): AnchorHTMLAttributes<HTMLAnchorElement> {
  return {
    href: `#${id}`,
    onClick: (event) => {
      if (typeof document === "undefined") return;
      const target = document.getElementById(id);
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    },
  };
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

/** True for a link to Setup → Team, where every agent role is hired, picked, changed or removed. */
export function isTeamSetupHref(href: string | null | undefined): boolean {
  return typeof href === "string" && href.startsWith(TEAM_SETUP_PATH);
}

/** The link label for a problem: "Fix in Setup" when the fix is staffing a role in Setup → Team. */
export function fixLabel(href: string | null | undefined, fallback: string): string {
  return isTeamSetupHref(href) ? "Fix in Setup" : fallback;
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

/** Where the company's run log lives (every agent run, newest first). */
export const RUN_LOG_PATH = "/activity/runs";

/**
 * The hero card. Failing runs come first ("All 15 runs in the last 24 hours
 * failed → Open run log"), then the one-line summary and four quick counts
 * that fill their row. System health shows problems and warnings and jumps
 * to the System health card.
 */
export function TodayHero({ health, today, waiting, problems, warnings = 0, agentAlerts, activeAgents, runAlert, linkFor, children }: {
  health: HealthStatus;
  today: string;
  waiting: WaitingEntry[];
  problems: number;
  /** Checks that need attention but are not problems. */
  warnings?: number;
  agentAlerts: number;
  activeAgents: number | null;
  /** "All 15 runs in the last 24 hours failed", when runs fail. */
  runAlert?: { text: string; tone: "bad" | "warn" } | null;
  linkFor?: LinkPropsFor;
  children?: ReactNode;
}) {
  const narrow = useIsNarrow();
  const urgent = waiting.filter((item) => item.kind === "money" || item.kind === "legal").length;
  const questions = waiting.filter((item) => item.ask).length;
  const runTone = runAlert ? tone(runAlert.tone) : null;
  return (
    <Card title="Today" icon={Sun} tone={runAlert ? worstTone(health, runAlert.tone) : health} strip actions={<Light status={runAlert ? worstTone(health, runAlert.tone) : health} />}>
      {runAlert && runTone ? (
        <a
          {...(linkFor ? linkFor(RUN_LOG_PATH) : { href: RUN_LOG_PATH })}
          data-run-alert={runAlert.tone}
          className="pib-link-card"
          style={{ display: "flex", gap: 10, alignItems: "center", minHeight: 44, padding: "8px 12px", borderRadius: 12, border: `1px solid ${runTone.border}`, background: runTone.soft, color: tokens.fg, textDecoration: "none", minWidth: 0 }}
        >
          <Bot size={16} color={runTone.solid} aria-hidden="true" style={{ flexShrink: 0 }} />
          <strong style={{ fontSize: 14, flex: "1 1 auto", minWidth: 0, overflowWrap: "anywhere" }}>{runAlert.text}</strong>
          {narrow
            ? <ChevronRight size={18} aria-label="Open run log" style={{ color: tokens.muted, flexShrink: 0 }} />
            : <span style={{ fontSize: 13, fontWeight: 600, color: tokens.primary, whiteSpace: "nowrap", flexShrink: 0 }}>Open run log →</span>}
        </a>
      ) : null}
      <p style={{ margin: 0, fontSize: 15, fontWeight: 600, lineHeight: 1.45 }}>{today}</p>
      <div style={grid(150, 10, true)}>
        <KpiCard
          size="sm"
          label="Waiting on you"
          value={waiting.length}
          tone={urgent ? "bad" : waiting.length ? "warn" : "ok"}
          hint={urgent ? `${urgent} money or legal` : questions ? `${questions} ${questions === 1 ? "question" : "questions"} from agents` : waiting.length ? "Your decisions" : "Nothing to decide"}
          icon={Inbox}
          link={sectionLink("waiting")}
        />
        <KpiCard
          size="sm"
          label="System health"
          value={problems || warnings ? `${problems} ${problems === 1 ? "problem" : "problems"}` : "All ok"}
          tone={problems ? "bad" : warnings ? "warn" : "ok"}
          hint={problems || warnings ? `${warnings} ${warnings === 1 ? "warning" : "warnings"}` : "Every check passes"}
          icon={HeartPulse}
          link={sectionLink("health")}
        />
        <KpiCard size="sm" label="Agent alerts" value={agentAlerts} tone={agentAlerts ? "warn" : "ok"} hint={agentAlerts ? "Errors or budget" : "No alerts"} icon={Bot} link={sectionLink("agents")} />
        <KpiCard size="sm" label="Agents working" value={activeAgents ?? "–"} hint={activeAgents === null ? "Agents not loaded" : "Active or idle now"} icon={Activity} />
      </div>
      {children}
    </Card>
  );
}

function worstTone(a: HealthStatus, b: "bad" | "warn"): HealthStatus {
  return a === "bad" || b === "bad" ? "bad" : "warn";
}

// ---------------------------------------------------------------------------
// Waiting on you
// ---------------------------------------------------------------------------

export const KIND_TONE: Record<WaitingEntry["kind"], ToneInput> = { money: "bad", legal: "warn", grant: "info", judgement: "accent", review: "neutral", other: "neutral" };
export const KIND_ICON: Record<WaitingEntry["kind"], LucideIcon> = { money: Banknote, legal: Scale, grant: KeyRound, judgement: CircleQuestionMark, review: Eye, other: Circle };
const KIND_PLURAL: Record<WaitingEntry["kind"], string> = { money: "Money", legal: "Legal", grant: "One-time grants", judgement: "Your calls", review: "Reviews", other: "Other" };

/** "Answer" / "Fix in Setup": a small primary link-button (the host only styles its own class names). */
export const primaryLinkStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  minHeight: 32,
  padding: "0 12px",
  borderRadius: 8,
  background: tokens.primary,
  color: tokens.primaryFg,
  fontSize: 13,
  fontWeight: 600,
  textDecoration: "none",
  whiteSpace: "nowrap",
};

function askedLine(ask: NonNullable<WaitingEntry["ask"]>, now: Date): string {
  const age = since(ask.askedAt, now);
  return [
    `${ask.askedBy ?? "An agent"} asked${age ? ` ${age}` : ""}`,
    ask.dueBy ? `needed by ${formatShortDate(ask.dueBy, now)}` : null,
    ask.clientName ? `for ${ask.clientName}` : null,
  ].filter(Boolean).join(" · ");
}

/** One question an agent asked the owner: money and legal red, the rest amber; the question, options, why and an Answer link to the issue. */
export function AskCard({ item, linkFor, now }: { item: WaitingEntry; linkFor: LinkPropsFor; now: Date }) {
  const ask = item.ask!;
  const t = tone(askTone(ask.kind));
  const answer = linkOf(item.href, linkFor);
  return (
    <div
      data-ask={ask.kind}
      style={{ position: "relative", display: "grid", gap: 8, padding: "12px 12px 12px 15px", borderRadius: 12, border: `1px solid ${t.border}`, background: `linear-gradient(90deg, ${t.soft}, transparent 70%), ${tokens.bg}`, minWidth: 0 }}
    >
      <span aria-hidden="true" style={{ position: "absolute", left: -1, top: 10, bottom: 10, width: 3, borderRadius: 999, background: t.solid }} />
      <div style={{ display: "flex", gap: "6px 8px", alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
        <Pill tone={askTone(ask.kind)} icon={MessageCircleQuestionMark}>{ASK_KIND_LABEL[ask.kind]}</Pill>
        <span style={{ fontSize: 12, color: tokens.muted, minWidth: 0, overflowWrap: "anywhere" }}>{askedLine(ask, now)}</span>
      </div>
      <p style={{ margin: 0, fontSize: 14, fontWeight: 600, lineHeight: 1.45, overflowWrap: "anywhere" }}>{ask.question}</p>
      {ask.options.length ? (
        <ol style={{ margin: 0, paddingLeft: 22, listStyle: "decimal outside", fontSize: 13, lineHeight: 1.55, overflowWrap: "anywhere" }}>
          {ask.options.map((option, index) => (
            <li key={index}>{option}{index === 0 && ask.options.length > 1 ? <span style={{ color: tokens.muted }}> (recommended)</span> : null}</li>
          ))}
        </ol>
      ) : null}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", justifyContent: "space-between" }}>
        {ask.why ? <span style={{ fontSize: 12.5, color: tokens.muted, lineHeight: 1.45, flex: "1 1 220px", minWidth: 0, overflowWrap: "anywhere" }}>{ask.why}</span> : <span />}
        {answer ? <a {...answer} style={primaryLinkStyle} aria-label={`Answer: ${ask.question}`}>Answer →</a> : null}
      </div>
    </div>
  );
}

/** The right-hand "Open →" of a tappable row: the label on a wide screen, a chevron on a phone. Never wraps. */
function RowArrow({ label, narrow }: { label: string; narrow: boolean }) {
  return narrow
    ? <ChevronRight size={18} aria-hidden="true" style={{ color: tokens.muted, flexShrink: 0 }} />
    : <span style={{ fontSize: 13, fontWeight: 600, color: tokens.primary, whiteSpace: "nowrap" }}>{label} →</span>;
}

/**
 * One thing waiting on you. The whole row opens it, with the arrow kept on
 * the right (also on a phone). A count with examples (unassigned issues)
 * opens each example instead.
 */
export function WaitingRow({ item, linkFor, now, first }: { item: WaitingEntry; linkFor: LinkPropsFor; now: Date; first: boolean }) {
  const narrow = useIsNarrow();
  const t = tone(KIND_TONE[item.kind]);
  const examples = (item.examples ?? []).slice(0, narrow ? 3 : 5);
  const link = examples.length ? null : linkOf(item.href, linkFor);
  const meta = [item.why, item.sourceTitle, since(item.since, now)].filter(Boolean).join(" · ");
  const row: CSSProperties = {
    display: "grid",
    gridTemplateColumns: link ? "3px minmax(0, 1fr) auto" : "3px minmax(0, 1fr)",
    gap: 12,
    alignItems: "center",
    minHeight: 48,
    padding: "10px 4px",
    borderTop: first ? "none" : `1px solid ${tokens.border}`,
    color: tokens.fg,
    textDecoration: "none",
    minWidth: 0,
  };
  const body = (
    <>
      <span aria-hidden="true" style={{ alignSelf: "stretch", borderRadius: 999, background: t.solid, opacity: item.kind === "review" || item.kind === "other" ? 0.5 : 1 }} />
      <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
          <Pill tone={KIND_TONE[item.kind]} icon={KIND_ICON[item.kind]}>{KIND_LABEL[item.kind]}</Pill>
          <span style={{ fontSize: 13.5, fontWeight: 600, minWidth: 0, overflowWrap: "anywhere", flex: "1 1 200px" }}>{item.title}</span>
        </div>
        <div style={{ fontSize: 12.5, color: tokens.muted, lineHeight: 1.45, overflowWrap: "anywhere", ...(narrow ? clampLines(2) : {}) }}>{meta}</div>
        {examples.length ? (
          <ul style={{ margin: "2px 0 0", padding: 0, listStyle: "none", display: "grid", minWidth: 0 }}>
            {examples.map((example, index) => {
              const props = linkOf(example.href, linkFor);
              const line = (
                <>
                  <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                    <span style={{ color: tokens.primary, fontWeight: 600 }}>{example.title}</span>
                    {since(example.since, now) ? <span style={{ color: tokens.muted }}> · {since(example.since, now)}</span> : null}
                  </span>
                  {props ? <ChevronRight size={16} aria-hidden="true" style={{ color: tokens.muted, flexShrink: 0 }} /> : null}
                </>
              );
              const lineStyle: CSSProperties = { display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between", minHeight: 40, fontSize: 12.5, lineHeight: 1.45, color: tokens.fg, textDecoration: "none", borderTop: index ? `1px dashed ${tokens.border}` : "none", minWidth: 0 };
              return <li key={index}>{props ? <a {...props} className="pib-link-card" style={lineStyle}>{line}</a> : <span style={lineStyle}>{line}</span>}</li>;
            })}
          </ul>
        ) : null}
      </div>
      {link ? <RowArrow label={fixLabel(item.href, "Open")} narrow={narrow} /> : null}
    </>
  );
  return link
    ? <a {...link} className="pib-link-card" style={row}>{body}</a>
    : <div style={row}>{body}</div>;
}

export function WaitingList({ items, linkFor, now, limit }: { items: WaitingEntry[]; linkFor: LinkPropsFor; now: Date; limit?: number }) {
  if (items.length === 0) return <Muted>Nothing waits on you. The agents have what they need.</Muted>;
  const shown = limit ? items.slice(0, limit) : items;
  const asks = shown.filter((item) => item.ask);
  const rest = shown.filter((item) => !item.ask);
  return (
    <div style={{ display: "grid", gap: 14, minWidth: 0 }}>
      {asks.length ? (
        <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
          <span style={{ fontSize: 12, fontWeight: 650, color: tokens.muted, letterSpacing: 0.2 }}>{asks.length === 1 ? "A question from an agent" : `${asks.length} questions from agents`}: reply on the issue and it goes back to them</span>
          {asks.map((item) => <AskCard key={item.key} item={item} linkFor={linkFor} now={now} />)}
        </div>
      ) : null}
      {rest.length ? (
        <div style={{ display: "grid", minWidth: 0 }}>
          {rest.map((item, index) => <WaitingRow key={item.key} item={item} linkFor={linkFor} now={now} first={index === 0} />)}
        </div>
      ) : null}
      {limit && items.length > limit ? <Muted>And {items.length - limit} more.</Muted> : null}
    </div>
  );
}

/** Counts per kind as toned pills (for the Waiting card header); questions from agents first. */
export function WaitingKinds({ items }: { items: WaitingEntry[] }) {
  const asks = items.filter((item) => item.ask);
  const counts = new Map<WaitingEntry["kind"], number>();
  for (const item of items) if (!item.ask) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  if (counts.size === 0 && asks.length === 0) return null;
  const urgentAsks = asks.some((item) => item.ask && askTone(item.ask.kind) === "bad");
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {asks.length ? <Pill tone={urgentAsks ? "bad" : "warn"} size="sm" dot>{asks.length} {asks.length === 1 ? "question" : "questions"}</Pill> : null}
      {[...counts.entries()].map(([kind, count]) => <Pill key={kind} tone={KIND_TONE[kind]} size="sm" dot>{count} {(count === 1 ? KIND_LABEL[kind] : KIND_PLURAL[kind]).toLowerCase()}</Pill>)}
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

/**
 * One number. A packed value ("1 · R 11,500.00 (1 over a day)") shows the
 * amount with the count as its hint ("1 invoice, over a day old"); ISO dates
 * read "25 Oct". The module icon says where it comes from.
 */
export function KpiTile({ kpi, linkFor, size = "md", now }: { kpi: KpiEntry; linkFor: LinkPropsFor; size?: "sm" | "md"; now?: Date }) {
  const accent = moduleAccent(kpi.plugin);
  const toned = kpi.tone && kpi.tone !== "neutral" ? kpi.tone : undefined;
  const parts = kpiParts(kpi, now);
  return (
    <KpiCard
      size={size}
      label={kpiLabel(kpi.label, now)}
      value={parts.value}
      tone={kpi.tone ?? "neutral"}
      delta={kpi.delta ?? null}
      deltaTone={toned}
      hint={parts.hint ?? kpi.pluginTitle}
      icon={moduleKeyOf(kpi.plugin) ? accent.icon : undefined}
      iconAccent={moduleKeyOf(kpi.plugin) ? accent : undefined}
      link={linkOf(kpi.href, linkFor)}
    />
  );
}

/** A label with ISO dates as short dates ("VAT due (1 Sep to 31 Oct)"). */
function kpiLabel(label: string, now?: Date): string {
  return readableDates(label, now);
}

/**
 * A group of numbers (Money, Pipeline, …): the tiles it is given (by default
 * the ones that are not zero or need attention), two to a row in a half-width
 * panel, filling the row.
 */
export function KpiGroup({ group, kpis, linkFor, hidden = 0, now }: { group: keyof typeof KPI_GROUP_TITLES; kpis: KpiEntry[]; linkFor: LinkPropsFor; hidden?: number; now?: Date }) {
  const narrow = useIsNarrow();
  const bad = kpis.filter((k) => k.tone === "bad").length;
  const warn = kpis.filter((k) => k.tone === "warn").length;
  return (
    <Card
      title={KPI_GROUP_TITLES[group]}
      icon={KPI_GROUP_ICON[group]}
      actions={bad ? <Pill tone="bad" size="sm" dot>{bad} to fix</Pill> : warn ? <Pill tone="warn" size="sm" dot>{warn} to watch</Pill> : null}
    >
      {kpis.length === 0
        ? <Muted>{hidden ? `Nothing to report: ${hidden} ${hidden === 1 ? "number is" : "numbers are"} at zero.` : "No numbers reported yet."}</Muted>
        : <div style={grid(narrow ? 130 : 190, narrow ? 8 : 10, true)}>{kpis.map((kpi) => <KpiTile key={`${kpi.plugin}:${kpi.key}`} kpi={kpi} linkFor={linkFor} now={now} size={narrow ? "sm" : "md"} />)}</div>}
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
      <BarChart data={runColumns(days, now)} series={RUN_SERIES} title="Agent runs per day" unit="runs" height={88} emptyText="No runs in the last 14 days." />
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
  const items = activityItems(groups, linkFor);
  // Runs that failed logged nothing: the run line above and the Today card say so, not "nothing notable".
  const failed = withRuns.some((g) => g.runs.failed > 0);
  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      {runs ? <RunsChart runs={runs} now={now} /> : null}
      {withRuns.length > 0 ? (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }} aria-label="Runs in this period">
          {withRuns.map((g) => (
            <Anchor key={g.key} href={g.agentId ? `/agents/${g.agentId}` : null} linkFor={linkFor}>
              <Pill tone={g.runs.failed >= g.runs.total ? "bad" : g.runs.failed > 0 ? "warn" : "neutral"} icon={Bot}>{g.name}: {g.runs.failed >= g.runs.total ? `all ${g.runs.total} ${g.runs.total === 1 ? "run" : "runs"} failed` : `${g.runs.total} ${g.runs.total === 1 ? "run" : "runs"}${g.runs.failed ? `, ${g.runs.failed} failed` : ""}`}</Pill>
            </Anchor>
          ))}
        </div>
      ) : null}
      {groups.length === 0
        ? <Muted>No agent activity in this period.</Muted>
        : items.length
          ? <Timeline items={items} now={now} limit={12} />
          : failed ? null : <Muted>The agents ran; nothing notable was logged.</Muted>}
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

const AGENT_STATUS_LABEL: Record<string, string> = {
  active: "Active",
  idle: "Idle",
  running: "Running",
  paused: "Paused",
  error: "Error",
  pending_approval: "Awaiting approval",
  terminated: "Removed",
};

/** An agent's status in plain words ("Awaiting approval", not "pending_approval"). */
export function agentStatusLabel(status: string): string {
  return AGENT_STATUS_LABEL[status] ?? (status ? status.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "Unknown");
}

/** Where to read what went wrong: the agent's latest failed run, else the agent. */
export function agentRunHref(row: Pick<AgentRow, "id" | "urlKey" | "lastFailedRunId">): string {
  const agent = `/agents/${row.urlKey || row.id}`;
  return row.lastFailedRunId ? `${agent}/runs/${row.lastFailedRunId}` : agent;
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

/**
 * What is wrong with an agent, in plain words: "Stopped with an error ·
 * Open run →" (the adapter's own text under Details), or its budget.
 */
function AgentAlert({ row, linkFor }: { row: AgentRow; linkFor: LinkPropsFor }) {
  if (!row.alertText) return null;
  const bad = row.alert === "error" || (row.budgetRatio ?? 0) >= 1;
  return (
    <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
      <span style={{ fontSize: 12, lineHeight: 1.45, color: tone(bad ? "bad" : "warn").fg, overflowWrap: "anywhere" }}>
        {row.alertText}
        {row.alert === "error" ? (
          <>
            {" "}
            <a {...linkFor(agentRunHref(row))} style={{ color: tokens.primary, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" }}>{row.lastFailedRunId ? "Open run →" : "Open agent →"}</a>
          </>
        ) : null}
      </span>
      <Details raw={row.alertRaw} />
    </div>
  );
}

const th: CSSProperties = { textAlign: "left", fontSize: 11.5, fontWeight: 600, color: tokens.muted, padding: "8px 10px", borderBottom: `1px solid ${tokens.border}`, whiteSpace: "nowrap" };
const td: CSSProperties = { fontSize: 12.5, padding: "10px", borderBottom: `1px solid ${tokens.border}`, verticalAlign: "top" };

/** One agent as a card (phones). One status pill; what is wrong in plain words. */
export function AgentCard({ row, linkFor, now }: { row: AgentRow; linkFor: LinkPropsFor; now: Date }) {
  const status = agentTone(row.status);
  const alertTone = row.alert === "error" || (row.budgetRatio ?? 0) >= 1 ? "bad" : "warn";
  return (
    <div style={{ display: "grid", gap: 8, padding: 12, borderRadius: 12, border: `1px solid ${row.alert ? tone(alertTone).border : tokens.border}`, background: tokens.bg, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Anchor href={`/agents/${row.urlKey || row.id}`} linkFor={linkFor} style={{ fontWeight: 650, fontSize: 14, flex: "1 1 120px", minWidth: 0, overflowWrap: "anywhere" }}>{row.name}</Anchor>
        <Pill tone={status.tone} dot size="sm">{agentStatusLabel(row.status)}</Pill>
      </div>
      {row.title ? <div style={{ color: tokens.muted, fontSize: 12 }}>{row.title}</div> : null}
      <AgentAlert row={row} linkFor={linkFor} />
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
                </td>
                <td style={{ ...td, maxWidth: 260 }}>
                  <div style={{ display: "grid", gap: 4, justifyItems: "start", minWidth: 0 }}>
                    <Pill tone={status.tone} dot>{agentStatusLabel(row.status)}</Pill>
                    <AgentAlert row={row} linkFor={linkFor} />
                  </div>
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

/** Folded health groups name their checks on the summary line; open, the checks themselves show. */
const HEALTH_CSS = ".pib-health-group[open] .pib-health-titles{display:none}";

/**
 * System health: the failing and warning checks, grouped by plugin. A plugin
 * with a problem opens; one with only warnings is one line naming them (open
 * it for the details and fixes). The ok checks (and an up-to-date backup) sit
 * behind "Show all". A raw service error reads as a plain sentence, with the
 * raw text under Details.
 */
export function HealthList({ groups, linkFor, now, backup, showAll = false }: { groups: HealthGroup[]; linkFor: LinkPropsFor; now: Date; backup: BackupInfo | null; showAll?: boolean }) {
  const shown = groups
    .map((group) => ({ ...group, checks: showAll ? group.checks : group.checks.filter((check) => check.status !== "ok") }))
    .filter((group) => group.checks.length > 0);
  const showBackup = backup && (showAll || backup.status !== "ok");
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <style>{HEALTH_CSS}</style>
      {showBackup && backup ? (
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 13, padding: "10px 12px", borderRadius: 12, border: `1px solid ${backup.status === "ok" ? tokens.border : tone(backup.status).border}`, background: backup.status === "ok" ? tokens.bg : tone(backup.status).soft }}>
          <Light status={backup.status} label="" />
          <strong>Last database backup</strong>
          <span style={{ color: tokens.muted }}>{backup.text}{backup.status !== "ok" ? " Backups run hourly; check the server." : ""}</span>
        </div>
      ) : null}
      {groups.length === 0 ? <Muted>No plugin has reported health yet.</Muted> : shown.length === 0 ? <Muted>Every check passes.</Muted> : shown.map((group) => {
        const all = groups.find((g) => g.plugin === group.plugin)?.checks ?? group.checks;
        const failing = all.filter((c) => c.status !== "ok").length;
        const t = tone(group.status);
        const Glyph = groupIcon(group.plugin);
        return (
          <details key={group.plugin} className="pib-health-group" open={group.status === "bad"} style={{ borderRadius: 12, border: `1px solid ${group.status === "ok" ? tokens.border : t.border}`, background: group.status === "ok" ? tokens.bg : `linear-gradient(180deg, ${t.soft}, transparent 80%), ${tokens.bg}`, padding: "10px 12px" }}>
            <summary style={{ cursor: "pointer", display: "grid", gap: 2, listStyle: "none", minHeight: 28, minWidth: 0 }}>
              <span style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
                <Light status={group.status} label="" />
                <Glyph size={15} strokeWidth={2} color={tokens.muted} aria-hidden="true" style={{ flexShrink: 0 }} />
                <strong style={{ fontSize: 13.5 }}>{group.title}</strong>
                <span style={{ fontSize: 12.5, color: failing ? t.fg : tokens.muted, fontWeight: failing ? 600 : 400 }}>
                  {failing === 0 ? `${all.length} ${all.length === 1 ? "check" : "checks"} ok` : `${failing} of ${all.length} need attention`}
                </span>
              </span>
              <span className="pib-health-titles" style={{ fontSize: 12.5, color: tokens.muted, paddingLeft: 43, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {group.checks.map((check) => check.title).join(" · ")}
              </span>
            </summary>
            <div style={{ display: "grid", marginTop: 8 }}>
              {group.checks.map((check) => {
                const plain = check.raw ? { text: check.detail ?? "", raw: check.raw } : plainDetail(check.detail);
                return (
                  <div key={check.key} style={{ display: "grid", gap: 3, padding: "8px 0", borderTop: `1px solid ${tokens.border}` }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <Light status={check.status} label="" size={8} />
                      <span style={{ fontSize: 13, fontWeight: 600, flex: "1 1 180px", minWidth: 0, overflowWrap: "anywhere" }}>{check.title}</span>
                      {check.status !== "ok" ? <OpenLink href={check.href} linkFor={linkFor} label={fixLabel(check.href, "Fix")} /> : null}
                    </div>
                    {plain?.text ? <div style={{ fontSize: 12.5, color: tokens.muted, overflowWrap: "anywhere", paddingLeft: 16 }}>{plain.text}{check.since && check.status !== "ok" ? ` Since ${since(check.since, now)}.` : ""}</div> : null}
                    {check.fix && check.status !== "ok" ? <div style={{ fontSize: 12.5, overflowWrap: "anywhere", paddingLeft: 16 }}><span style={{ color: tokens.muted }}>Fix: </span>{check.fix}</div> : null}
                    {plain?.raw ? <div style={{ paddingLeft: 16 }}><Details raw={plain.raw} /></div> : null}
                  </div>
                );
              })}
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
