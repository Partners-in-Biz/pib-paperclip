/**
 * CRM snapshot for the Company Cockpit (`GET /cockpit` and the hourly
 * `cockpit.snapshot` event). Read-only and cheap: a few SELECTs on our own
 * tables (plus `public.issues` for open approvals and follow-ups). Each part
 * is wrapped so one failing query never breaks the whole snapshot.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  decisionStats,
  emptySnapshot,
  formatMoneyMinor,
  isModuleEnabled,
  jobHealth,
  outboxHealth,
  publishCockpitSnapshot,
  readConfig,
  type ActivityItem,
  type CockpitKpi,
  type CockpitSnapshot,
  type QualityMetric,
  type Tone,
  type WaitingItem,
} from "@partnersinbiz/pib-plugin-kit";
import { PLUGIN_ID } from "./namespace.js";
import { knownCompanies } from "./setup-status.js";

const HREF = "/crm";
const ORIGIN = `plugin:${PLUGIN_ID}`;
export const REPLY_PURPOSE = "crm.reply";

/** Scheduled jobs and their interval in minutes (manifest schedules). */
export const CRM_JOBS: Array<{ key: string; title: string; every: number }> = [
  { key: "open-due-steps", title: "Open due sequence steps", every: 5 },
  { key: "redeliver-mail", title: "Resend sequence email requests", every: 5 },
  { key: "emit-recent", title: "Share recent client changes", every: 15 },
  { key: "emit-all", title: "Share all clients (nightly)", every: 1440 },
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
    ctx.logger.info("CRM cockpit part failed", { part: label, error: error instanceof Error ? error.message : String(error) });
    return fallback;
  }
}

const n = (value: unknown) => {
  const num = Number(value ?? 0);
  return Number.isFinite(num) ? num : 0;
};
const pct = (rate: number) => `${Math.round(rate * 100)}%`;
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

interface Counts {
  won_month: string;
  new_leads_week: string;
  follow_up: string;
  active_sequences: string;
  open_leads: string;
  scored_leads: string;
}

interface MoneyRow {
  currency: string;
  open_minor: string;
  open_deals: string;
  won_minor: string;
}

/** Pipeline money per currency → one display value: the default currency first, others named after it. */
export function pipelineValue(rows: MoneyRow[], defaultCurrency: string): { value: string; raw: number; delta: string | null; deals: number } {
  const open = rows.filter((row) => n(row.open_minor) !== 0 || n(row.open_deals) > 0);
  const deals = open.reduce((sum, row) => sum + n(row.open_deals), 0);
  if (open.length === 0) return { value: formatMoneyMinor(0, defaultCurrency), raw: 0, delta: null, deals: 0 };
  const sorted = [...open].sort((a, b) => (a.currency === defaultCurrency ? -1 : b.currency === defaultCurrency ? 1 : n(b.open_minor) - n(a.open_minor)));
  const [first, ...rest] = sorted;
  const others = rest.map((row) => formatMoneyMinor(n(row.open_minor), row.currency));
  return {
    value: formatMoneyMinor(n(first!.open_minor), first!.currency),
    raw: n(first!.open_minor),
    delta: `${plural(deals, "open deal")}${others.length ? ` · plus ${others.join(", ")}` : ""}`,
    deals,
  };
}

