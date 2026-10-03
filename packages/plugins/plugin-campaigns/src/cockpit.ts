/**
 * Campaigns snapshot for the Company Cockpit (`GET /cockpit` and the hourly
 * `cockpit.snapshot` event). Read-only and cheap: a few SELECTs on our own
 * tables (plus `public.issues` for open launch approvals and reply issues).
 * Each part is wrapped so one failing query never breaks the whole snapshot.
 * `flows` carries live numbers for the stages of the campaigns flow (kit
 * `FLOWS`), with the same definitions as the KPIs and the waiting list.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  cleanFlowReports,
  decisionStats,
  emptySnapshot,
  flowStagesFor,
  isModuleEnabled,
  jobHealth,
  outboxHealth,
  publishCockpitSnapshot,
  readConfig,
  skillSyncCheck,
  type ActivityItem,
  type CockpitSnapshot,
  type FlowStageReport,
  type HealthCheck,
  type QualityMetric,
  type Tone,
  type WaitingItem,
} from "@partnersinbiz/pib-plugin-kit";
import { getCampaign, listSteps } from "./db.js";
import { clientPrefix } from "./domain.js";
import { unsubscribeLinkProblem } from "./links.js";
import { abSuggestionFor } from "./mail.js";
import { gatherPreflight } from "./preflight.js";
import { PLUGIN_ID } from "./namespace.js";
import { CAMPAIGN_ORIGINS } from "./origins.js";
import { knownCompanies } from "./setup-status.js";

const HREF = "/campaigns";
export const REPLY_PURPOSE = "campaigns.reply";

/** Scheduled jobs and their interval in minutes (manifest schedules). */
export const CAMPAIGN_JOBS: Array<{ key: string; title: string; every: number }> = [
  { key: "open-due-steps", title: "Open due campaign steps", every: 5 },
  { key: "redeliver-mail", title: "Resend campaign email requests", every: 5 },
  { key: "poll-messaging", title: "Read SMS and WhatsApp replies", every: 10 },
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
  snap.health.push(...(await part(ctx, "readiness", () => readinessHealth(ctx, companyId), [] as HealthCheck[])));
  snap.health.push(...(await part(ctx, "messaging", () => messagingHealth(ctx, companyId), [] as HealthCheck[])));
  const skills = await part(ctx, "skills", () => skillSyncCheck(ctx, companyId, "Campaigns"), null as HealthCheck | null);
  if (skills) snap.health.push(skills);

  snap.waiting = await part(ctx, "waiting", () => waitingItems(ctx, companyId), [] as WaitingItem[]);
  snap.flows = await campaignFlows(ctx, companyId);
  snap.activity = await part(ctx, "activity", () => activityItems(ctx, companyId), [] as ActivityItem[]);
  snap.quality = await part(ctx, "quality", () => qualityMetrics(ctx, companyId), [] as QualityMetric[]);
  return snap;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

function daysSince(at: unknown, now = Date.now()): number {
  const time = at instanceof Date ? at.getTime() : Date.parse(String(at ?? ""));
  return Number.isFinite(time) ? Math.max(0, Math.floor((now - time) / 86_400_000)) : 0;
}

/** Sends waiting on one active campaign: failed (the Mailbox gave up) or due over a day ago and still not done. */
export interface RunningSends {
  campaign_id: string;
  failed: string;
  waiting: string;
  oldest: unknown;
}

/** `campaign.running` from the active campaigns and their stuck sends. */
export function runningReport(active: number, rows: RunningSends[]): FlowStageReport {
  let failed = 0;
  let waiting = 0;
  let stuck = 0;
  let oldest: unknown = null;
  for (const row of rows) {
    const f = n(row.failed);
    const w = n(row.waiting);
    failed += f;
    waiting += w;
    if (f + w > 0) stuck += 1;
    if (row.oldest && (!oldest || Date.parse(String(row.oldest)) < Date.parse(String(oldest)))) oldest = row.oldest;
  }
  const reason = [failed ? `${plural(failed, "failed send")}` : null, waiting ? `${plural(waiting, "send")} waiting over a day` : null].filter(Boolean).join(", ");
  return { stage: "campaign.running", count: active, stuck, stuckReason: reason || null, oldestDays: stuck ? daysSince(oldest) : null };
}

/**
 * Live numbers for the campaigns flow:
 * - `campaign.draft`: drafts without a launch approval (none asked, or it was refused);
 * - `campaign.approval`: drafts whose launch approval is open, or done and launching
 *   (the rows the Cockpit's waiting list is built from);
 * - `campaign.running`: active campaigns (the KPI); stuck = campaigns with a failed
 *   send or a send due over a day ago;
 * - `campaign.replies`: open reply issues; stuck = open over 2 days.
 * A stage whose query fails is left out.
 */
export async function campaignFlows(ctx: PluginContext, companyId: string): Promise<FlowStageReport[]> {
  const reports: FlowStageReport[] = [];
  const counts = await part(ctx, "flow counts", async () => {
    const rows = await ctx.db.query<{ drafts: string; approval: string; active: string }>(
      `SELECT count(*) FILTER (WHERE c.status = 'draft' AND (i.id IS NULL OR i.status = 'cancelled'))::text AS drafts,
              count(*) FILTER (WHERE c.status = 'draft' AND i.id IS NOT NULL AND i.status <> 'cancelled')::text AS approval,
              count(*) FILTER (WHERE c.status = 'active')::text AS active
         FROM ${t(ctx, "campaigns")} c LEFT JOIN public.issues i ON i.id::text = c.approval_issue_id
        WHERE c.company_id = $1`,
      [companyId],
    );
    return rows[0] ?? null;
  }, null as { drafts: string; approval: string; active: string } | null);
  if (counts) {
    reports.push({ stage: "campaign.draft", count: n(counts.drafts) }, { stage: "campaign.approval", count: n(counts.approval) });
    const sends = await part(ctx, "flow sends", () => ctx.db.query<RunningSends>(
      `SELECT e.campaign_id,
              count(*) FILTER (WHERE o.status = 'failed')::text AS failed,
              count(*) FILTER (WHERE o.status IS DISTINCT FROM 'failed' AND e.next_due_at < now() - interval '1 day')::text AS waiting,
              min(e.next_due_at) FILTER (WHERE o.status = 'failed' OR e.next_due_at < now() - interval '1 day') AS oldest
         FROM ${t(ctx, "campaign_enrollments")} e
         JOIN ${t(ctx, "campaigns")} c ON c.id = e.campaign_id
         LEFT JOIN ${t(ctx, "outbox")} o ON o.key = 'campaigns:step:' || e.id || ':' || e.step_position
        WHERE e.company_id = $1 AND e.status = 'running' AND c.status = 'active'
        GROUP BY e.campaign_id`,
      [companyId],
    ), null as RunningSends[] | null);
    if (sends) reports.push(runningReport(n(counts.active), sends));
  }
  const replies = await part(ctx, "flow replies", async () => {
    const rows = await ctx.db.query<{ open: string; stuck: string; oldest: unknown }>(
      `SELECT count(*)::text AS open, count(*) FILTER (WHERE i.created_at < now() - interval '2 days')::text AS stuck, min(i.created_at) AS oldest
         FROM public.issues i
        WHERE i.company_id = $1::uuid AND i.origin_kind = $2 AND (i.origin_id LIKE $3 OR i.origin_id LIKE $4) AND i.status NOT IN ('done', 'cancelled')`,
      [companyId, `plugin:${PLUGIN_ID}`, `${CAMPAIGN_ORIGINS.reply}%`, "reply:%"],
    );
    return rows[0] ?? null;
  }, null as { open: string; stuck: string; oldest: unknown } | null);
  if (replies) {
    const stuck = n(replies.stuck);
    reports.push({ stage: "campaign.replies", count: n(replies.open), stuck, stuckReason: stuck ? `${stuck} open over 2 days` : null, oldestDays: stuck ? daysSince(replies.oldest) : null });
  }
  const order = flowStagesFor(PLUGIN_ID).map((stage) => stage.key);
  return cleanFlowReports(PLUGIN_ID, reports).sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage));
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

