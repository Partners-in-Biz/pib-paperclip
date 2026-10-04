/**
 * After a sync: turn the rollups into alerts, and the budget alerts into pause requests. This never changes an ad and never pauses anything:
 * at 90% of a scope's monthly cap (the scope's own alert point) it opens a proposal "pause these campaigns" that goes to the Reviewer and a
 * person like every other change. Alerts carry a dedupe key, so the same anomaly is one alert however often it is seen.
 */
import { detectCpaOverTarget, detectSpendSpike, detectZeroDelivery, budgetAlerts, type AlertCandidate, type SeriesPoint } from "./alerts.js";
import {
  audit,
  clientName,
  dailyRows,
  findAlert,
  getAlert,
  hasAudit,
  insertAlert,
  listAccounts,
  listAlerts,
  listCampaigns,
  listProposals,
  listScopes,
  setAlertIssue,
  setAlertState,
  touchAlert,
  type AccountRow,
  type ScopeRow,
  type DayRow,
} from "./db.js";
import { addDays } from "./dates.js";
import { errorMessage, scopeLabelOf } from "./domain.js";
import { adsAssignee, openIssueOnce, projectForScope, note } from "./issues.js";
import { scopePace } from "./pacing.js";
import { ADS_ORIGINS, ALERT_LABELS, OPEN_PROPOSAL_STATUSES, type AlertKind } from "./platforms.js";
import { createProposal } from "./proposals.js";
import type { AdsRuntime } from "./runtime.js";

/** More open alert issues than this and new alerts are recorded (the Cockpit and the page show them) without opening another issue. */
export const MAX_OPEN_ALERT_ISSUES = 8;
const FRESH_SYNC_MS = 12 * 3_600_000;
const FAILING_SYNC_RUNS = 3;
const STALE_SYNC_MS = 26 * 3_600_000;

export interface EvaluateResult {
  alertsNew: number;
  alertsSeen: number;
  issuesOpened: number;
  pauseRequests: number;
  errors: string[];
}

/** Records an alert (once per dedupe key) and, when it needs somebody, opens one issue for the ads agent. */
async function raise(rt: AdsRuntime, scope: ScopeRow, candidate: AlertCandidate, ref: { accountId?: string | null; campaignExternalId?: string | null }, result: EvaluateResult, options: { issue: boolean }): Promise<string> {
  const existing = await findAlert(rt.ctx, rt.companyId, candidate.dedupeKey);
  if (existing) {
    await touchAlert(rt.ctx, rt.companyId, existing.id, { body: candidate.text, detail: candidate.detail, severity: candidate.severity });
    result.alertsSeen += 1;
    return existing.id;
  }
  const id = await insertAlert(rt.ctx, rt.companyId, {
    scopeKey: scope.scope_key,
    accountId: ref.accountId ?? null,
    campaignExternalId: ref.campaignExternalId ?? null,
    kind: candidate.kind,
    severity: candidate.severity,
    dedupeKey: candidate.dedupeKey,
    title: candidate.title,
    body: candidate.text,
    detail: candidate.detail,
  });
  result.alertsNew += 1;
  await audit(rt.ctx, rt.companyId, { actor: "system", action: "alert.raised", scopeKey: scope.scope_key, subject: id, detail: { kind: candidate.kind, title: candidate.title } });
  if (options.issue && candidate.severity !== "info") {
    const open = (await listAlerts(rt.ctx, rt.companyId, { status: "open", limit: 200 })).filter((a) => a.issue_id).length;
    if (open < MAX_OPEN_ALERT_ISSUES) {
      const name = await clientName(rt.ctx, rt.companyId, scope.scope_key);
      const opened = await openIssueOnce(rt.ctx, {
        companyId: rt.companyId,
        originId: `${ADS_ORIGINS.alert}${id}`,
        title: `${ALERT_LABELS[candidate.kind]}: ${candidate.title.replace(/^[^:]+:\s*/, "")} (${scopeLabelOf(scope.scope_key, name)})`.slice(0, 200),
        description: [
          candidate.text,
          "",
          "Look at it with `get-ads-summary` and `list-ad-campaigns` for this scope, then decide:",
          "- It is fine or expected: `acknowledge-ad-alert` with a one-line note.",
          "- It needs a change (pause, a new budget): `propose-ad-change`. You never change ads yourself; a person approves.",
          "- It is a platform or account problem (ads rejected, payment failed): ask the owner once with the ask tool, with the exact screen.",
          "",
          `Alert id: \`${id}\`. Acknowledging it closes this issue's check.`,
        ].join("\n"),
        assignee: await adsAssignee(rt.ctx, rt.companyId),
        projectId: await projectForScope(rt.ctx, rt.companyId, scope.scope_key),
        wakeReason: "An ads alert needs a look",
        priority: candidate.severity === "bad" ? "high" : "medium",
      });
      await setAlertIssue(rt.ctx, rt.companyId, id, opened.id);
      result.issuesOpened += 1;
    }
  }
  return id;
}

