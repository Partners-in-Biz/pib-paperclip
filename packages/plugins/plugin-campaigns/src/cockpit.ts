/**
 * Campaigns snapshot for the Company Cockpit (`GET /cockpit` and the hourly
 * `cockpit.snapshot` event). Read-only and cheap: a few SELECTs on our own
 * tables (plus `public.issues` for open launch approvals). Each part is
 * wrapped so one failing query never breaks the whole snapshot.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  decisionStats,
  emptySnapshot,
  isModuleEnabled,
  jobHealth,
  outboxHealth,
  publishCockpitSnapshot,
  readConfig,
  type ActivityItem,
  type CockpitSnapshot,
  type HealthCheck,
  type QualityMetric,
  type Tone,
  type WaitingItem,
} from "@partnersinbiz/pib-plugin-kit";
import { clientPrefix } from "./domain.js";
import { abSuggestionFor } from "./mail.js";
import { PLUGIN_ID } from "./namespace.js";
import { knownCompanies } from "./setup-status.js";

const HREF = "/campaigns";
export const REPLY_PURPOSE = "campaigns.reply";

/** Scheduled jobs and their interval in minutes (manifest schedules). */
export const CAMPAIGN_JOBS: Array<{ key: string; title: string; every: number }> = [
  { key: "open-due-steps", title: "Open due campaign steps", every: 5 },
  { key: "redeliver-mail", title: "Resend campaign email requests", every: 5 },
  { key: "setup-status", title: "Setup and cockpit report", every: 60 },
];

function t(ctx: PluginContext, name: string): string {
  const ns = ctx.db.namespace;
  if (!/^plugin_[a-z0-9_]+$/.test(ns) || !/^[a-z_]+$/.test(name)) throw new Error("Unsafe identifier");
  return `${ns}.${name}`;
}

async function part<T>(ctx: PluginContext, label: string, run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    ctx.logger.info("Campaigns cockpit part failed", { part: label, error: error instanceof Error ? error.message : String(error) });
    return fallback;
  }
}

const n = (value: unknown) => {
  const num = Number(value ?? 0);
  return Number.isFinite(num) ? num : 0;
};
const pct = (rate: number) => `${Math.round(rate * 100)}%`;

interface Counts {
  active: string;
  enrolled: string;
  due: string;
  sent_month: string;
  replies_month: string;
  failed_7d: string;
  retrying: string;
  oldest_failed: string | null;
}