/**
 * Active automatic campaigns that cannot send right now, by the same checks the
 * approval runs (a client without a sender, a channel that lost its provider, the
 * Mailbox switched off). Such a campaign sends nothing and says nothing else, so
 * this is where it shows.
 */
export async function readinessHealth(ctx: PluginContext, companyId: string): Promise<HealthCheck[]> {
  const rows = await ctx.db.query<{ id: string }>(
    `SELECT id FROM ${t(ctx, "campaigns")} WHERE company_id = $1 AND status = 'active' AND delivery <> 'issue' ORDER BY updated_at DESC LIMIT 20`,
    [companyId],
  );
  const stuck: string[] = [];
  let emailActive = false;
  for (const row of rows) {
    const campaign = await getCampaign(ctx, row.id);
    if (!campaign) continue;
    const steps = await listSteps(ctx, campaign.id);
    if (steps.some((step) => (step.channel ?? "email") === "email")) emailActive = true;
    const result = await gatherPreflight(ctx, companyId, campaign, steps, { network: false, audience: false });
    if (!result.ok) stuck.push(`${clientPrefix(campaign.clientRef ? campaign.clientName : null)}${campaign.name}: ${result.errors[0]!.message}`);
  }
  const out: HealthCheck[] = [];
  if (stuck.length > 0) {
    out.push({
      key: "campaigns:cannot-send",
      title: "Campaigns that cannot send",
      status: "bad",
      detail: `${plural(stuck.length, "active campaign")} cannot send, so nothing is going out: ${stuck.slice(0, 3).join(" | ")}${stuck.length > 3 ? " | ..." : ""}`,
      fix: "Run preflight-campaign on it; usually a client sender (set-sender-identity), the Mailbox or the SMS and WhatsApp provider needs setting up on the Setup page.",
      href: "/setup",
    });
  }
  if (emailActive) {
    const problem = await unsubscribeLinkProblem(ctx, companyId);
    if (problem) out.push({ key: "campaigns:unsubscribe", title: "Unsubscribe links", status: "warn", detail: problem, fix: "Set the public base URL in the Campaigns settings and open the Campaigns page once.", href: "/setup" });
  }
  return out;
}

