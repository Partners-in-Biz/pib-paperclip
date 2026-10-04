/**
 * Ads snapshot for the Company Cockpit (`GET /cockpit` and the hourly `cockpit.snapshot` event, kit cockpit.ts). Read-only and cheap: a few SELECTs
 * on our own tables and kit job/state reads, no platform calls. Every part is wrapped so one failing query never breaks the snapshot.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  TEAM_ROLES,
  emptySnapshot,
  jobHealth,
  publishCockpitSnapshot,
  teamSetupPath,
  type ActivityItem,
  type CockpitKpi,
  type CockpitSnapshot,
  type HealthCheck,
  type QualityMetric,
  type TeamMemberReport,
  type TeamRoleKey,
  type Tone,
  type WaitingItem,
} from "@partnersinbiz/pib-plugin-kit";
import { agentSummary } from "./agent.js";
import { addDays } from "./dates.js";
import { clientNames, listAccounts, listAlerts, listAudit, listConnections, listProposals, listScopes, summaryRows, type ProposalRow } from "./db.js";
import { errorMessage, scopeLabelOf } from "./domain.js";
import { derive, sumRows } from "./metrics.js";
import { formatMoney } from "./money.js";
import { knownCompanies, adsOn } from "./modules.js";
import { loadAdsConfig } from "./config.js";
import { scopePace } from "./pacing.js";
import { ADS_ROLE_KEY, PLUGIN_ID, PROPOSAL_KIND_LABELS, SPEND_KINDS, platformLabel } from "./platforms.js";
import { runtimeFor, type AdsRuntime } from "./runtime.js";
import { todayIn } from "./dates.js";

/** Scheduled jobs and their interval in minutes (manifest schedules). */
export const ADS_JOBS: Array<{ key: string; title: string; everyMinutes: number }> = [
  { key: "sync-insights", title: "Read ad numbers", everyMinutes: 180 },
  { key: "refresh-connections", title: "Keep sign-ins alive", everyMinutes: 60 },
  { key: "setup-status", title: "Report setup status", everyMinutes: 60 },
];

const ADS = "/ads";
const ACCOUNTS = "/ads?tab=accounts";
const PROPOSALS = "/ads?tab=changes";
const BUDGETS = "/ads?tab=budgets";