export async function cockpitSnapshot(ctx: PluginContext, companyId: string): Promise<CockpitSnapshot> {
  const snap = emptySnapshot(PLUGIN_ID, "Campaigns");

  const counts = await part(ctx, "counts", async () => {
    const rows = await ctx.db.query<Counts>(
      `SELECT
         (SELECT count(*) FROM ${t(ctx, "campaigns")} WHERE company_id = $1 AND status = 'active')::text AS active,
         (SELECT count(*) FROM ${t(ctx, "campaign_enrollments")} WHERE company_id = $1 AND status = 'running')::text AS enrolled,
         (SELECT count(*) FROM ${t(ctx, "campaign_enrollments")} e JOIN ${t(ctx, "campaigns")} c ON c.id = e.campaign_id
           WHERE e.company_id = $1 AND e.status = 'running' AND c.status = 'active' AND e.next_due_at <= now() AND e.open_issue_id IS NULL AND e.sending_key IS NULL)::text AS due,
         (SELECT count(*) FROM ${t(ctx, "campaign_step_events")} WHERE company_id = $1 AND event_type = 'sent' AND occurred_at >= date_trunc('month', now()))::text AS sent_month,
         (SELECT count(*) FROM ${t(ctx, "campaign_step_events")} WHERE company_id = $1 AND event_type = 'reply' AND occurred_at >= date_trunc('month', now()))::text AS replies_month,
         (SELECT count(*) FROM ${t(ctx, "outbox")} WHERE company_id = $1 AND status = 'failed' AND settled_at >= now() - interval '7 days')::text AS failed_7d,
         (SELECT count(*) FROM ${t(ctx, "outbox")} WHERE company_id = $1 AND status = 'pending' AND last_error IS NOT NULL)::text AS retrying,
         (SELECT min(settled_at) FROM ${t(ctx, "outbox")} WHERE company_id = $1 AND status = 'failed' AND settled_at >= now() - interval '7 days')::text AS oldest_failed`,
      [companyId],
    );
    return rows[0] ?? null;
  }, null as Counts | null);

  if (counts) {
    const active = n(counts.active);
    const enrolled = n(counts.enrolled);
    const due = n(counts.due);
    const sent = n(counts.sent_month);
    const replies = n(counts.replies_month);
    const rate = sent > 0 ? replies / sent : null;
    snap.kpis.push(
      { key: "active_campaigns", label: "Active campaigns", value: String(active), raw: active, tone: "neutral", href: HREF, group: "marketing" },
      { key: "campaign_enrolled", label: "Contacts enrolled", value: String(enrolled), raw: enrolled, tone: "neutral", href: HREF, group: "marketing" },
      {
        key: "campaign_reply_rate",
        label: "Reply rate this month",
        value: rate == null ? "–" : pct(rate),
        raw: rate == null ? null : Math.round(rate * 1000) / 1000,
        tone: "neutral",
        delta: sent > 0 ? `${replies} replies to ${sent} emails` : null,
        href: HREF,
        group: "marketing",
      },
      { key: "campaign_due_steps", label: "Steps due now", value: String(due), raw: due, tone: due > 0 ? "warn" : "ok", href: HREF, group: "marketing" },
    );
  }

  for (const job of CAMPAIGN_JOBS) snap.health.push(await jobHealth(ctx, job.key, job.title, job.every));
  snap.health.push(await outboxHealth(ctx, companyId));
  if (counts) snap.health.push(sendHealth(counts));

  snap.waiting = await part(ctx, "waiting", () => waitingItems(ctx, companyId), [] as WaitingItem[]);
  snap.activity = await part(ctx, "activity", () => activityItems(ctx, companyId), [] as ActivityItem[]);
  snap.quality = await part(ctx, "quality", () => qualityMetrics(ctx, companyId), [] as QualityMetric[]);
  return snap;
}

function sendHealth(counts: Counts): HealthCheck {
  const failed = n(counts.failed_7d);
  const retrying = n(counts.retrying);
  if (failed > 0) {
    return {
      key: "campaigns:sends",
      title: "Campaign emails",
      status: "bad",
      detail: `${failed} campaign email${failed === 1 ? "" : "s"} could not be sent in the last 7 days${retrying ? `, ${retrying} retrying` : ""}. Each one was handed to a person as an issue.`,
      href: HREF,
      fix: "Check Gmail is connected in the Mailbox, then work the hand-over issues.",
      since: counts.oldest_failed,
    };
  }
  if (retrying > 0) {
    return { key: "campaigns:sends", title: "Campaign emails", status: "warn", detail: `${retrying} campaign email${retrying === 1 ? "" : "s"} retrying after an error from the Mailbox.`, href: "/mailbox" };
  }
  return { key: "campaigns:sends", title: "Campaign emails", status: "ok" };
}

async function waitingItems(ctx: PluginContext, companyId: string): Promise<WaitingItem[]> {
  const rows = await ctx.db.query<{ id: string; name: string; client_name: string | null; client_ref: string | null; approval_issue_id: string; created_at: string | null }>(
    `SELECT c.id, c.name, c.client_name, c.client_ref, c.approval_issue_id, i.created_at::text AS created_at
       FROM ${t(ctx, "campaigns")} c JOIN public.issues i ON i.id::text = c.approval_issue_id
      WHERE c.company_id = $1 AND c.status = 'draft' AND c.approval_issue_id IS NOT NULL
        AND i.status NOT IN ('done', 'cancelled') AND i.assignee_agent_id IS NULL
      ORDER BY i.created_at LIMIT 20`,
    [companyId],
  );
  return rows.map((row) => ({
    key: `approval:${row.approval_issue_id}`,
    title: `${clientPrefix(row.client_ref ? row.client_name : null)}Approve campaign ${row.name}`,
    why: "A person approves every campaign before it launches. Mark the issue done to approve.",
    href: `/issues/${row.approval_issue_id}`,
    issueId: row.approval_issue_id,
    kind: "review" as const,
    since: row.created_at,
  }));
}