/** SMS and WhatsApp that did not go out: the provider refusing the account, unknown results and failures in the last week. */
export async function messagingHealth(ctx: PluginContext, companyId: string): Promise<HealthCheck[]> {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const rows = await ctx.db.query<{ status: string; error_code: string | null; updated_at: string | null }>(
    `SELECT status, error_code, updated_at FROM ${t(ctx, "channel_messages")} WHERE company_id = $1 AND updated_at >= $2::timestamptz ORDER BY updated_at DESC LIMIT 500`,
    [companyId, since],
  );
  const refused = rows.filter((row) => row.status === "pending");
  const unknown = rows.filter((row) => row.status === "unknown");
  const failed = rows.filter((row) => row.status === "failed");
  const out: HealthCheck[] = [];
  if (refused.length > 0) {
    const code = refused.find((row) => row.error_code)?.error_code;
    out.push({
      key: "campaigns:messaging",
      title: "SMS and WhatsApp provider",
      status: "bad",
      detail: `${plural(refused.length, "message")} could not be sent because the provider refused the account or sender${code ? ` (code ${code})` : ""}. They stay due and go out once it is fixed.`,
      fix: "Check the Twilio account SID, auth token secret and sender number in the Campaigns settings, and that the account is not suspended.",
      href: "/setup",
      since: refused[refused.length - 1]?.updated_at ?? null,
    });
  }
  if (unknown.length > 0) {
    out.push({
      key: "campaigns:messaging-unknown",
      title: "Messages with an unknown result",
      status: "bad",
      detail: `${plural(unknown.length, "SMS or WhatsApp message")} may or may not have been sent (the provider did not answer). The plugin never sends those again by itself; each was handed to a person.`,
      fix: "Check each one in the Twilio console (Monitor, Logs, Messaging), then close its issue.",
      href: "/campaigns",
    });
  }
  if (failed.length > 0) {
    out.push({ key: "campaigns:messaging-failed", title: "Messages that failed", status: "warn", detail: `${plural(failed.length, "SMS or WhatsApp message")} failed in the last 7 days; each was handed to a person.`, href: "/campaigns" });
  }
  return out;
}

