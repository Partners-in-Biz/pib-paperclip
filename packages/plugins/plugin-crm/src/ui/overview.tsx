/**
 * Presentational pieces of the CRM pages: the overview dashboard, toned
 * statuses, the activity timeline and the lead score card. No host hooks.
 */
import type { ReactNode } from "react";
import {
  BarChart,
  Building2,
  ChartColumn,
  CircleAlert,
  CircleCheck,
  Contact,
  Flame,
  Funnel,
  Mail,
  MailCheck,
  MessageSquare,
  KpiCard,
  Pill,
  ProgressBar,
  ProgressRing,
  SectionCard,
  StackedBar,
  Target,
  Timeline,
  TrendingUp,
  Users,
  Workflow,
  fluidColumns,
  formatMoney,
  formatMoneyCompact,
  formatMonth,
  tokens,
  tone,
  type LucideIcon,
  type TimelineItem,
  type ToneInput,
} from "@partnersinbiz/pib-plugin-ui";
import { LEAD_DIMENSION_LABELS, LEAD_DIMENSIONS, leadBand, leadLevelLabel, type LeadScore } from "../lead-levels.js";
import { leadBands, recentDelta, type CrmSeries } from "../series.js";

// ---------------------------------------------------------------------------
// Status tones (one mapping for every CRM page)
// ---------------------------------------------------------------------------

export const LIFECYCLES = ["lead", "prospect", "customer", "churned"] as const;
export const LIFECYCLE_LABEL: Record<string, string> = { lead: "Lead", prospect: "Prospect", customer: "Customer", churned: "Churned" };
/** Lead: in progress (blue). Prospect: in review (amber). Customer: active (green). Churned: gone (grey). */
export const LIFECYCLE_TONE: Record<string, ToneInput> = { lead: "info", prospect: "warn", customer: "ok", churned: "neutral" };

export function LifecyclePill({ lifecycle, size }: { lifecycle: string; size?: "sm" | "md" }) {
  return <Pill tone={LIFECYCLE_TONE[lifecycle] ?? "neutral"} size={size} dot>{LIFECYCLE_LABEL[lifecycle] ?? lifecycle}</Pill>;
}

/** Open stages are in progress, won is done, lost failed. */
export const STAGE_TONE: Record<string, ToneInput> = { open: "info", won: "ok", lost: "bad" };
export const STAGE_KIND_LABEL: Record<string, string> = { open: "Open", won: "Won", lost: "Lost" };

export function StagePill({ name, kind, size }: { name: string; kind: string; size?: "sm" | "md" }) {
  return <Pill tone={STAGE_TONE[kind] ?? "neutral"} size={size} dot>{name}</Pill>;
}

export const BAND_TONE: Record<string, ToneInput> = { hot: "ok", warm: "warn", cold: "info" };
export const BAND_LABEL: Record<string, string> = { hot: "Hot", warm: "Warm", cold: "Cold" };