/** A request nobody answered is asked again, at most this many times in a month (each one is also a week of waiting). */
export const MAX_UNANSWERED_PAUSE_REQUESTS = 3;

/**
 * The pause request a budget alert asks for: every active campaign of the scope, with its spend this month. It never lets a fully spent budget go
 * quiet, and it never nags:
 * - a request still open gets ONE note when the budget reaches 100% (not one per look);
 * - a person's no (refused, cancelled) is a decision: the same trigger is not asked again that month, but 100% after a no at 90% is worse news and is
 *   asked once;
 * - a request that expired unanswered is asked again (3 times a month at most), because nobody has looked at it yet;
 * - a pause that ran is the answer.
 */
async function requestPause(rt: AdsRuntime, scope: ScopeRow, trigger: "budget_90" | "budget_100", result: EvaluateResult): Promise<void> {
  const sp = await scopePace(rt, scope);
  const base = `pause:${scope.scope_key}:${sp.month}`;
  const asked = (await listProposals(rt.ctx, rt.companyId, { scopeKey: scope.scope_key, limit: 100 })).filter((p) => p.origin_ref === base || p.origin_ref?.startsWith(`${base}:`));
  const open = asked.find((p) => OPEN_PROPOSAL_STATUSES.includes(p.status));
  if (open) {
    if (trigger === "budget_100" && open.approval_issue_id && !(await hasAudit(rt.ctx, rt.companyId, "pause_request.full_budget_noted", open.id))) {
      await note(rt.ctx, rt.companyId, open.approval_issue_id, `The budget is now fully used (${Math.round((sp.pace.pctUsed ?? 0) * 100)}%). Ads that keep running spend money the budget does not cover.`);
      await audit(rt.ctx, rt.companyId, { actor: "system", action: "pause_request.full_budget_noted", scopeKey: scope.scope_key, subject: open.id });
    }
    return;
  }
  if (asked.some((p) => p.status === "executed")) return;
  if (asked.length > 0) {
    const unanswered = asked.filter((p) => p.status === "expired").length;
    const worse = trigger === "budget_100" && !asked.some((p) => p.origin === "budget_100");
    if (!worse && !(unanswered > 0 && unanswered < MAX_UNANSWERED_PAUSE_REQUESTS)) return;
  }
  const originRef = asked.length === 0 ? base : `${base}:${asked.length + 1}`;
  const campaigns = (await listCampaigns(rt.ctx, rt.companyId, { scopeKey: scope.scope_key, status: "active", limit: 100 })).filter((c) => c.currency === scope.currency);
  if (campaigns.length === 0) return;
  const accounts = new Map((await listAccounts(rt.ctx, rt.companyId, { scopeKey: scope.scope_key })).map((a) => [a.id, a]));
  const targets = campaigns.filter((c) => accounts.get(c.account_id)?.status === "active").map((c) => ({ accountId: c.account_id, campaignExternalId: c.external_id }));
  if (targets.length === 0) return;
  const used = Math.round((sp.pace.pctUsed ?? 0) * 100);
  const created = await createProposal(rt, {}, {
    kind: "pause_campaign",
    scopeKey: scope.scope_key,
    targets,
    trigger,
    reason: `The month's budget is ${used}% used (${sp.pace.spentMinor} of ${sp.pace.capMinor} minor units) with ${sp.pace.daysLeft} days left. Pausing keeps spend inside the cap; a person decides, and can raise the cap instead.`,
    origin: trigger,
    originRef,
  });
  result.pauseRequests += 1;
  await audit(rt.ctx, rt.companyId, { actor: "system", action: "pause_requested", scopeKey: scope.scope_key, subject: created.proposalId, detail: { trigger, pctUsed: used } });
}

function seriesOf(rows: DayRow[]): SeriesPoint[] {
  return rows.map((r) => ({ day: r.day, spend: r.spend, impressions: r.impressions, clicks: r.clicks, conversions: r.conversions, value: r.value }));
}

/** Failing syncs and flat-lined numbers are alerts too: a dashboard that stopped updating must say so. */
function syncCandidate(account: AccountRow, now: Date): AlertCandidate | null {
  if (account.status !== "active") return null;
  const last = account.last_sync_ok_at ? Date.parse(account.last_sync_ok_at) : null;
  const stale = last !== null && now.getTime() - last > STALE_SYNC_MS;
  if (account.consecutive_failures < FAILING_SYNC_RUNS && !stale) return null;
  const detail = account.last_sync_error ? ` Last error: ${account.last_sync_error.slice(0, 200)}` : "";
  return {
    kind: "sync_failed",
    severity: "warn",
    dedupeKey: `sync:${account.id}:${now.toISOString().slice(0, 10)}`,
    title: `Numbers not updating: ${account.name}`,
    text: `${account.name} has not synced successfully${last ? ` since ${new Date(last).toISOString().slice(0, 16).replace("T", " ")} UTC` : " yet"} (${account.consecutive_failures} failed runs in a row), so its spend, alerts and budget are out of date.${detail}`,
    detail: { accountId: account.id, failures: account.consecutive_failures, lastOkAt: account.last_sync_ok_at },
  };
}

