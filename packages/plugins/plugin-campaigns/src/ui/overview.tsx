/**
 * Presentational pieces of the Campaigns page: the overview dashboard and
 * toned statuses. No host hooks.
 */
import type { ReactNode } from "react";
import {
  BarChart,
  ChartColumn,
  CircleAlert,
  CircleCheckBig,
  EmptyState,
  KpiCard,
  MailCheck,
  MessageSquare,
  Pill,
  ProgressBar,
  SectionCard,
  Send,
  Sparkles,
  StackedBar,
  Users,
  fluidColumns,
  formatShortDate,
  tokens,
  type ToneInput,
} from "@partnersinbiz/pib-plugin-ui";
import { emptyTotals, providerReport, replyRate, type CampaignEventTotals, type CampaignSeries, type SendWeek } from "../series.js";

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

export const STATUS_TONE: Record<string, ToneInput> = { active: "ok", completed: "ok", draft: "info", scheduled: "info", paused: "warn" };
export const STATUS_LABEL: Record<string, string> = { active: "Active", completed: "Completed", draft: "Draft", scheduled: "Scheduled", paused: "Paused" };

export function StatusPill({ status }: { status: string }) {
  return <Pill tone={STATUS_TONE[status] ?? "neutral"} dot>{STATUS_LABEL[status] ?? status}</Pill>;
}

export interface OverviewCampaign {
  id: string;
  name: string;
  status: string;
  steps: Array<{ variant?: "a" | "b" }>;
  stats: { enrolled: number; running: number; done: number };
  approvalIssueId: string | null;
  approvalStatus: string | null;
  winnerVariant?: "a" | "b" | null;
}

export function awaitingApproval(campaign: OverviewCampaign): boolean {
  return campaign.status === "draft" && !!campaign.approvalIssueId && campaign.approvalStatus !== "done";
}