export function BandPill({ band }: { band: string }) {
  return <Pill tone={BAND_TONE[band] ?? "neutral"} icon={band === "hot" ? Flame : undefined}>{BAND_LABEL[band] ?? band}</Pill>;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface OverviewStage { id: string; name: string; kind: string; position: number }
export interface OverviewSummary {
  companyCount: number;
  contactCount: number;
  dealCount: number;
  openDealCount: number;
  openPipelineByCurrency: Record<string, number>;
  byStage: Record<string, { count: number; amountMinor: number }>;
  accountLifecycle: Record<string, number>;
  contactLifecycle: Record<string, number>;
}

export interface AttentionItem { id: string; label: string; detail?: string; onClick: () => void }

/** One kind of thing that needs a person, e.g. "Deals without a value". */
export interface NeedsGroup { key: string; title: string; action: string; items: AttentionItem[] }

/** "Sep" for a chart axis, "Sep 2026" for its tooltip (`month` is `YYYY-MM`). */
function monthLabel(month: string, long = false): string {
  const full = formatMonth(month);
  return long ? full : full.split(" ")[0] ?? full;
}

/** The currency with the largest open pipeline, else the first one seen, else ZAR. */
export function mainCurrency(summary: OverviewSummary | undefined, series: CrmSeries | undefined): string {
  const open = Object.entries(summary?.openPipelineByCurrency ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (open) return open;
  for (const month of series?.wonByMonth ?? []) {
    const first = Object.keys(month.amountMinor)[0];
    if (first) return first;
  }
  return "ZAR";
}


function sum(values: number[]): number {
  return values.reduce((total, v) => total + v, 0);
}

function signed(value: number, suffix: string): string | null {
  // "No change vs last month", not "No change deals vs last month".
  if (value === 0) return `No change ${suffix.replace(/^\S+\s+(?=vs\b)/, "")}`;
  return `${value > 0 ? "+" : "−"}${Math.abs(value)} ${suffix}`;
}

export function CrmOverview({ summary, series, stages, contacts, needs, unlinked, onTab }: {
  summary: OverviewSummary | undefined;
  series: CrmSeries | undefined;
  stages: OverviewStage[];
  contacts: Array<{ leadScore?: LeadScore | null }>;
  /** What needs a person now (follow-ups due, deals without a value, email waiting for approval). */
  needs: NeedsGroup[];
  /** Contacts not linked to a company: worth a look, not a problem (a sole trader stays unlinked). */
  unlinked: AttentionItem[];
  onTab?: (tab: "companies" | "contacts" | "deals") => void;
}) {
  const currency = mainCurrency(summary, series);
  const won = series?.wonByMonth ?? [];
  const thisMonth = won.at(-1);
  const lastMonth = won.at(-2);
  const wonAmount = thisMonth?.amountMinor[currency] ?? 0;
  const wonCountDelta = thisMonth && lastMonth ? thisMonth.count - lastMonth.count : null;
  const newContacts = series?.newContactsByWeek ?? [];
  const newDeals = series?.newDealsByWeek ?? [];
  const bands = leadBands(contacts);
  const openPipeline = summary?.openPipelineByCurrency[currency] ?? 0;
  const otherCurrencies = Object.keys(summary?.openPipelineByCurrency ?? {}).filter((c) => c !== currency);
  const ordered = [...stages].sort((a, b) => a.position - b.position);
  const openStages = ordered.filter((s) => s.kind === "open");
  const closedStages = ordered.filter((s) => s.kind !== "open");
  const wonCount12 = sum(won.map((m) => m.count));
  const wonAmount12 = sum(won.map((m) => m.amountMinor[currency] ?? 0));
  const scored = bands.hot + bands.warm + bands.cold;

  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      {/* What needs you comes first: the answer to "what needs me?" before any number. */}
      <NeedsYouCard groups={needs} />

      <div style={{ display: "grid", gridTemplateColumns: fluidColumns(160), gap: 10 }}>
        <KpiCard
          label="Open pipeline"
          value={formatMoney(openPipeline, currency)}
          hint={`${summary?.openDealCount ?? 0} open ${summary?.openDealCount === 1 ? "deal" : "deals"}${otherCurrencies.length ? ` · also ${otherCurrencies.join(", ")}` : ""}`}
          icon={Funnel}
          sparkline={newDeals}
        />
        <KpiCard
          label="Won this month"
          value={formatMoney(wonAmount, currency)}
          tone={thisMonth?.count ? "ok" : "neutral"}
          delta={wonCountDelta === null ? null : signed(wonCountDelta, wonCountDelta === 1 || wonCountDelta === -1 ? "deal vs last month" : "deals vs last month")}
          hint={`${thisMonth?.count ?? 0} ${thisMonth?.count === 1 ? "deal" : "deals"}`}
          icon={Target}
          sparkline={won.map((m) => m.count)}
        />
        <KpiCard
          label="Contacts"
          value={summary?.contactCount ?? 0}
          delta={newContacts.length ? signed(recentDelta(newContacts, 4), "new vs prior 4 weeks") : null}
          deltaTone={newContacts.length && recentDelta(newContacts, 4) === 0 ? "neutral" : undefined}
          hint={`${sum(newContacts.slice(-4))} added in 4 weeks`}
          icon={Contact}
          sparkline={newContacts}
          link={onTab ? { href: "#contacts", onClick: (e) => { e.preventDefault(); onTab("contacts"); } } : null}
        />
        <KpiCard
          label="Companies"
          value={summary?.companyCount ?? 0}
          hint={`${summary?.accountLifecycle.customer ?? 0} ${summary?.accountLifecycle.customer === 1 ? "customer" : "customers"}`}
          icon={Building2}
          link={onTab ? { href: "#companies", onClick: (e) => { e.preventDefault(); onTab("companies"); } } : null}
        />
        <KpiCard
          label="Hot leads"
          value={bands.hot}
          tone={bands.hot ? "ok" : "neutral"}
          hint={scored ? `${scored} of ${contacts.length} scored` : "No contact scored yet"}
          icon={Flame}
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: fluidColumns(320), gap: 16, alignItems: "start" }}>
        <SectionCard
          title="Pipeline by stage"
          icon={Funnel}
          subtitle={`Deal value per stage in ${currency}. Open stages first.`}
          actions={onTab ? <LinkButton onClick={() => onTab("deals")}>Deals →</LinkButton> : null}
        >
          {ordered.length === 0 ? <Muted>No stages yet.</Muted> : (
            <div style={{ display: "grid", gap: 14 }}>
              <BarChart
                bare
                title="Open stages"
                items={openStages.map((stage, index) => ({
                  label: `${stage.name} · ${summary?.byStage[stage.id]?.count ?? 0}`,
                  value: summary?.byStage[stage.id]?.amountMinor ?? 0,
                  // A funnel: the accent deepens towards the close.
                  color: `color-mix(in oklab, ${tone("accent").solid} ${Math.round(50 + (50 * (index + 1)) / Math.max(openStages.length, 1))}%, transparent)`,
                }))}
                formatValue={(v) => formatMoney(v, currency)}
              />
              {closedStages.length ? (
                <BarChart
                  bare
                  title="Closed"
                  items={closedStages.map((stage) => ({
                    label: `${stage.name} · ${summary?.byStage[stage.id]?.count ?? 0}`,
                    value: summary?.byStage[stage.id]?.amountMinor ?? 0,
                    tone: STAGE_TONE[stage.kind],
                  }))}
                  formatValue={(v) => formatMoney(v, currency)}
                />
              ) : null}
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Deals won per month"
          icon={ChartColumn}
          subtitle={wonCount12 ? `${wonCount12} ${wonCount12 === 1 ? "deal" : "deals"} worth ${formatMoney(wonAmount12, currency)} in 12 months.` : "No deals won in the last 12 months."}
        >
          <BarChart
            data={won.map((m) => ({ label: monthLabel(m.month), title: `${monthLabel(m.month, true)} · ${m.count} ${m.count === 1 ? "deal" : "deals"}`, values: { won: m.amountMinor[currency] ?? 0 } }))}
            series={[{ key: "won", label: `Won (${currency})`, tone: "ok" }]}
            formatValue={(v) => formatMoneyCompact(v, currency)}
            title="Deals won per month"
            height={110}
            legend={false}
            emptyText="Won deals appear here, one bar per month."
          />
          {wonCount12 ? <Muted>Dated by the deal's last update.</Muted> : null}
        </SectionCard>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: fluidColumns(320), gap: 16, alignItems: "start" }}>
        <SectionCard title="Lifecycle" icon={Users} subtitle="Where your contacts and companies stand.">
          <Distribution title="Contacts" counts={summary?.contactLifecycle ?? {}} />
          <Distribution title="Companies" counts={summary?.accountLifecycle ?? {}} />
        </SectionCard>
        <SectionCard title="Lead scores" icon={TrendingUp} subtitle={scored ? `How well ${scored} scored ${scored === 1 ? "contact fits" : "contacts fit"} and how ready ${scored === 1 ? "it is" : "they are"} to buy.` : "Score a contact from its page to see it here."}>
          <StackedBar
            title="Lead score distribution"
            segments={[
              { key: "hot", label: "Hot", value: bands.hot, tone: "ok" },
              { key: "warm", label: "Warm", value: bands.warm, tone: "warn" },
              { key: "cold", label: "Cold", value: bands.cold, tone: "info" },
              { key: "unscored", label: "Not scored", value: bands.unscored, tone: "neutral" },
            ]}
          />
        </SectionCard>
      </div>

      {unlinked.length > 0 ? (
        <div style={{ display: "grid", gridTemplateColumns: fluidColumns(320), gap: 16, alignItems: "start" }}>
          <AttentionCard
            title="Contacts without a company"
            subtitle="Link each one to the company they work for. A sole trader can stay as they are."
            icon={Contact}
            tone="info"
            action="Open"
            items={unlinked}
          />
        </div>
      ) : null}
    </div>
  );
}