export async function evaluateCompany(rt: AdsRuntime): Promise<EvaluateResult> {
  const result: EvaluateResult = { alertsNew: 0, alertsSeen: 0, issuesOpened: 0, pauseRequests: 0, errors: [] };
  const now = rt.now();
  for (const scope of await listScopes(rt.ctx, rt.companyId)) {
    try {
      const accounts = (await listAccounts(rt.ctx, rt.companyId, { scopeKey: scope.scope_key })).filter((a) => a.status === "active");
      if (accounts.length === 0) continue;
      const name = await clientName(rt.ctx, rt.companyId, scope.scope_key);
      const label = scopeLabelOf(scope.scope_key, name);
      const sp = await scopePace(rt, scope);
      for (const candidate of budgetAlerts({ scopeKey: scope.scope_key, scopeLabel: label, pace: sp.pace, currency: scope.currency, alertPct: scope.alert_pct })) {
        // The budget alert's action is the pause request below; its own issue would only repeat it.
        await raise(rt, scope, candidate, {}, result, { issue: false });
        if (candidate.kind === "budget_90" || candidate.kind === "budget_100") await requestPause(rt, scope, candidate.kind, result);
      }
      for (const account of accounts) {
        const syncProblem = syncCandidate(account, now);
        if (syncProblem) await raise(rt, scope, syncProblem, { accountId: account.id }, result, { issue: true });
        const fresh = account.last_sync_ok_at ? now.getTime() - Date.parse(account.last_sync_ok_at) < FRESH_SYNC_MS : false;
        const rows = await dailyRows(rt.ctx, rt.companyId, addDays(sp.today, -14), account.id);
        const campaigns = new Map((await listCampaigns(rt.ctx, rt.companyId, { accountId: account.id, limit: 300 })).map((c) => [c.external_id, c]));
        const byCampaign = new Map<string, DayRow[]>();
        for (const row of rows) byCampaign.set(row.campaign_external_id, [...(byCampaign.get(row.campaign_external_id) ?? []), row]);
        for (const campaign of campaigns.values()) {
          if (campaign.status === "archived") continue;
          const series = seriesOf(byCampaign.get(campaign.external_id) ?? []);
          const ref = { accountId: account.id, externalId: campaign.external_id, name: campaign.name, status: campaign.status };
          const candidates = [
            detectSpendSpike({ campaign: ref, series, currency: account.currency, config: rt.config.alerts }),
            detectZeroDelivery({ campaign: ref, series, today: sp.today, syncFresh: fresh, config: rt.config.alerts }),
            detectCpaOverTarget({ campaign: ref, series, today: sp.today, targetCpaMinor: scope.target_cpa_minor, currency: account.currency, config: rt.config.alerts }),
          ].filter((c): c is AlertCandidate => c !== null);
          for (const c of candidates) await raise(rt, scope, c, { accountId: account.id, campaignExternalId: campaign.external_id }, result, { issue: true });
        }
      }
    } catch (error) {
      result.errors.push(`${scope.scope_key}: ${errorMessage(error)}`);
      rt.ctx.logger.info("Ads evaluation skipped a scope", { scopeKey: scope.scope_key, error: errorMessage(error) });
    }
  }
  return result;
}

/** Alerts that were not seen for a week are resolved (the anomaly passed); a budget alert is a month's, so it ends with the month. */
export async function resolveStaleAlerts(rt: AdsRuntime, days = 7): Promise<number> {
  let n = 0;
  for (const alert of await listAlerts(rt.ctx, rt.companyId, { status: "open", limit: 300 })) {
    if (alert.last_seen_at && rt.now().getTime() - Date.parse(alert.last_seen_at) > days * 86_400_000) {
      await setAlertState(rt.ctx, rt.companyId, alert.id, "resolved", "Not seen again for a week.");
      n += 1;
    }
  }
  return n;
}

export async function acknowledgeAlert(rt: AdsRuntime, actor: { userId?: string | null; agentId?: string | null }, alertId: string, noteText: string): Promise<void> {
  const alert = await getAlert(rt.ctx, rt.companyId, alertId);
  if (!alert) throw new Error("That alert was not found.");
  await setAlertState(rt.ctx, rt.companyId, alertId, "acknowledged", noteText.slice(0, 400));
  await audit(rt.ctx, rt.companyId, { actor: actor.userId ? `user:${actor.userId}` : actor.agentId ? `agent:${actor.agentId}` : "system", action: "alert.acknowledged", scopeKey: alert.scope_key, subject: alertId, detail: { note: noteText.slice(0, 200) } });
}

export type { AlertKind };