async function part<T>(ctx: PluginContext, label: string, run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    ctx.logger.info("Ads cockpit part failed", { part: label, error: errorMessage(error) });
    return fallback;
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Spend of one currency this month, per scope currency, plus the worst budget state. */
async function kpis(rt: AdsRuntime): Promise<CockpitKpi[]> {
  const ctx = rt.ctx;
  const companyId = rt.companyId;
  const out: CockpitKpi[] = [];
  const scopes = await listScopes(ctx, companyId);
  if (scopes.length === 0) return out;
  const today = todayIn(rt.config.timezone, rt.now());
  const month = `${today.slice(0, 7)}-01`;
  const rows = await summaryRows(ctx, companyId, { since: month, until: today, groupBy: "scope" });
  const byCurrency = new Map<string, number>();
  for (const r of rows) byCurrency.set(r.currency, (byCurrency.get(r.currency) ?? 0) + r.spend);
  const spendText = [...byCurrency.entries()].map(([c, v]) => formatMoney(v, c)).join(" + ") || "0";
  let worst: { label: string; pct: number; state: string } | null = null;
  const names = await clientNames(ctx, companyId);
  for (const scope of scopes) {
    const sp = await scopePace(rt, scope);
    if (sp.pace.pctUsed !== null && (!worst || sp.pace.pctUsed > worst.pct)) worst = { label: scopeLabelOf(scope.scope_key, names[scope.scope_key]), pct: sp.pace.pctUsed, state: sp.pace.state };
  }
  out.push({ key: "ads_spend", label: "Ad spend this month", value: spendText, hint: worst ? `${Math.round(worst.pct * 100)}% of the budget used (${worst.label})` : "No budget cap set yet", raw: [...byCurrency.values()].reduce((a, b) => a + b, 0), tone: worst?.state === "over" ? "bad" : worst?.state === "alert" || worst?.state === "watch" ? "warn" : "neutral", href: BUDGETS, group: "marketing" });
  const week = await summaryRows(ctx, companyId, { since: addDays(today, -6), until: today, groupBy: "platform" });
  const single = new Set(week.map((r) => r.currency));
  if (week.length > 0 && single.size === 1) {
    const t = sumRows(week.map((r) => ({ spend: r.spend, impressions: r.impressions, clicks: r.clicks, conversions: r.conversions, value: r.value })));
    const d = derive(t);
    const currency = week[0]!.currency;
    out.push({ key: "ads_cpa", label: "Cost per result (7 days)", value: d.cpa === null ? "n/a" : formatMoney(d.cpa, currency), hint: d.roas === null ? `${t.conversions} results` : `${t.conversions} results, ${d.roas}x return`, raw: d.cpa, tone: "neutral", href: ADS, group: "marketing" });
  }
  const open = await listProposals(ctx, companyId, { open: true, limit: 200 });
  const waiting = open.filter((p) => p.status === "in_review" || p.status === "approved").length;
  out.push({ key: "ads_changes", label: "Ad changes waiting", value: String(open.length), hint: open.length === 0 ? "None open" : `${waiting} waiting for a person or the Reviewer`, raw: open.length, tone: waiting > 0 ? "warn" : "neutral", href: PROPOSALS, group: "marketing" });
  const alerts = await listAlerts(ctx, companyId, { status: "open", limit: 200 });
  out.push({ key: "ads_alerts", label: "Ad alerts", value: String(alerts.length), hint: alerts.length === 0 ? "Nothing unusual" : `${alerts.filter((a) => a.severity === "bad").length} serious`, raw: alerts.length, tone: alerts.some((a) => a.severity === "bad") ? "bad" : alerts.length ? "warn" : "ok", href: `${ADS}?tab=alerts`, group: "marketing" });
  return out;
}

async function healthChecks(rt: AdsRuntime, agentId: string | null): Promise<HealthCheck[]> {
  const ctx = rt.ctx;
  const companyId = rt.companyId;
  const checks: HealthCheck[] = [];
  for (const job of ADS_JOBS) checks.push(await jobHealth(ctx, job.key, job.title, job.everyMinutes));
  const connections = await listConnections(ctx, companyId);
  for (const c of connections) {
    if (c.status === "needs_reconnect") checks.push({ key: `connection:${c.id}`, title: `${platformLabel(c.platform)} sign-in`, status: "bad", detail: c.status_detail ?? "The platform stopped accepting the sign-in, so numbers stop updating.", fix: "A person signs in again on the Ads page (Accounts).", href: ACCOUNTS, since: c.last_ok_at });
    else if (c.status === "expiring") checks.push({ key: `connection:${c.id}`, title: `${platformLabel(c.platform)} sign-in`, status: "warn", detail: c.status_detail ?? "The sign-in is close to expiring and could not be renewed.", fix: "Sign in again on the Ads page (Accounts) before it lapses.", href: ACCOUNTS });
  }
  const accounts = await listAccounts(ctx, companyId);
  const failing = accounts.filter((a) => a.status === "active" && a.consecutive_failures >= 3);
  if (failing.length) checks.push({ key: "ads:sync", title: "Ad numbers updating", status: "warn", detail: `${plural(failing.length, "ad account")} could not be read for 3 runs or more: ${failing.slice(0, 3).map((a) => `${a.name} (${(a.last_sync_error ?? "no detail").slice(0, 80)})`).join("; ")}.`, fix: "Open the Ads page (Accounts); the plugin opens an issue when a sign-in is the cause.", href: ACCOUNTS });
  const scopes = await listScopes(ctx, companyId);
  const names = await clientNames(ctx, companyId);
  for (const scope of scopes) {
    const live = accounts.filter((a) => a.scope_key === scope.scope_key && a.status === "active");
    if (live.length === 0) continue;
    const label = scopeLabelOf(scope.scope_key, names[scope.scope_key]);
    const sp = await scopePace(rt, scope);
    if (sp.pace.capMinor === null) checks.push({ key: `cap:${scope.scope_key}`, title: `Budget cap: ${label}`, status: "warn", detail: "No monthly budget cap is set, so no change that adds spend can run and the budget alerts cannot fire.", fix: "A person sets the cap on the Ads page (Budgets).", href: BUDGETS });
    else if (sp.pace.state === "over") checks.push({ key: `cap:${scope.scope_key}`, title: `Budget cap: ${label}`, status: "bad", detail: `${Math.round((sp.pace.pctUsed ?? 0) * 100)}% of ${formatMoney(sp.pace.capMinor, scope.currency)} is spent.`, fix: "Decide the pause request or raise the cap.", href: PROPOSALS });
    else if (sp.pace.state === "alert") checks.push({ key: `cap:${scope.scope_key}`, title: `Budget cap: ${label}`, status: "warn", detail: `${Math.round((sp.pace.pctUsed ?? 0) * 100)}% of ${formatMoney(sp.pace.capMinor, scope.currency)} is spent, ${sp.pace.daysLeft} days left.`, fix: "Decide the pause request or raise the cap.", href: PROPOSALS });
    if (sp.mismatchedAccounts > 0) checks.push({ key: `currency:${scope.scope_key}`, title: `Currency: ${label}`, status: "warn", detail: `${plural(sp.mismatchedAccounts, "ad account")} in another currency than the scope's ${scope.currency}: left out of its totals and cap.`, fix: "Register that account under another scope.", href: ACCOUNTS });
  }
  if (accounts.length > 0 && !agentId) checks.push({ key: "ads:agent", title: "Paid Ads Manager", status: "warn", detail: "Ad accounts are connected but no agent is linked to watch alerts and prepare changes.", fix: "Hire or link the agent in Setup -> Team.", href: teamSetupPath(ADS_ROLE_KEY as TeamRoleKey) });
  return checks;
}

function proposalWaiting(p: ProposalRow, names: Record<string, string>): WaitingItem {
  const label = scopeLabelOf(p.scope_key, names[p.scope_key]);
  const money = SPEND_KINDS.includes(p.kind) || p.origin.startsWith("budget_");
  const missing = p.status === "in_review" && p.review_state !== "pending" ? "your yes" : p.status === "in_review" ? "the Reviewer, then your yes" : p.status === "approved" ? "to be run (or marked done)" : "changes by the ads agent";
  return {
    key: `ads-proposal:${p.id}`,
    title: `${PROPOSAL_KIND_LABELS[p.kind]} for ${label}: ${p.title}`.slice(0, 160),
    why: `Waiting for ${missing}. ${p.cap_state === "exceeds" ? "It goes over the month's cap. " : ""}Nothing changes in any ad platform until a person approves.`,
    href: PROPOSALS,
    issueId: p.approval_issue_id,
    kind: money ? "money" : "review",
    since: p.created_at,
  };
}

async function waitingItems(ctx: PluginContext, companyId: string): Promise<WaitingItem[]> {
  const names = await clientNames(ctx, companyId);
  const proposals = await listProposals(ctx, companyId, { open: true, limit: 50 });
  return proposals.map((p) => proposalWaiting(p, names));
}

async function activityItems(ctx: PluginContext, companyId: string): Promise<ActivityItem[]> {
  const interesting = new Set(["write.executed", "write.failed", "proposal.created", "proposal.approved", "proposal.rejected", "pause_requested", "alert.raised", "connection.created", "writes.enabled", "writes.disabled", "budget.cap_set"]);
  const words: Record<string, string> = {
    "write.executed": "Ran an approved ad change",
    "write.failed": "An approved ad change did not complete",
    "proposal.created": "Proposed an ad change",
    "proposal.approved": "A person approved an ad change",
    "proposal.rejected": "A person refused an ad change",
    pause_requested: "Asked to pause ads: the budget is nearly used",
    "alert.raised": "Raised an ads alert",
    "connection.created": "Connected an ad platform",
    "writes.enabled": "Switched ad changes on for a scope",
    "writes.disabled": "Switched ad changes off for a scope",
    "budget.cap_set": "Set a monthly ad budget cap",
  };
  return (await listAudit(ctx, companyId, 60))
    .filter((a) => interesting.has(a.action) && a.at)
    .slice(0, 10)
    .map((a) => ({ at: a.at!, text: `${words[a.action] ?? a.action}${typeof a.detail.title === "string" ? `: ${a.detail.title}` : ""}`, href: ADS }));
}

async function qualityMetrics(ctx: PluginContext, companyId: string): Promise<QualityMetric[]> {
  const proposals = await listProposals(ctx, companyId, { limit: 300 });
  const decided = proposals.filter((p) => ["approved", "executed", "cleared", "rejected", "failed"].includes(p.status));
  if (decided.length === 0) return [];
  const refused = decided.filter((p) => p.status === "rejected").length;
  const failed = decided.filter((p) => p.status === "failed").length;
  const tone = (rate: number, warn: number, bad: number): Tone => (rate > bad ? "bad" : rate > warn ? "warn" : "ok");
  return [
    { key: "ads_refused_rate", label: "Ad proposals refused", value: `${Math.round((refused / decided.length) * 100)}%`, raw: refused / decided.length, tone: tone(refused / decided.length, 0.3, 0.6) },
    { key: "ads_failed_runs", label: "Approved changes that failed", value: String(failed), raw: failed, tone: failed > 0 ? "warn" : "ok" },
  ];
}

/** The role is reported to the Cockpit only when the shared kit knows it (an unknown role key could confuse its team view). */
async function teamReport(ctx: PluginContext, companyId: string): Promise<TeamMemberReport[] | undefined> {
  if (!TEAM_ROLES.some((r) => (r.key as string) === ADS_ROLE_KEY)) return undefined;
  const agent = await agentSummary(ctx, companyId);
  return [{ role: ADS_ROLE_KEY as TeamRoleKey, agentId: agent.agentId, status: agent.status }];
}

export async function cockpitSnapshot(ctx: PluginContext, companyId: string, rtOverride?: AdsRuntime): Promise<CockpitSnapshot> {
  const rt = rtOverride ?? (await runtimeFor(ctx, companyId));
  const snap = emptySnapshot(PLUGIN_ID, "Paid ads");
  const agent = await part(ctx, "agent", () => agentSummary(ctx, companyId), null);
  snap.kpis = await part(ctx, "kpis", () => kpis(rt), [] as CockpitKpi[]);
  snap.health = await part(ctx, "health", () => healthChecks(rt, agent?.agentId ?? null), [] as HealthCheck[]);
  snap.waiting = await part(ctx, "waiting", () => waitingItems(ctx, companyId), [] as WaitingItem[]);
  snap.activity = await part(ctx, "activity", () => activityItems(ctx, companyId), [] as ActivityItem[]);
  snap.quality = await part(ctx, "quality", () => qualityMetrics(ctx, companyId), [] as QualityMetric[]);
  const team = await part(ctx, "team", () => teamReport(ctx, companyId), undefined);
  if (team) snap.team = team;
  return snap;
}

/** Hourly: push each company's snapshot. Skips companies whose Ads module is off or whose settings were never saved. */
export async function publishCockpitSnapshots(ctx: PluginContext): Promise<{ published: number; skipped: number }> {
  const result = { published: 0, skipped: 0 };
  for (const companyId of await knownCompanies(ctx)) {
    try {
      if (!(await adsOn(ctx, companyId)) || !(await loadAdsConfig(ctx, companyId)).saved) {
        result.skipped += 1;
        continue;
      }
      await publishCockpitSnapshot(ctx, companyId, await cockpitSnapshot(ctx, companyId));
      result.published += 1;
    } catch (error) {
      result.skipped += 1;
      ctx.logger.info("Ads cockpit snapshot skipped", { companyId, error: errorMessage(error) });
    }
  }
  return result;
}

