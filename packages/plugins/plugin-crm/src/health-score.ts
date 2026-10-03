/**
 * The client health score and churn-risk alerts (audit Q10-12): one number per
 * customer from what every module knows, so the weak ones are found before they
 * leave.
 *
 * Seven parts, each 0 to 100 (100 best), weighted: support load (25), reply
 * latency (15), overdue invoices (20), SEO health (20), site uptime (10), whether
 * the client answers our requests (5) and how recently we dealt with them (5). A
 * part with no data is left out and the rest are scaled up, so a client that has no
 * SEO sprint is not marked down for it. Bands: 75 and over healthy, 50 to 74 watch,
 * under 50 at risk. The score only alerts when at least three parts have data.
 *
 * SEO health and overdue invoices come from the other modules (`client.signal`, see
 * client-signals.ts); until a module sends them they are listed as missing, never
 * guessed. An at-risk customer gets one issue for the Account Manager a month, in the
 * client's project, with the reasons; closing it needs a follow-up logged on the client.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { HealthCheck } from "@partnersinbiz/pib-plugin-kit";
import { clientContacts, clientInfo, clientProjectOf, customerClients, isInternalClient, type ClientInfo } from "./care-clients.js";
import {
  getHealth,
  iso,
  listActions,
  listCases,
  listFeedback,
  listHealth,
  listSignals,
  saveHealth,
  type ClientKey,
  type HealthBand,
  type HealthComponent,
  type HealthRecord,
} from "./care-store.js";
import { currentSignal } from "./client-signals.js";
import { table } from "./db.js";
import { ACTIVITY_KINDS, type Viewer } from "./domain.js";
import { parseClientRef, requireClient, visibleClients } from "./lookup.js";
import { openIssueOnce } from "./mail.js";
import { daysUntil } from "./monitor-net.js";
import { downMinutes, listMonitorSites, listMonitors, uptimeFigures } from "./monitor.js";
import { originFor } from "./origins.js";
import { companyPrefix, crmLink, refOf } from "./refs.js";
import { teamAssignee } from "./routing.js";
import { caseSla } from "./support.js";

const DAY_MS = 86_400_000;

/** Timeline entries that show someone worked the client (the same list the done-checks use: a test keeps them equal). */
export const WORK_KINDS: string[] = [...ACTIVITY_KINDS, "email_sent", "deal_moved", "deal_won"];

export const HEALTH_WEIGHTS = { support: 25, replyLatency: 15, billing: 20, seo: 20, uptime: 10, responsiveness: 5, recency: 5 } as const;
export type HealthPart = keyof typeof HEALTH_WEIGHTS;

/** An unanswered email older than this is late. */
export const REPLY_LATE_HOURS = 48;
/** The least number of parts with data before a score may raise an alert. */
export const MIN_PARTS_FOR_ALERT = 3;
export const AT_RISK_BELOW = 50;
export const WATCH_BELOW = 75;
/** A fall this big between two runs raises the alert even above the risk line. */
export const SHARP_DROP = 25;

export interface HealthInputs {
  support: { open: number; breached: number; urgentOpen: number; latestCsat: number | null } | null;
  replyLatency: { unanswered: number; oldestHours: number | null } | null;
  billing: { overdueCount: number } | null;
  seo: { score: number } | null;
  uptime: { down: boolean; tlsDays: number | null; monthPct: number | null; sites: number } | null;
  responsiveness: { stale: number; waiting: number } | null;
  recency: { daysSince: number | null } | null;
}

export const EMPTY_INPUTS: HealthInputs = { support: null, replyLatency: null, billing: null, seo: null, uptime: null, responsiveness: null, recency: null };

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function bandOf(score: number): HealthBand {
  return score >= WATCH_BELOW ? "healthy" : score >= AT_RISK_BELOW ? "watch" : "at_risk";
}