export function percent(value: number | null, digits = 1): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits).replace(/\.0$/, "")}%`;
}

/** Long campaign names cut to fit a chart label. */
export function short(name: string, max = 40): string {
  return name.length > max ? `${name.slice(0, max - 1).trimEnd()}…` : name;
}

function sum(values: number[]): number {
  return values.reduce((total, v) => total + v, 0);
}

function weekColumns(weeks: SendWeek[]) {
  return weeks.map((week) => ({
    label: formatShortDate(week.start),
    title: `Week of ${formatShortDate(week.start)}`,
    values: { sent: week.sent, replies: week.replies },
  }));
}

/** Deliverability tone for a bounce rate: ok below 2%, warn below 5%, then bad. */
export function bounceTone(rate: number | null): ToneInput {
  if (rate === null) return "neutral";
  return rate >= 0.05 ? "bad" : rate >= 0.02 ? "warn" : "ok";
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export function CampaignsOverview({ campaigns, series, suppressed = 0, onNew, onList, onAb, onOpen }: {
  campaigns: OverviewCampaign[];
  series: CampaignSeries | undefined;
  /** Addresses on the do-not-email list (shared with the CRM and the Mailbox). */
  suppressed?: number;
  onNew?: ReactNode;
  onList?: () => void;
  onAb?: (campaignId: string) => void;
  /** Opens a campaign's detail (every email, who gets it and when). */
  onOpen?: (campaignId: string) => void;
}) {
  if (campaigns.length === 0) {
    return (
      <EmptyState
        title="No campaigns yet"
        description="Create a campaign and add its emails, then request approval. It launches by itself once a person approves. Sends and replies show up here."
        action={onNew}
      />
    );
  }
  const weeks = series?.weeks ?? [];
  const byCampaign = series?.byCampaign ?? {};
  const totals = (id: string): CampaignEventTotals => byCampaign[id] ?? emptyTotals();
  const sentWeeks = weeks.map((w) => w.sent);
  const recentSent = sum(sentWeeks.slice(-4));
  const priorSent = sum(sentWeeks.slice(-8, -4));
  const recentReplies = sum(weeks.slice(-4).map((w) => w.replies));
  const priorReplies = sum(weeks.slice(-8, -4).map((w) => w.replies));
  const recentBounces = sum(weeks.slice(-4).map((w) => w.bounces));
  const rateNow = recentSent ? recentReplies / recentSent : null;
  const ratePrior = priorSent ? priorReplies / priorSent : null;
  const rateDelta = rateNow !== null && ratePrior !== null ? (rateNow - ratePrior) * 100 : null;
  const bounceRate = recentSent ? recentBounces / recentSent : null;
  const provider = providerReport(byCampaign);
  const active = campaigns.filter((c) => c.status === "active").length;
  const waiting = campaigns.filter(awaitingApproval).length;
  const running = sum(campaigns.map((c) => c.stats.running));
  const done = sum(campaigns.map((c) => c.stats.done));
  const enrolled = sum(campaigns.map((c) => c.stats.enrolled));
  const stopped = Math.max(0, enrolled - running - done);
  const withSends = campaigns
    .map((c) => ({ campaign: c, t: totals(c.id) }))
    .filter((row) => row.t.sent > 0)
    .sort((a, b) => (replyRate(b.t) ?? 0) - (replyRate(a.t) ?? 0));
  const abTests = campaigns.filter((c) => c.steps.some((step) => step.variant === "b"));
  const allSent = sum(weeks.map((w) => w.sent));
  const allReplies = sum(weeks.map((w) => w.replies));

  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      <div style={{ display: "grid", gridTemplateColumns: fluidColumns(160), gap: 10 }}>
        <KpiCard
          label="Active campaigns"
          value={active}
          tone={active ? "ok" : "neutral"}
          hint={waiting ? `${waiting} awaiting approval` : `${campaigns.length} in total`}
          icon={Send}
          link={onList ? { href: "#campaigns", onClick: (e) => { e.preventDefault(); onList(); } } : null}
        />
        <KpiCard
          label="Emails sent"
          value={recentSent}
          delta={recentSent || priorSent ? `${recentSent - priorSent >= 0 ? "+" : "−"}${Math.abs(recentSent - priorSent)} vs prior 4 weeks` : null}
          deltaTone={recentSent === priorSent ? "neutral" : undefined}
          hint="Last 4 weeks"
          icon={MailCheck}
          sparkline={sentWeeks}
        />
        <KpiCard
          label="Reply rate"
          value={percent(rateNow)}
          delta={rateDelta === null ? null : `${rateDelta >= 0 ? "+" : "−"}${Math.abs(rateDelta).toFixed(1)} pts`}
          deltaTone={rateDelta === 0 ? "neutral" : undefined}
          hint={`${recentReplies} ${recentReplies === 1 ? "reply" : "replies"} in 4 weeks`}
          icon={MessageSquare}
          sparkline={weeks.map((w) => (w.sent ? (w.replies / w.sent) * 100 : 0))}
        />
        <KpiCard
          label="Bounce rate"
          value={percent(bounceRate)}
          tone={bounceTone(bounceRate) === "ok" ? "neutral" : bounceTone(bounceRate)}
          hint={`${bounceRate === null ? "Nothing sent yet" : bounceRate >= 0.02 ? "Clean the list before the next send" : "Healthy"}${provider.line ? `. ${provider.line}` : ""}`}
          icon={CircleAlert}
          invert
        />
        <KpiCard label="In a campaign now" value={running} hint={`${enrolled} enrolled in total`} icon={Users} />
        <KpiCard label="Do not email" value={suppressed} hint="Unsubscribed or bounced; never enrolled or emailed" icon={CircleAlert} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: fluidColumns(320), gap: 16, alignItems: "start" }}>
        <SectionCard
          title="Sends and replies per week"
          icon={ChartColumn}
          subtitle={allSent ? `${allSent} sent and ${allReplies} ${allReplies === 1 ? "reply" : "replies"} in 12 weeks (${percent(allReplies / allSent)}).` : "Last 12 weeks"}
        >
          <BarChart
            data={weekColumns(weeks)}
            series={[
              { key: "sent", label: "Sent", tone: "accent" },
              { key: "replies", label: "Replies", tone: "ok" },
            ]}
            stacked={false}
            height={110}
            unit="emails"
            title="Sends and replies per week"
            emptyText="Nothing sent in the last 12 weeks."
          />
        </SectionCard>

        <SectionCard title="Reply rate per campaign" icon={MessageSquare} subtitle="Replies ÷ emails sent, all time. Best first.">
          {withSends.length === 0 ? <Muted>No campaign has sent an email yet.</Muted> : (
            <BarChart
              bare
              title="Reply rate"
              items={withSends.slice(0, 8).map(({ campaign, t }) => ({ label: `${short(campaign.name)} · ${t.sent} sent`, value: (replyRate(t) ?? 0) * 100, tone: "accent" as const }))}
              formatValue={(v) => `${v.toFixed(1).replace(/\.0$/, "")}%`}
            />
          )}
        </SectionCard>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: fluidColumns(320), gap: 16, alignItems: "start" }}>
        <SectionCard title="Enrollments" icon={Users} subtitle={`${enrolled} ${enrolled === 1 ? "contact" : "contacts"} across ${campaigns.length} ${campaigns.length === 1 ? "campaign" : "campaigns"}.`}>
          <StackedBar
            title="Enrollment status"
            segments={[
              { key: "running", label: "In progress", value: running, tone: "info" },
              { key: "done", label: "Finished", value: done, tone: "ok" },
              { key: "stopped", label: "Stopped (replied, unsubscribed or removed)", value: stopped, tone: "neutral" },
            ]}
          />
          <div style={{ display: "grid", gap: 10 }}>
            {campaigns.filter((c) => c.stats.enrolled > 0).slice(0, 6).map((c) => (
              <ProgressBar
                key={c.id}
                size="sm"
                done={c.stats.done}
                total={c.stats.enrolled}
                label={<span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}><StatusPill status={c.status} /> <CampaignName name={c.name} max={34} onOpen={onOpen ? () => onOpen(c.id) : undefined} /></span>}
                valueText={`${c.stats.done} of ${c.stats.enrolled} finished`}
              />
            ))}
          </div>
        </SectionCard>

        <SectionCard title="A/B tests" icon={Sparkles} subtitle={abTests.length ? "Reply rate of variant A against B." : "Add a B variant to a step to test two subject lines."}>
          {abTests.length === 0 ? <Muted>No A/B test running.</Muted> : abTests.map((c) => {
            const t = totals(c.id);
            const a = replyRate(t.variants.a);
            const b = replyRate(t.variants.b);
            const leader = a !== null && b !== null && a !== b ? (a > b ? "a" : "b") : null;
            return (
              <div key={c.id} style={{ display: "grid", gap: 8, paddingTop: 4, minWidth: 0 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <strong style={{ fontSize: 13, flex: "1 1 180px", minWidth: 0, overflowWrap: "anywhere" }}><CampaignName name={c.name} onOpen={onOpen ? () => onOpen(c.id) : undefined} /></strong>
                  {c.winnerVariant
                    ? <Pill tone="ok" icon={CircleCheckBig}>{c.winnerVariant.toUpperCase()} won</Pill>
                    : leader ? <Pill tone="info" dot>{leader.toUpperCase()} leading</Pill> : <Pill>Too early</Pill>}
                  {onAb && (c.status === "active" || c.status === "paused") ? (
                    <button type="button" onClick={() => onAb(c.id)} style={{ appearance: "none", border: "none", background: "transparent", padding: 0, fontSize: 12.5, fontWeight: 600, color: tokens.primary, cursor: "pointer", fontFamily: "inherit" }}>Results →</button>
                  ) : null}
                </div>
                {(["a", "b"] as const).map((variant) => {
                  const counts = t.variants[variant];
                  const rate = replyRate(counts);
                  const best = (c.winnerVariant ?? leader) === variant;
                  return (
                    <ProgressBar
                      key={variant}
                      size="sm"
                      value={rate === null ? 0 : Math.min(1, rate / Math.max(a ?? 0, b ?? 0, 0.0001))}
                      tone={best ? "ok" : "neutral"}
                      label={`Variant ${variant.toUpperCase()}`}
                      valueText={`${percent(rate)} · ${counts.replies}/${counts.sent}`}
                    />
                  );
                })}
              </div>
            );
          })}
        </SectionCard>
      </div>
    </div>
  );
}

/** A campaign name that opens its detail when the page allows it. */
function CampaignName({ name, max, onOpen }: { name: string; max?: number; onOpen?: () => void }) {
  const text = max ? short(name, max) : name;
  if (!onOpen) return <span title={name}>{text}</span>;
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`Open ${name}`}
      style={{ appearance: "none", border: "none", background: "transparent", padding: 0, font: "inherit", fontWeight: "inherit", color: "inherit", cursor: "pointer", textAlign: "left", textDecoration: "underline", textUnderlineOffset: 3, textDecorationColor: tokens.border, overflowWrap: "anywhere" }}
    >
      {text}
    </button>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  return <p style={{ margin: 0, fontSize: 13, color: tokens.muted, lineHeight: 1.45 }}>{children}</p>;
}