/** "Needs you": the only warning block on the overview. One calm line when nothing does. */
export function NeedsYouCard({ groups }: { groups: NeedsGroup[] }) {
  const shown = groups.filter((group) => group.items.length > 0);
  const total = sum(shown.map((group) => group.items.length));
  if (total === 0) {
    return (
      <p style={{ margin: 0, display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: tokens.muted }}>
        <CircleCheck size={15} aria-hidden="true" style={{ color: tone("ok").solid, flexShrink: 0 }} />
        Nothing in the CRM needs you right now.
      </p>
    );
  }
  return (
    <SectionCard title="Needs you" icon={CircleAlert} tone="warn" strip actions={<Pill tone="warn" size="sm" dot>{total}</Pill>}>
      {shown.map((group) => (
        <div key={group.key} style={{ display: "grid", gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: tokens.muted }}>{group.title} · {group.items.length}</span>
          <AttentionList items={group.items} action={group.action} tone="warn" />
        </div>
      ))}
    </SectionCard>
  );
}

function Distribution({ title, counts }: { title: string; counts: Record<string, number> }) {
  const keys = [...LIFECYCLES, ...Object.keys(counts).filter((k) => !(LIFECYCLES as readonly string[]).includes(k))];
  return (
    <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: tokens.muted }}>{title}</span>
      <StackedBar
        title={`${title} by lifecycle`}
        segments={keys.map((key) => ({ key, label: LIFECYCLE_LABEL[key] ?? key, value: counts[key] ?? 0, tone: LIFECYCLE_TONE[key] ?? "neutral" }))}
      />
    </div>
  );
}