/** The seven parts a client has data for, each with its score and the reason in words. Pure. */
export function healthComponents(input: HealthInputs): HealthComponent[] {
  const out: HealthComponent[] = [];
  const add = (key: HealthPart, label: string, score: number, detail: string) => out.push({ key, label, score: clamp(score), weight: HEALTH_WEIGHTS[key], detail });

  const s = input.support;
  if (s) {
    let score = 100 - Math.min(60, s.breached * 30) - s.urgentOpen * 15 - Math.min(20, Math.max(0, s.open - 2) * 5);
    if (s.latestCsat !== null) score -= s.latestCsat <= 2 ? 20 : s.latestCsat === 3 ? 10 : 0;
    add("support", "Support", score, s.open === 0 && s.breached === 0 ? "No open cases." : `${plural(s.open, "open case")}, ${s.breached} past a target${s.urgentOpen ? `, ${s.urgentOpen} urgent` : ""}${s.latestCsat !== null ? `, last CSAT ${s.latestCsat} of 5` : ""}.`);
  }
  const r = input.replyLatency;
  if (r) add("replyLatency", "Reply speed", 100 - r.unanswered * 35, r.unanswered === 0 ? "Every email from them was answered." : `${plural(r.unanswered, "email")} from them waited over ${REPLY_LATE_HOURS} hours${r.oldestHours !== null ? ` (the oldest ${Math.round(r.oldestHours)} h)` : ""}.`);
  const b = input.billing;
  if (b) add("billing", "Invoices", b.overdueCount === 0 ? 100 : b.overdueCount === 1 ? 65 : b.overdueCount === 2 ? 40 : 15, b.overdueCount === 0 ? "Nothing overdue." : `${plural(b.overdueCount, "invoice")} overdue.`);
  const o = input.seo;
  if (o) add("seo", "SEO health", o.score, `The SEO sprint health is ${o.score} of 100.`);
  const u = input.uptime;
  if (u) {
    let score = 100;
    const notes: string[] = [];
    if (u.down) {
      score = 0;
      notes.push("a site is down now");
    } else {
      if (u.tlsDays !== null && u.tlsDays < 14) {
        score = Math.min(score, u.tlsDays < 3 ? 20 : 50);
        notes.push(`a certificate expires in ${Math.max(0, u.tlsDays)} days`);
      }
      if (u.monthPct !== null && u.monthPct < 99) {
        score = Math.min(score, u.monthPct < 95 ? 40 : 70);
        notes.push(`${u.monthPct}% uptime this month`);
      }
    }
    add("uptime", "Website", score, notes.length ? `${notes.join("; ")}.` : `${plural(u.sites, "site")} up.`);
  }
  const p = input.responsiveness;
  if (p) add("responsiveness", "Answers our requests", 100 - p.stale * 40, p.stale === 0 ? `${plural(p.waiting, "request")} waiting, none overdue.` : `${plural(p.stale, "request")} unanswered after the reminders.`);
  const c = input.recency;
  if (c && c.daysSince !== null) {
    const d = c.daysSince;
    add("recency", "Last contact", d <= 14 ? 100 : d <= 30 ? 85 : d <= 60 ? 60 : d <= 90 ? 35 : 10, `Last dealt with them ${d} days ago.`);
  }
  return out;
}

export interface Scored {
  score: number;
  band: HealthBand;
  components: HealthComponent[];
  missing: string[];
  /** True when enough parts have data for the score to raise an alert. */
  enoughData: boolean;
}

const PART_LABEL: Record<HealthPart, string> = {
  support: "Support",
  replyLatency: "Reply speed",
  billing: "Invoices",
  seo: "SEO health",
  uptime: "Website",
  responsiveness: "Answers our requests",
  recency: "Last contact",
};

/** The score: the parts with data, weighted and scaled to 100. With no data at all the score is 100 and `enoughData` false. */
export function scoreClientHealth(input: HealthInputs): Scored {
  const components = healthComponents(input);
  const have = new Set(components.map((c) => c.key));
  const missing = (Object.keys(HEALTH_WEIGHTS) as HealthPart[]).filter((key) => !have.has(key)).map((key) => PART_LABEL[key]);
  const weight = components.reduce((sum, c) => sum + c.weight, 0);
  const score = weight === 0 ? 100 : clamp(components.reduce((sum, c) => sum + c.score * c.weight, 0) / weight);
  return { score, band: bandOf(score), components, missing, enoughData: components.length >= MIN_PARTS_FOR_ALERT };
}

// ---------------------------------------------------------------------------
// Gathering the inputs
// ---------------------------------------------------------------------------

interface ActivityRow {
  record_id: string;
  kind: string;
  created_at: unknown;
}

async function recentActivities(ctx: PluginContext, companyId: string, recordIds: string[], sinceIso: string): Promise<Array<{ recordId: string; kind: string; at: number }>> {
  if (recordIds.length === 0) return [];
  const rows = await ctx.db.query<ActivityRow>(
    `SELECT record_id, kind, created_at FROM ${table(ctx, "activities")}
      WHERE company_id = $1 AND record_id = ANY(ARRAY(SELECT jsonb_array_elements_text($2::jsonb))) AND created_at >= $3::timestamptz
      LIMIT 3000`,
    [companyId, JSON.stringify(recordIds), sinceIso],
  );
  return rows.map((row) => ({ recordId: row.record_id, kind: row.kind, at: Date.parse(iso(row.created_at) ?? "") })).filter((row) => Number.isFinite(row.at));
}

