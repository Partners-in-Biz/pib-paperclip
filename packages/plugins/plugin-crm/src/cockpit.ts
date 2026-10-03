/**
 * CRM snapshot for the Company Cockpit (`GET /cockpit` and the hourly
 * `cockpit.snapshot` event). Read-only and cheap: a few SELECTs on our own
 * tables (plus `public.issues` for open approvals and follow-ups). Each part
 * is wrapped so one failing query never breaks the whole snapshot.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  cleanFlowReports,
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
  type FlowStageReport,
  type HealthCheck,
  type QualityMetric,
  type TeamMemberReport,
  type Tone,
  type WaitingItem,
} from "@partnersinbiz/pib-plugin-kit";
import { teamReport } from "./agent.js";
import { CARE_EVENT_KIND } from "./care-clients.js";
import { PLUGIN_ID } from "./namespace.js";
import { isLeadFollowUp, isReplyWork } from "./origins.js";
import { knownCompanies } from "./setup-status.js";
import { activeLeadSources } from "./lead-capture.js";
import { heldLeadStats } from "./store.js";
import { careHealth, careWaiting } from "./care-jobs.js";

const HREF = "/crm";
const ORIGIN = `plugin:${PLUGIN_ID}`;
export const REPLY_PURPOSE = "crm.reply";

/** Scheduled jobs and their interval in minutes (manifest schedules). */
export const CRM_JOBS: Array<{ key: string; title: string; every: number }> = [
  { key: "open-due-steps", title: "Open due sequence steps", every: 5 },
  { key: "redeliver-mail", title: "Resend sequence email requests", every: 5 },
  { key: "held-leads", title: "Add held leads", every: 10 },
  { key: "emit-recent", title: "Share recent client changes", every: 15 },
  { key: "emit-all", title: "Share all clients (nightly)", every: 1440 },
  { key: "setup-status", title: "Setup and cockpit report", every: 60 },
  { key: "services-check", title: "Start the services customers bought", every: 1440 },
  { key: "site-monitor", title: "Check client websites", every: 5 },
  { key: "client-care", title: "Client care", every: 15 },
  { key: "client-health", title: "Score customer health", every: 1440 },
  { key: "client-report-monthly", title: "Monthly client reports", every: 44_640 },
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
export function pipelineValue(rows: MoneyRow[], defaultCurrency: string): { value: string; raw: number; currency: string; delta: string | null; deals: number } {
  const open = rows.filter((row) => n(row.open_minor) !== 0 || n(row.open_deals) > 0);
  const deals = open.reduce((sum, row) => sum + n(row.open_deals), 0);
  if (open.length === 0) return { value: formatMoneyMinor(0, defaultCurrency), raw: 0, currency: defaultCurrency, delta: null, deals: 0 };
  const sorted = [...open].sort((a, b) => (a.currency === defaultCurrency ? -1 : b.currency === defaultCurrency ? 1 : n(b.open_minor) - n(a.open_minor)));
  const [first, ...rest] = sorted;
  const others = rest.map((row) => formatMoneyMinor(n(row.open_minor), row.currency));
  return {
    value: formatMoneyMinor(n(first!.open_minor), first!.currency),
    raw: n(first!.open_minor),
    currency: first!.currency,
    delta: `${plural(deals, "open deal")}${others.length ? ` · plus ${others.join(", ")}` : ""}`,
    deals,
  };
}

// ---------------------------------------------------------------------------
// Company graph stages (kit FLOWS): lead.in and deal.open
// ---------------------------------------------------------------------------

/** A lead follow-up open longer than this is stuck (the Account Manager answers within a working day). */
export const LEAD_STUCK_DAYS = 2;
/** An open deal with nothing logged on it, its contact or its company, and no change to it, for this long is stuck. */
export const DEAL_IDLE_DAYS = 14;

/** Work issues the waiting list shows while no agent holds them (origin ids before and after 0.5.0). */
export const FOLLOW_UP_ORIGINS = "^(reply|lead|handoff|quote|won|crm:(reply|lead-followup|sequence-refused|quote-deal|won-client|client-lead|service-onboard|client-report|support-case|support-breach|client-action-stale|churn-risk|msg-failed|feedback-low|site-down|site-tls|site-domain)):";
/** Lead follow-up issues (origin ids before and after 0.5.0). */
export const LEAD_FOLLOW_UP_ORIGINS = "^(lead|crm:lead-followup):";

const DAY_MS = 86_400_000;

function ageDays(iso: string | null | undefined, now: number): number | null {
  const time = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(time) ? Math.max(0, Math.floor((now - time) / DAY_MS)) : null;
}

function oldest(...days: Array<number | null>): number | null {
  const known = days.filter((day): day is number => day != null);
  return known.length ? Math.max(...known) : null;
}

interface LeadFlowRow {
  open: string;
  stuck: string;
  late: string;
  blocked: string;
  unowned: string;
  oldest: string | null;
}

/**
 * `lead.in`: leads waiting for a first follow-up, meaning open follow-up issues plus
 * own leads held while the CRM is off or unsaved. Stuck: follow-ups open over
 * 2 days, blocked or with nobody assigned, and every held lead.
 */
export async function leadInReport(ctx: PluginContext, companyId: string, ready: { enabled: boolean; saved: boolean }, now = Date.now()): Promise<FlowStageReport> {
  const rows = await ctx.db.query<LeadFlowRow>(
    `SELECT count(*)::text AS open,
            count(*) FILTER (WHERE i.created_at < now() - make_interval(days => $4::int) OR i.status = 'blocked'
                               OR (i.assignee_agent_id IS NULL AND i.assignee_user_id IS NULL))::text AS stuck,
            count(*) FILTER (WHERE i.created_at < now() - make_interval(days => $4::int))::text AS late,
            count(*) FILTER (WHERE i.status = 'blocked')::text AS blocked,
            count(*) FILTER (WHERE i.assignee_agent_id IS NULL AND i.assignee_user_id IS NULL)::text AS unowned,
            min(i.created_at)::text AS oldest
       FROM public.issues i
      WHERE i.company_id::text = $1 AND i.origin_kind = $2 AND i.origin_id ~ $3 AND i.status NOT IN ('done', 'cancelled')`,
    [companyId, ORIGIN, LEAD_FOLLOW_UP_ORIGINS, LEAD_STUCK_DAYS],
  );
  const row = rows[0];
  const held = await heldLeadStats(ctx, companyId);
  const late = n(row?.late);
  const unowned = n(row?.unowned);
  const blocked = n(row?.blocked);
  const why: string[] = [];
  if (late) why.push(`${late} open over ${LEAD_STUCK_DAYS} days`);
  if (unowned) why.push(`${unowned} with nobody assigned`);
  if (blocked) why.push(`${blocked} blocked`);
  if (held.count) {
    why.push(`${held.count} held until ${!ready.enabled ? "the CRM is switched on" : !ready.saved ? "the CRM settings are saved" : "the next run adds them"}`);
  }
  return {
    stage: "lead.in",
    count: n(row?.open) + held.count,
    stuck: n(row?.stuck) + held.count,
    stuckReason: why.length ? why.join(", ") : null,
    oldestDays: oldest(ageDays(row?.oldest, now), ageDays(held.oldest, now)),
  };
}

interface DealFlowRow {
  open: string;
  idle: string;
  oldest: string | null;
}

/**
 * `deal.open`: deals in an open stage and their value, the same numbers as the
 * "Open pipeline" KPI (default currency first). Stuck: nothing logged on the
 * deal, its contact or its company, and no change to the deal, for 14 days.
 */
export async function dealOpenReport(
  ctx: PluginContext,
  companyId: string,
  pipeline: { raw: number; currency: string; deals: number } | null,
  now = Date.now(),
): Promise<FlowStageReport> {
  const rows = await ctx.db.query<DealFlowRow>(
    `SELECT count(*)::text AS open,
            count(*) FILTER (WHERE GREATEST(d.updated_at, COALESCE(a.last_at, d.updated_at)) < now() - make_interval(days => $2::int))::text AS idle,
            min(d.created_at)::text AS oldest
       FROM ${t(ctx, "deals")} d
       JOIN ${t(ctx, "pipeline_stages")} s ON s.id = d.stage_id
       LEFT JOIN LATERAL (
         SELECT max(x.created_at) AS last_at
           FROM ${t(ctx, "activities")} x
          WHERE x.company_id = d.company_id
            AND x.kind <> $3
            AND ((x.record_type = 'deal' AND x.record_id = d.id)
              OR (x.record_type = 'contact' AND x.record_id = d.contact_id)
              OR (x.record_type = 'company' AND x.record_id = d.account_id))
       ) a ON true
      WHERE d.company_id = $1 AND s.kind = 'open'`,
    [companyId, DEAL_IDLE_DAYS, CARE_EVENT_KIND],
  );
  const row = rows[0];
  const idle = n(row?.idle);
  return {
    stage: "deal.open",
    count: pipeline ? pipeline.deals : n(row?.open),
    stuck: idle,
    stuckReason: idle ? `${idle} with no activity for ${DEAL_IDLE_DAYS} days` : null,
    amountMinor: pipeline ? pipeline.raw : null,
    currency: pipeline ? pipeline.currency : null,
    oldestDays: ageDays(row?.oldest, now),
  };
}

export async function cockpitSnapshot(ctx: PluginContext, companyId: string): Promise<CockpitSnapshot> {
  const snap = emptySnapshot(PLUGIN_ID, "CRM");
  let defaultCurrency = "ZAR";
  let saved = false;
  try {
    const config = await readConfig(ctx, companyId);
    saved = Object.keys(config).length > 0;
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

  const pipeline = money ? pipelineValue(money, defaultCurrency) : null;
  if (pipeline) {
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
  snap.health.push(await part(ctx, "held-leads", () => heldLeadsHealth(ctx, companyId), { key: "held-leads", title: "Leads waiting for the CRM", status: "ok" } as HealthCheck));
  const forms = await part(ctx, "lead-forms", () => leadFormsHealth(ctx, companyId), null as HealthCheck | null);
  if (forms) snap.health.push(forms);
  // The Account Manager this plugin staffs; the Cockpit shares it in roles.updated so every plugin can route work to it.
  snap.team = await part(ctx, "team", () => teamReport(ctx, companyId), [{ role: "account-manager", agentId: null, status: null }] as TeamMemberReport[]);

  snap.health.push(...(await careHealth(ctx, companyId)));
  snap.waiting = await part(ctx, "waiting", () => waitingItems(ctx, companyId), [] as WaitingItem[]);
  snap.waiting.push(...(await careWaiting(ctx, companyId)));
  snap.activity = await part(ctx, "activity", () => activityItems(ctx, companyId), [] as ActivityItem[]);
  snap.quality = await part(ctx, "quality", () => qualityMetrics(ctx, companyId, counts), [] as QualityMetric[]);

  // Live numbers for the stages this plugin owns in the company graph (kit FLOWS). A stage that cannot be counted reports nothing.
  const enabled = await isModuleEnabled(ctx, companyId, PLUGIN_ID).catch(() => true);
  const leadIn = await part(ctx, "flow:lead.in", () => leadInReport(ctx, companyId, { enabled, saved }), null as FlowStageReport | null);
  const dealOpen = await part(ctx, "flow:deal.open", () => dealOpenReport(ctx, companyId, pipeline), null as FlowStageReport | null);
  snap.flows = cleanFlowReports(PLUGIN_ID, [leadIn, dealOpen].filter((report): report is FlowStageReport => report != null));
  return snap;
}

/** Own leads held while the CRM is off or unsaved: warn at once, bad after a day. */
export async function heldLeadsHealth(ctx: PluginContext, companyId: string): Promise<HealthCheck> {
  const stats = await heldLeadStats(ctx, companyId);
  if (stats.count === 0) return { key: "held-leads", title: "Leads waiting for the CRM", status: "ok" };
  const old = stats.oldest ? Date.now() - Date.parse(stats.oldest) > 86_400_000 : false;
  return {
    key: "held-leads",
    title: "Leads waiting for the CRM",
    status: old ? "bad" : "warn",
    detail: `${plural(stats.count, "lead")} came in while the CRM was switched off or its settings were not saved. They are kept, not lost.`,
    href: "/setup",
    fix: "Switch the CRM on in Setup and save its settings once (Settings → Plugins → CRM). The held leads are then added within 10 minutes.",
    since: stats.oldest,
  };
}

/** How long a lead form may take no lead before it is worth a look: it was probably never installed. */
export const LEAD_FORM_QUIET_DAYS = 7;

/** Lead forms that never took a lead: warn (the snippet is probably not installed). Nothing for a company with no forms. */
export async function leadFormsHealth(ctx: PluginContext, companyId: string, now = Date.now()): Promise<HealthCheck | null> {
  const sources = await activeLeadSources(ctx, companyId);
  if (sources.length === 0) return null;
  const quiet = sources.filter((source) => source.acceptedCount === 0 && source.createdAt && now - Date.parse(source.createdAt) > LEAD_FORM_QUIET_DAYS * DAY_MS);
  if (quiet.length === 0) return { key: "lead-forms", title: "Lead forms", status: "ok", detail: `${plural(sources.length, "lead form")} active.` };
  return {
    key: "lead-forms",
    title: "Lead forms",
    status: "warn",
    detail: `${plural(quiet.length, "lead form")} took no lead in ${LEAD_FORM_QUIET_DAYS} days or more: ${quiet.slice(0, 3).map((source) => source.label).join(", ")}${quiet.length > 3 ? "…" : ""}.`,
    href: HREF,
    fix: "The snippet is probably not on the site yet. list-lead-sources has each form's snippet; install it through the client's repo project and send one test enquiry.",
    since: quiet.map((source) => source.createdAt).filter((at): at is string => Boolean(at)).sort()[0] ?? null,
  };
}

async function waitingItems(ctx: PluginContext, companyId: string): Promise<WaitingItem[]> {
  // Every open email approval, also while the Reviewer (an agent) holds it: only a person decides.
  const approvals = await ctx.db.query<{ id: string; name: string; email_approval_issue_id: string; created_at: string | null; assignee_agent_id: string | null; due: string | null }>(
    `SELECT q.id, q.name, q.email_approval_issue_id, i.created_at::text AS created_at, i.assignee_agent_id::text AS assignee_agent_id,
            (SELECT count(*) FROM ${t(ctx, "enrollments")} e
              WHERE e.sequence_id = q.id AND e.status = 'running' AND e.next_due_at <= now())::text AS due
       FROM ${t(ctx, "sequences")} q JOIN public.issues i ON i.id::text = q.email_approval_issue_id
      WHERE q.company_id = $1 AND q.email_approved_at IS NULL AND q.email_approval_issue_id IS NOT NULL
        AND i.status NOT IN ('done', 'cancelled')
      ORDER BY i.created_at LIMIT 20`,
    [companyId],
  );
  const items: WaitingItem[] = approvals.map((row) => {
    const due = n(row.due);
    const held = due > 0 ? ` ${plural(due, "due step")} ${due === 1 ? "waits" : "wait"} for it.` : "";
    return {
      key: `approval:${row.email_approval_issue_id}`,
      title: `Approve email sending: ${row.name}`,
      why: row.assignee_agent_id
        ? `The Reviewer checks it first, then a person marks the issue done to approve or cancelled to refuse.${held}`
        : `A person approves before a sequence emails contacts: mark the issue done to approve or cancelled to refuse.${held}`,
      href: `/issues/${row.email_approval_issue_id}`,
      issueId: row.email_approval_issue_id,
      kind: "review",
      since: row.created_at,
    };
  });
  // Lead, reply and hand-off work that no agent holds (no Account Manager or Operator yet); origin ids before and after 0.5.0.
  const followUps = await ctx.db.query<{ id: string; title: string; origin_id: string; created_at: string | null; assignee_user_id: string | null }>(
    `SELECT i.id::text AS id, i.title, i.origin_id, i.created_at::text AS created_at, i.assignee_user_id::text AS assignee_user_id
       FROM public.issues i
      WHERE i.company_id::text = $1 AND i.origin_kind = $2 AND i.origin_id ~ $3
        AND i.status NOT IN ('done', 'cancelled') AND i.assignee_agent_id IS NULL
      ORDER BY i.created_at LIMIT 20`,
    [companyId, ORIGIN, FOLLOW_UP_ORIGINS],
  );
  for (const row of followUps) {
    const lead = isLeadFollowUp(row.origin_id);
    items.push({
      key: `followup:${row.id}`,
      title: row.title,
      why: `${lead ? "A lead is waiting for a reply" : isReplyWork(row.origin_id) ? "A contact replied" : "CRM work is waiting"} and no agent holds it${row.assignee_user_id ? "" : " (nobody is assigned)"}. Hire the Account Manager in Setup → Team so agents do this.`,
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