const EVENT_TEXT: Record<string, (count: number, name: string) => string> = {
  sent: (c, name) => `Sent ${c} email${c === 1 ? "" : "s"} for campaign ${name}`,
  reply: (c, name) => `Handled ${c} repl${c === 1 ? "y" : "ies"} to campaign ${name}`,
  unsubscribe: (c, name) => `Unsubscribed ${c} contact${c === 1 ? "" : "s"} from campaign ${name}`,
  bounce: (c, name) => `Stopped ${c} bounced address${c === 1 ? "" : "es"} in campaign ${name}`,
};

async function activityItems(ctx: PluginContext, companyId: string): Promise<ActivityItem[]> {
  const rows = await ctx.db.query<{ name: string; event_type: string; n: string; at: string }>(
    `SELECT c.name, e.event_type, count(*)::text AS n, max(e.occurred_at)::text AS at
       FROM ${t(ctx, "campaign_step_events")} e JOIN ${t(ctx, "campaigns")} c ON c.id = e.campaign_id
      WHERE e.company_id = $1 AND e.occurred_at >= now() - interval '7 days' AND e.event_type IN ('sent', 'reply', 'unsubscribe', 'bounce')
      GROUP BY c.name, e.event_type, date_trunc('day', e.occurred_at)
      ORDER BY max(e.occurred_at) DESC LIMIT 10`,
    [companyId],
  );
  return rows.map((row) => ({ at: row.at, text: (EVENT_TEXT[row.event_type] ?? EVENT_TEXT.sent!)(n(row.n), row.name), href: HREF }));
}

function rateTone(rate: number): Tone {
  if (rate > 0.25) return "bad";
  if (rate > 0.1) return "warn";
  return "ok";
}

async function qualityMetrics(ctx: PluginContext, companyId: string): Promise<QualityMetric[]> {
  const out: QualityMetric[] = [];
  const stats = await part(ctx, "decisions", () => decisionStats(ctx, companyId, 30), [] as Awaited<ReturnType<typeof decisionStats>>);
  const reply = stats.find((row) => row.purpose === REPLY_PURPOSE && row.question_key === "reply_kind");
  const total = n(reply?.total);
  if (total > 0) {
    const corrected = n(reply?.corrected);
    const rate = corrected / total;
    out.push({ key: "reply_classification_corrected_rate", label: "Reply sorting corrected by people (30 days)", value: `${pct(rate)} (${corrected} of ${total})`, raw: Math.round(rate * 1000) / 1000, tone: rateTone(rate) });
  }
  const ab = await part(ctx, "ab", async () => {
    const campaigns = await ctx.db.query<{ id: string }>(
      `SELECT c.id FROM ${t(ctx, "campaigns")} c
        WHERE c.company_id = $1 AND c.status = 'active' AND c.winner_variant IS NULL
          AND EXISTS (SELECT 1 FROM ${t(ctx, "campaign_steps")} s WHERE s.campaign_id = c.id AND s.variant = 'b')
        ORDER BY c.updated_at DESC LIMIT 10`,
      [companyId],
    );
    let pending = 0;
    for (const row of campaigns) if ((await abSuggestionFor(ctx, row.id)).suggestion) pending += 1;
    return { pending, running: campaigns.length };
  }, null as { pending: number; running: number } | null);
  if (ab && ab.running > 0) {
    out.push({
      key: "ab_suggestions_pending",
      label: "A/B winners ready to declare",
      value: String(ab.pending),
      raw: ab.pending,
      tone: ab.pending > 0 ? "warn" : "ok",
    });
  }
  return out;
}

/** Hourly: push the snapshot for every company with saved settings and Campaigns on. */
export async function publishAllCockpit(ctx: PluginContext): Promise<number> {
  let published = 0;
  for (const companyId of await knownCompanies(ctx)) {
    try {
      if (!(await isModuleEnabled(ctx, companyId, PLUGIN_ID))) continue;
      if (Object.keys(await readConfig(ctx, companyId)).length === 0) continue;
      await publishCockpitSnapshot(ctx, companyId, await cockpitSnapshot(ctx, companyId));
      published += 1;
    } catch (error) {
      ctx.logger.info("Campaigns cockpit snapshot skipped", { companyId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return published;
}