/** Everything the score reads, for one client, from the CRM's own tables and the signals the other modules sent. */
export async function gatherHealthInputs(ctx: PluginContext, companyId: string, client: ClientKey, now = new Date()): Promise<HealthInputs> {
  const nowMs = now.getTime();
  const [cases, actions, feedback, signals, people, monitors, sites] = await Promise.all([
    listCases(ctx, companyId, client, 300),
    listActions(ctx, companyId, client, 200),
    listFeedback(ctx, companyId, client, 200),
    listSignals(ctx, companyId, client),
    clientContacts(ctx, companyId, client),
    listMonitors(ctx, companyId),
    listMonitorSites(ctx, companyId),
  ]);
  const inputs: HealthInputs = { ...EMPTY_INPUTS };

  const open = cases.filter((c) => c.status !== "resolved" && c.status !== "closed");
  if (cases.length > 0) {
    const csat = feedback.filter((f) => f.kind === "csat" && f.status === "answered" && f.score != null).sort((a, b) => Date.parse(b.answeredAt ?? "") - Date.parse(a.answeredAt ?? ""))[0];
    inputs.support = {
      open: open.length,
      // Past a target now, or flagged by the SLA job and still unanswered / unresolved.
      breached: open.filter((c) => {
        const sla = caseSla(c, nowMs);
        return sla.firstResponse === "breached" || sla.resolution === "breached" || (c.firstBreachedAt !== null && c.firstResponseAt === null) || c.resolutionBreachedAt !== null;
      }).length,
      urgentOpen: open.filter((c) => c.severity === "urgent").length,
      latestCsat: csat?.score ?? null,
    };
  }

  const ids = [client.id, ...people.map((person) => person.id)];
  const activities = await recentActivities(ctx, companyId, ids, new Date(nowMs - 365 * DAY_MS).toISOString());
  const worked = activities.filter((a) => WORK_KINDS.includes(a.kind));
  const received = activities.filter((a) => a.kind === "email_received" && nowMs - a.at <= 90 * DAY_MS);
  if (received.length > 0) {
    const late = received.filter((mail) => nowMs - mail.at > REPLY_LATE_HOURS * 3_600_000 && !worked.some((w) => w.at >= mail.at));
    inputs.replyLatency = { unanswered: late.length, oldestHours: late.length ? (nowMs - Math.min(...late.map((m) => m.at))) / 3_600_000 : null };
  }
  // Last contact: something a person logged, or an email from them (not the system's own bookkeeping).
  const contact = activities.filter((a) => WORK_KINDS.includes(a.kind) || a.kind === "email_received");
  const lastAny = contact.length ? Math.max(...contact.map((a) => a.at)) : null;
  inputs.recency = { daysSince: lastAny === null ? null : Math.max(0, Math.floor((nowMs - lastAny) / DAY_MS)) };

  const waiting = actions.filter((a) => a.status === "waiting" || a.status === "replied");
  if (actions.length > 0) inputs.responsiveness = { waiting: waiting.length, stale: waiting.filter((a) => a.escalatedAt).length };

  const billing = currentSignal(signals, "billing")?.health;
  if (billing && billing.overdueCount !== undefined) inputs.billing = { overdueCount: billing.overdueCount };
  const seo = currentSignal(signals, "seo")?.health;
  if (seo && seo.score !== undefined) inputs.seo = { score: seo.score };

  const own = sites.filter((site) => site.client.kind === client.kind && site.client.id === client.id);
  const states = new Map(monitors.map((m) => [m.siteId, m]));
  const checked = own.map((site) => ({ site, state: states.get(site.id) })).filter((row) => row.state && row.state.enabled && row.state.lastCheckedAt);
  if (checked.length > 0) {
    const period = now.toISOString().slice(0, 7);
    const figures = await Promise.all(checked.map((row) => uptimeFigures(ctx, companyId, row.site.id, period)));
    const pcts = figures.filter((f): f is NonNullable<typeof f> => f !== null).map((f) => f.pct);
    const tls = checked.map((row) => daysUntil(row.state!.tlsExpiresAt, nowMs)).filter((d): d is number => d !== null);
    inputs.uptime = {
      down: checked.some((row) => downMinutes(row.state!, nowMs) >= 5),
      tlsDays: tls.length ? Math.min(...tls) : null,
      monthPct: pcts.length ? Math.min(...pcts) : null,
      sites: checked.length,
    };
  }
  return inputs;
}