export async function cockpitSnapshot(ctx: PluginContext, companyId: string): Promise<CockpitSnapshot> {
  const snap = emptySnapshot(PLUGIN_ID, "CRM");
  let defaultCurrency = "ZAR";
  try {
    const config = await readConfig(ctx, companyId);
    if (typeof config.defaultCurrency === "string" && /^[A-Z]{3}$/.test(config.defaultCurrency)) defaultCurrency = config.defaultCurrency;
  } catch {
    // default
  }

  const money = await part(ctx, "money", () => ctx.db.query<MoneyRow>(
    `SELECT d.currency,
            COALESCE(sum(d.amount_minor) FILTER (WHERE s.kind = 'open'), 0)::text AS open_minor,
            count(*) FILTER (WHERE s.kind = 'open')::text AS open_deals,
            COALESCE(sum(d.amount_minor) FILTER (WHERE s.kind = 'won' AND d.updated_at >= date_trunc('month', now())), 0)::text AS won_minor
       FROM ${t(ctx, "deals")} d JOIN ${t(ctx, "pipeline_stages")} s ON s.id = d.stage_id
      WHERE d.company_id = $1
      GROUP BY d.currency`,
    [companyId],
  ), null as MoneyRow[] | null);

  const counts = await part(ctx, "counts", async () => {
    const rows = await ctx.db.query<Counts>(
      `SELECT
         (SELECT count(*) FROM ${t(ctx, "deals")} d JOIN ${t(ctx, "pipeline_stages")} s ON s.id = d.stage_id
           WHERE d.company_id = $1 AND s.kind = 'won' AND d.updated_at >= date_trunc('month', now()))::text AS won_month,
         (SELECT count(*) FROM ${t(ctx, "contacts")} WHERE company_id = $1 AND lifecycle = 'lead' AND created_at >= now() - interval '7 days')::text AS new_leads_week,
         (SELECT count(*) FROM ${t(ctx, "contacts")} WHERE company_id = $1 AND next_action_due_at IS NOT NULL AND next_action_due_at <= now())::text AS follow_up,
         (SELECT count(DISTINCT sequence_id) FROM ${t(ctx, "enrollments")} WHERE company_id = $1 AND status = 'running')::text AS active_sequences,
         (SELECT count(*) FROM ${t(ctx, "contacts")} WHERE company_id = $1 AND lifecycle IN ('lead', 'prospect'))::text AS open_leads,
         (SELECT count(*) FROM ${t(ctx, "contacts")} WHERE company_id = $1 AND lifecycle IN ('lead', 'prospect') AND lead_scored_at IS NOT NULL)::text AS scored_leads`,
      [companyId],
    );
    return rows[0] ?? null;
  }, null as Counts | null);

  if (money) {
    const pipeline = pipelineValue(money, defaultCurrency);
    snap.kpis.push({ key: "pipeline", label: "Open pipeline", value: pipeline.value, raw: pipeline.raw, tone: "neutral", delta: pipeline.delta, href: HREF, group: "pipeline" });
  }
  if (counts) {
    const won = n(counts.won_month);
    const wonMinor = (money ?? []).find((row) => row.currency === defaultCurrency);
    const leads = n(counts.new_leads_week);
    const followUp = n(counts.follow_up);
    const sequences = n(counts.active_sequences);
    const kpis: CockpitKpi[] = [
      { key: "deals_won_month", label: "Deals won this month", value: String(won), raw: won, tone: won > 0 ? "ok" : "neutral", delta: wonMinor && n(wonMinor.won_minor) > 0 ? formatMoneyMinor(n(wonMinor.won_minor), defaultCurrency) : null, href: HREF, group: "pipeline" },
      { key: "new_leads_week", label: "New leads this week", value: String(leads), raw: leads, tone: "neutral", href: HREF, group: "pipeline" },
      { key: "contacts_follow_up", label: "Contacts needing follow-up", value: String(followUp), raw: followUp, tone: followUp > 0 ? "warn" : "ok", href: HREF, group: "pipeline" },
      { key: "active_sequences", label: "Active sequences", value: String(sequences), raw: sequences, tone: "neutral", href: HREF, group: "pipeline" },
    ];
    snap.kpis.push(...kpis);
  }

  for (const job of CRM_JOBS) snap.health.push(await jobHealth(ctx, job.key, job.title, job.every));
  snap.health.push(await outboxHealth(ctx, companyId));

  snap.waiting = await part(ctx, "waiting", () => waitingItems(ctx, companyId), [] as WaitingItem[]);
  snap.activity = await part(ctx, "activity", () => activityItems(ctx, companyId), [] as ActivityItem[]);
  snap.quality = await part(ctx, "quality", () => qualityMetrics(ctx, companyId, counts), [] as QualityMetric[]);
  return snap;
}

async function waitingItems(ctx: PluginContext, companyId: string): Promise<WaitingItem[]> {
  const approvals = await ctx.db.query<{ id: string; name: string; email_approval_issue_id: string; created_at: string | null }>(
    `SELECT q.id, q.name, q.email_approval_issue_id, i.created_at::text AS created_at
       FROM ${t(ctx, "sequences")} q JOIN public.issues i ON i.id::text = q.email_approval_issue_id
      WHERE q.company_id = $1 AND q.email_approved_at IS NULL AND q.email_approval_issue_id IS NOT NULL
        AND i.status NOT IN ('done', 'cancelled') AND i.assignee_agent_id IS NULL
      ORDER BY i.created_at LIMIT 20`,
    [companyId],
  );
  const items: WaitingItem[] = approvals.map((row) => ({
    key: `approval:${row.email_approval_issue_id}`,
    title: `Approve email sending: ${row.name}`,
    why: "A board user approves before a sequence emails contacts. Mark the issue done to approve.",
    href: `/issues/${row.email_approval_issue_id}`,
    issueId: row.email_approval_issue_id,
    kind: "review",
    since: row.created_at,
  }));
  const followUps = await ctx.db.query<{ id: string; title: string; origin_id: string; created_at: string | null }>(
    `SELECT i.id::text AS id, i.title, i.origin_id, i.created_at::text AS created_at
       FROM public.issues i
      WHERE i.company_id::text = $1 AND i.origin_kind = $2 AND (i.origin_id LIKE 'reply:%' OR i.origin_id LIKE 'lead:%')
        AND i.status NOT IN ('done', 'cancelled') AND i.assignee_user_id IS NOT NULL AND i.assignee_agent_id IS NULL
      ORDER BY i.created_at LIMIT 20`,
    [companyId, ORIGIN],
  );
  for (const row of followUps) {
    items.push({
      key: `followup:${row.id}`,
      title: row.title,
      why: row.origin_id.startsWith("lead:") ? "A new lead is waiting for a person to reply." : "A contact replied and a person follows up.",
      href: `/issues/${row.id}`,
      issueId: row.id,
      kind: "judgement",
      since: row.created_at,
    });
  }
  return items;
}