/** A short list of records to look at. `tone` "info" is a list to check, not a problem. */
export function AttentionCard({ title, subtitle, icon, tone: t = "warn", action = "Fix", items }: {
  title: string;
  subtitle?: string;
  icon: LucideIcon;
  tone?: "warn" | "info";
  action?: string;
  items: AttentionItem[];
}) {
  const warn = t === "warn";
  return (
    <SectionCard
      title={title}
      subtitle={subtitle}
      icon={warn ? CircleAlert : icon}
      tone={warn ? "warn" : undefined}
      strip={warn}
      actions={<Pill tone={warn ? "warn" : "neutral"} size="sm" dot={warn}>{warn ? `${items.length} to fix` : `${items.length} to check`}</Pill>}
    >
      <AttentionList items={items} action={action} tone={t} />
    </SectionCard>
  );
}

function AttentionList({ items, action, tone: t }: { items: AttentionItem[]; action: string; tone: "warn" | "info" }) {
  return (
    <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid" }}>
      {items.slice(0, 8).map((item, index) => (
        <li key={item.id} style={{ borderTop: index === 0 ? "none" : `1px solid ${tokens.border}` }}>
          <button
            type="button"
            onClick={item.onClick}
            className="pib-link-card"
            style={{ appearance: "none", border: "none", background: "transparent", color: tokens.fg, padding: "8px 4px", minHeight: 40, width: "100%", textAlign: "left", fontSize: 13, fontWeight: 550, cursor: "pointer", fontFamily: "inherit", display: "flex", gap: 8, alignItems: "center", minWidth: 0, borderRadius: 8 }}
          >
            <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: t === "warn" ? tone("warn").solid : tokens.border, flexShrink: 0 }} />
            <span style={{ flex: "1 1 auto", minWidth: 0, display: "grid", gap: 1 }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.label}</span>
              {item.detail ? <span style={{ fontSize: 12, fontWeight: 500, color: tokens.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.detail}</span> : null}
            </span>
            <span style={{ color: tokens.primary, fontWeight: 600, fontSize: 12.5, whiteSpace: "nowrap" }}>{action} →</span>
          </button>
        </li>
      ))}
      {items.length > 8 ? <li><Muted>And {items.length - 8} more.</Muted></li> : null}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export interface ActivityLike { id: string; kind: string; body: string; createdAt: string; threadId?: string | null }

export const ACTIVITY_LABELS: Record<string, string> = {
  email_received: "Email received",
  email_sent: "Email sent",
  reply_classified: "Reply read",
  deal_moved: "Deal moved",
  deal_won: "Deal won",
  quote_accepted: "Quote accepted",
  invoice_paid: "Invoice paid",
  lead_captured: "Lead",
  email_suppressed: "Opted out",
  email_status: "Email status",
  note: "Note",
  care_event: "Client care",
  call: "Call",
  meeting: "Meeting",
  message: "Message",
  task: "Task",
};

const ACTIVITY_LOOK: Record<string, { tone: ToneInput; icon?: LucideIcon }> = {
  email_received: { tone: "info", icon: Mail },
  email_sent: { tone: "ok", icon: MailCheck },
  reply_classified: { tone: "accent", icon: MessageSquare },
  deal_moved: { tone: "accent", icon: Workflow },
  deal_won: { tone: "ok", icon: Target },
  quote_accepted: { tone: "ok", icon: Target },
  invoice_paid: { tone: "ok", icon: Target },
  lead_captured: { tone: "info", icon: Flame },
  email_suppressed: { tone: "warn", icon: CircleAlert },
  email_status: { tone: "warn", icon: CircleAlert },
  note: { tone: "neutral", icon: MessageSquare },
  care_event: { tone: "info", icon: MessageSquare },
};

export function activityItems(items: ActivityLike[]): TimelineItem[] {
  return items.map((item) => {
    const look = ACTIVITY_LOOK[item.kind] ?? { tone: "neutral" as const };
    const label = ACTIVITY_LABELS[item.kind] ?? item.kind.replace(/_/g, " ");
    return {
      id: item.id,
      at: item.createdAt,
      title: item.kind === "deal_moved" || item.kind === "note" || item.kind === "care_event" ? item.body : label,
      detail: item.kind === "deal_moved" || item.kind === "note" || item.kind === "care_event" ? undefined : <span style={{ whiteSpace: "pre-wrap", color: tokens.fg }}>{item.body}</span>,
      meta: (
        <>
          {item.kind === "deal_moved" || item.kind === "note" || item.kind === "care_event" ? <Pill size="sm" tone={look.tone}>{label}</Pill> : null}
          {item.threadId ? <a href={`https://mail.google.com/mail/u/0/#all/${encodeURIComponent(item.threadId)}`} target="_blank" rel="noreferrer" style={{ color: tokens.primary, fontWeight: 600 }}>Open in Gmail ↗</a> : null}
        </>
      ),
      tone: look.tone,
      icon: look.icon,
    };
  });
}

export function ActivityTimeline({ items, limit }: { items: ActivityLike[]; limit?: number }) {
  return <Timeline items={activityItems(items)} limit={limit} empty="No activity yet." />;
}

// ---------------------------------------------------------------------------
// Lead score
// ---------------------------------------------------------------------------

/** Fit, intent and urgency (each 0-3) as one 0-1 ratio. */
export function leadRatio(score: LeadScore): number {
  return Math.max(0, Math.min(1, (score.fit + score.intent + score.urgency) / 9));
}

export function LeadScoreCard({ score, when }: { score: LeadScore; when: string }) {
  const band = leadBand(score);
  return (
    <div style={{ display: "grid", gap: 12, padding: 12, borderRadius: 12, border: `1px solid ${tone(BAND_TONE[band]).border}`, background: `linear-gradient(180deg, ${tone(BAND_TONE[band]).soft}, transparent 80%), ${tokens.bg}`, minWidth: 0 }}>
      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
        <ProgressRing value={leadRatio(score)} label="Lead score" tone={BAND_TONE[band]} size={64} />
        <div style={{ display: "grid", gap: 4, minWidth: 0, flex: "1 1 140px" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <strong style={{ fontSize: 14 }}>Lead score</strong>
            <BandPill band={band} />
          </div>
          <span style={{ fontSize: 12, color: tokens.muted }}>{Math.round(score.confidence * 100)}% sure{when ? ` · ${when}` : ""}</span>
        </div>
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {LEAD_DIMENSIONS.map((dimension) => (
          <ProgressBar
            key={dimension}
            size="sm"
            value={score[dimension] / 3}
            tone={score[dimension] >= 2 ? "ok" : score[dimension] >= 1 ? "warn" : "neutral"}
            label={LEAD_DIMENSION_LABELS[dimension]}
            valueText={`${leadLevelLabel(dimension, score[dimension])} · ${score[dimension].toFixed(1)}/3`}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small bits
// ---------------------------------------------------------------------------

export function Muted({ children }: { children: ReactNode }) {
  return <p style={{ margin: 0, fontSize: 13, color: tokens.muted, lineHeight: 1.45 }}>{children}</p>;
}

function LinkButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} style={{ appearance: "none", border: "none", background: "transparent", padding: 0, fontSize: 13, fontWeight: 600, color: tokens.primary, cursor: "pointer", fontFamily: "inherit" }}>
      {children}
    </button>
  );
}