export async function computeClientHealth(ctx: PluginContext, companyId: string, client: ClientKey, now = new Date()): Promise<Scored> {
  return scoreClientHealth(await gatherHealthInputs(ctx, companyId, client, now));
}

// ---------------------------------------------------------------------------
// The daily job
// ---------------------------------------------------------------------------

export interface HealthRun {
  scored: number;
  atRisk: number;
  alerts: number;
}

/** Whether a new score raises the alert: at risk, or fallen a long way, with enough data, and not alerted within 30 days. */
export function shouldAlert(scored: Pick<Scored, "band" | "score" | "enoughData">, previous: Pick<HealthRecord, "score" | "alertedAt"> | null, now: number): boolean {
  if (!scored.enoughData) return false;
  const fell = previous !== null && previous.score - scored.score >= SHARP_DROP && scored.band !== "healthy";
  if (scored.band !== "at_risk" && !fell) return false;
  return !previous?.alertedAt || now - Date.parse(previous.alertedAt) > 30 * DAY_MS;
}

/** Scores every customer of the company, keeps the score, and opens the churn-risk issue for the ones that need it. */
export async function runHealthScores(ctx: PluginContext, companyId: string, now = new Date()): Promise<HealthRun> {
  const run: HealthRun = { scored: 0, atRisk: 0, alerts: 0 };
  for (const info of await customerClients(ctx, companyId)) {
    try {
      const previous = await getHealth(ctx, companyId, info.key);
      const scored = await computeClientHealth(ctx, companyId, info.key, now);
      const alert = !isInternalClient(info) && shouldAlert(scored, previous, now.getTime());
      if (alert) {
        await openChurnRiskIssue(ctx, companyId, info, scored, previous, now);
        run.alerts += 1;
      }
      await saveHealth(ctx, companyId, {
        client: info.key,
        score: scored.score,
        band: scored.band,
        components: scored.components,
        missing: scored.missing,
        computedAt: now.toISOString(),
        previousScore: previous?.score ?? null,
        previousBand: previous?.band ?? null,
        atRiskSince: scored.band === "at_risk" ? (previous?.band === "at_risk" ? previous.atRiskSince : now.toISOString()) : null,
        alertedAt: alert ? now.toISOString() : previous?.alertedAt ?? null,
      });
      run.scored += 1;
      if (scored.band === "at_risk") run.atRisk += 1;
    } catch (error) {
      ctx.logger.info("CRM health score skipped a client", { companyId, client: refOf(info.key.kind, info.key.id), error: error instanceof Error ? error.message : String(error) });
    }
  }
  return run;
}

async function openChurnRiskIssue(ctx: PluginContext, companyId: string, info: ClientInfo, scored: Scored, previous: HealthRecord | null, now: Date): Promise<string> {
  const prefix = await companyPrefix(ctx, companyId);
  const weak = [...scored.components].sort((a, b) => a.score - b.score).filter((c) => c.score < 75);
  return openIssueOnce(ctx, {
    companyId,
    originId: originFor.churnRisk(info.key.kind, info.key.id, now.toISOString().slice(0, 7)),
    title: `Churn risk: ${info.name} (health ${scored.score})`.slice(0, 200),
    description: [
      `${info.name}'s health score is **${scored.score} of 100** (${scored.band === "at_risk" ? "at risk" : "watch"})${previous ? `, ${previous.score >= scored.score ? "down" : "up"} from ${previous.score} at the last run` : ""}.`,
      "",
      "What is pulling it down:",
      ...(weak.length ? weak.map((c) => `- **${c.label}** (${c.score}): ${c.detail}`) : ["- Nothing stands out; it is the sum of small things."]),
      scored.missing.length ? `\nNot measured yet: ${scored.missing.join(", ")}.` : "",
      "",
      "Look at the whole client before you act: `get-company`, the open support cases (`list-support-cases`), what they are waiting on (`list-client-actions`), their last deals and notes. Then reach out: a call or a short note through a Mailbox draft a person approves, saying what you will fix and by when. Offer a review of the work if the results are the problem. Log it on the client (`log-activity`).",
      "",
      `Client: ${crmLink(prefix, info.key.kind, info.key.id)}`,
      "",
      "**Done when** your follow-up is logged on the client since this issue opened. Closing checks it.",
    ].filter((line, i, all) => line !== "" || all[i - 1] !== "").join("\n"),
    assignee: await teamAssignee(ctx, companyId),
    wakeReason: "A customer may be about to leave",
    projectId: await clientProjectOf(ctx, companyId, info.key),
    priority: scored.band === "at_risk" ? "high" : "medium",
  });
}