interface ApprovalRow {
  id: string;
  name: string;
  client_name: string | null;
  client_ref: string | null;
  approval_issue_id: string;
  launch_error: string | null;
  issue_status: string;
  issue_agent_id: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** An approval an agent has held this long is shown to the person too (a stuck Reviewer must not stall a launch). */
export const AGENT_HOLD_MS = 24 * 3_600_000;

/**
 * Draft campaigns and their launch approval:
 * - open with a person: approve it (with the launch error when an earlier try failed);
 * - held by an agent (the Reviewer) for over a day: the person takes it over;
 * - done but not launched: it launches on the next check; if not, click Launch.
 */
export function approvalWaiting(rows: ApprovalRow[], now = Date.now()): WaitingItem[] {
  const items: WaitingItem[] = [];
  for (const row of rows) {
    const title = `${clientPrefix(row.client_ref ? row.client_name : null)}Approve campaign ${row.name}`;
    const href = `/issues/${row.approval_issue_id}`;
    if (row.issue_status === "done") {
      items.push({
        key: `launch:${row.id}`,
        title: `${clientPrefix(row.client_ref ? row.client_name : null)}Launch approved campaign ${row.name}`,
        why: row.launch_error
          ? `Approved, but it could not launch: ${row.launch_error}`
          : "Approved, not launched yet. It launches on the next check (within 5 minutes); if it stays here, open Campaigns and click Launch.",
        href: "/campaigns?tab=campaigns",
        issueId: row.approval_issue_id,
        kind: "review",
        since: row.updated_at ?? row.created_at,
      });
      continue;
    }
    if (row.issue_agent_id) {
      const held = row.created_at ? now - Date.parse(row.created_at) : 0;
      if (!(held > AGENT_HOLD_MS)) continue;
      items.push({
        key: `approval:${row.approval_issue_id}`,
        title,
        why: "An agent (the Reviewer) has held this launch approval for over a day. Check it yourself: mark the issue done to approve, or cancel it.",
        href,
        issueId: row.approval_issue_id,
        kind: "review",
        since: row.created_at,
      });
      continue;
    }
    items.push({
      key: `approval:${row.approval_issue_id}`,
      title,
      why: row.launch_error
        ? `It could not launch after the last approval: ${row.launch_error} Fix it, then mark the issue done again.`
        : "A person approves every campaign. Mark the issue done and it launches by itself.",
      href,
      issueId: row.approval_issue_id,
      kind: "review",
      since: row.created_at,
    });
  }
  return items;
}

async function waitingItems(ctx: PluginContext, companyId: string): Promise<WaitingItem[]> {
  const rows = await ctx.db.query<ApprovalRow>(
    `SELECT c.id, c.name, c.client_name, c.client_ref, c.approval_issue_id, c.launch_error, i.status AS issue_status,
            i.assignee_agent_id AS issue_agent_id, i.created_at::text AS created_at, i.updated_at::text AS updated_at
       FROM ${t(ctx, "campaigns")} c JOIN public.issues i ON i.id::text = c.approval_issue_id
      WHERE c.company_id = $1 AND c.status = 'draft' AND c.approval_issue_id IS NOT NULL AND i.status <> 'cancelled'
      ORDER BY i.created_at LIMIT 20`,
    [companyId],
  );
  return approvalWaiting(rows);
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