async function activityItems(ctx: PluginContext, companyId: string): Promise<ActivityItem[]> {
  const rows = await ctx.db.query<{ kind: string; body: string; name: string | null; at: string }>(
    `SELECT a.kind, a.body, COALESCE(c.name, d.title) AS name, a.created_at::text AS at
       FROM ${t(ctx, "activities")} a
       LEFT JOIN ${t(ctx, "contacts")} c ON a.record_type = 'contact' AND c.id = a.record_id
       LEFT JOIN ${t(ctx, "deals")} d ON a.record_type = 'deal' AND d.id = a.record_id
      WHERE a.company_id = $1 AND a.kind IN ('deal_moved', 'email_sent', 'reply_classified', 'lead_captured')
      ORDER BY a.created_at DESC LIMIT 10`,
    [companyId],
  );
  const contacts = await ctx.db.query<{ name: string; at: string }>(
    `SELECT name, created_at::text AS at FROM ${t(ctx, "contacts")} WHERE company_id = $1 ORDER BY created_at DESC LIMIT 5`,
    [companyId],
  );
  const items: ActivityItem[] = rows.map((row) => ({ at: row.at, text: activityText(row.kind, row.body, row.name), href: HREF }));
  for (const row of contacts) items.push({ at: row.at, text: `Added contact ${row.name}`, href: HREF });
  return items.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 10);
}

export function activityText(kind: string, body: string, name: string | null): string {
  const who = name ?? "a contact";
  if (kind === "deal_moved") return `Moved deal ${name ?? ""} ${body.replace(/^Moved /, "").trim()}`.replace(/\s+/g, " ").trim();
  if (kind === "email_sent") return `Sent a sequence email to ${who}`;
  if (kind === "reply_classified") return `Handled a reply from ${who}`;
  if (kind === "lead_captured") return `Captured a lead: ${who}`;
  return body.slice(0, 120);
}

function rateTone(rate: number): Tone {
  if (rate > 0.25) return "bad";
  if (rate > 0.1) return "warn";
  return "ok";
}

async function qualityMetrics(ctx: PluginContext, companyId: string, counts: Counts | null): Promise<QualityMetric[]> {
  const out: QualityMetric[] = [];
  const stats = await part(ctx, "decisions", () => decisionStats(ctx, companyId, 30), [] as Awaited<ReturnType<typeof decisionStats>>);
  const reply = stats.find((row) => row.purpose === REPLY_PURPOSE && row.question_key === "reply_kind");
  const total = n(reply?.total);
  if (total > 0) {
    const corrected = n(reply?.corrected);
    const rate = corrected / total;
    out.push({ key: "reply_classification_corrected_rate", label: "Reply sorting corrected by people (30 days)", value: `${pct(rate)} (${corrected} of ${total})`, raw: Math.round(rate * 1000) / 1000, tone: rateTone(rate) });
  }
  if (counts) {
    const leads = n(counts.open_leads);
    const scored = n(counts.scored_leads);
    if (leads > 0) {
      const rate = scored / leads;
      out.push({ key: "lead_score_coverage", label: "Leads with a lead score", value: `${pct(rate)} (${scored} of ${leads})`, raw: Math.round(rate * 1000) / 1000, tone: rate >= 0.8 ? "ok" : rate >= 0.5 ? "warn" : "bad" });
    }
  }
  return out;
}

/** Hourly: push the snapshot for every company with saved settings and the CRM on. */
export async function publishAllCockpit(ctx: PluginContext): Promise<number> {
  let published = 0;
  for (const companyId of await knownCompanies(ctx)) {
    try {
      if (!(await isModuleEnabled(ctx, companyId, PLUGIN_ID))) continue;
      if (Object.keys(await readConfig(ctx, companyId)).length === 0) continue;
      await publishCockpitSnapshot(ctx, companyId, await cockpitSnapshot(ctx, companyId));
      published += 1;
    } catch (error) {
      ctx.logger.info("CRM cockpit snapshot skipped", { companyId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return published;
}