// ---------------------------------------------------------------------------
// Tool, workspace and Cockpit
// ---------------------------------------------------------------------------

function scoreOut(client: ClientKey, name: string, scored: Pick<Scored, "score" | "band" | "components" | "missing">, extra: Record<string, unknown> = {}) {
  return {
    client: refOf(client.kind, client.id),
    name,
    score: scored.score,
    band: scored.band,
    parts: scored.components.map((c) => ({ part: c.label, score: c.score, weight: c.weight, why: c.detail })),
    notMeasured: scored.missing,
    ...extra,
  };
}

/** `client-health`: one client scored fresh, or the stored scores of every customer, weakest first. */
export async function clientHealthTool(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  if (params.client != null && params.client !== "") {
    const client = parseClientRef(params.client);
    const name = await requireClient(ctx, viewer, client);
    const previous = await getHealth(ctx, viewer.companyId, client);
    return scoreOut(client, name, await computeClientHealth(ctx, viewer.companyId, client), { previousScore: previous?.score ?? null, computedFresh: true });
  }
  // Only the clients this viewer may see: the same rule the CRM's other lists follow.
  const seen = await visibleClients(ctx, viewer);
  const names = new Map((await customerClients(ctx, viewer.companyId)).filter((info) => seen.has(info.key.kind, info.key.id)).map((info) => [`${info.key.kind}:${info.key.id}`, info.name]));
  const rows = (await listHealth(ctx, viewer.companyId)).filter((h) => names.has(`${h.client.kind}:${h.client.id}`) && (params.onlyAtRisk === true ? h.band === "at_risk" : true));
  return {
    count: rows.length,
    clients: rows.slice(0, 50).map((h) => ({ client: refOf(h.client.kind, h.client.id), name: names.get(`${h.client.kind}:${h.client.id}`) ?? "", score: h.score, band: h.band, previousScore: h.previousScore, atRiskSince: h.atRiskSince, computedAt: h.computedAt })),
    note: rows.length === 0 ? "No scores yet: the daily job scores every customer, or pass a client to score one now." : undefined,
  };
}

/** The workspace card: the client's stored score (computed fresh when there is none yet). */
export async function clientHealthView(ctx: PluginContext, companyId: string, client: ClientKey) {
  const info = await clientInfo(ctx, companyId, client);
  if (!info) return null;
  const stored = await getHealth(ctx, companyId, client);
  if (stored) return { score: stored.score, band: stored.band, parts: stored.components.map((c) => ({ part: c.label, score: c.score, why: c.detail })), notMeasured: stored.missing, computedAt: stored.computedAt, previousScore: stored.previousScore, customer: info.lifecycle === "customer" };
  if (info.lifecycle !== "customer") return null;
  const scored = await computeClientHealth(ctx, companyId, client);
  return { score: scored.score, band: scored.band, parts: scored.components.map((c) => ({ part: c.label, score: c.score, why: c.detail })), notMeasured: scored.missing, computedAt: null, previousScore: null, customer: true };
}

/** Cockpit: customers in the risk band. Amber, not red: it is a prompt to act, not a fault in the system. */
export async function clientsAtRiskHealth(ctx: PluginContext, companyId: string): Promise<HealthCheck> {
  const names = new Map((await customerClients(ctx, companyId)).filter((info) => !isInternalClient(info)).map((info) => [`${info.key.kind}:${info.key.id}`, info.name]));
  const risk = (await listHealth(ctx, companyId)).filter((h) => h.band === "at_risk" && names.has(`${h.client.kind}:${h.client.id}`));
  if (risk.length === 0) return { key: "clients:health", title: "Customer health", status: "ok", detail: names.size ? `${names.size} customer${names.size === 1 ? "" : "s"} scored, none at risk.` : "No customers to score yet." };
  return {
    key: "clients:health",
    title: "Customer health",
    status: "warn",
    detail: `${risk.length} customer${risk.length === 1 ? " is" : "s are"} at risk of leaving: ${risk.slice(0, 3).map((h) => `${names.get(`${h.client.kind}:${h.client.id}`)} (${h.score})`).join(", ")}${risk.length > 3 ? ", ..." : ""}.`,
    href: "/crm",
    fix: "The Account Manager has a churn-risk issue for each. Reach out, fix what is wrong, and log it on the client.",
    since: risk.map((h) => h.atRiskSince).filter((at): at is string => Boolean(at)).sort()[0] ?? null,
  };
}

