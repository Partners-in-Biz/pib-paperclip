/**
 * Reads for the agent tools and the page, and the settings a person (or, for the harmless ones, the agent) changes on a scope.
 * Money out is always minor units with its currency, plus a formatted text so an agent never has to do currency maths.
 */
import { parseClientParam, type ClientScope } from "@partnersinbiz/pib-plugin-kit";
import {
  audit,
  budgetOverrides,
  clientName,
  clientNames,
  dailyRows,
  ensureScope,
  getAccount,
  getAlert,
  getProposal,
  listAccounts,
  listAlerts,
  listApprovals,
  listAudit,
  listCampaigns,
  listConnections,
  listLedger,
  listProposals,
  listScopes,
  setBudgetOverride,
  summaryRows,
  updateScope,
  type GroupBy,
  type ProposalRow,
  type ScopeRow,
} from "./db.js";
import { AdsError, actorText, minorField, optionalChoice, scopeKeyOf, scopeLabelOf, scopeOfKey, stringList, validScopeKey } from "./domain.js";
import { addDays, isDay, isMonth, monthEnd, monthOf, monthStart, todayIn } from "./dates.js";
import { connectionView, requireConnection } from "./connections.js";
import { describeAccounts } from "./accounts.js";
import { derive, sumRows, withDerived, type Totals } from "./metrics.js";
import { formatMoney, pct } from "./money.js";
import { scopePace } from "./pacing.js";
import { OWN_SCOPE, PROPOSAL_KIND_LABELS, STATUS_LABELS, platformLabel, type ScopeKey } from "./platforms.js";
import { impactLines, impactOf, numberLines, clientMessage } from "./proposal-text.js";
import type { AdsRuntime } from "./runtime.js";
import { signoffState } from "./signoffs.js";
import { agentSummary } from "./agent.js";

export interface RecordActor {
  userId?: string | null;
  agentId?: string | null;
}

/** A tool's `client` parameter: nothing is PiB's own ads; `company:<id>` / `contact:<id>` is one client. */
export function scopeFromParams(params: Record<string, unknown>): ScopeKey | undefined {
  const raw = params.client ?? params.scopeKey;
  if (raw === undefined) return undefined;
  if (raw === null || raw === "" || raw === "own") return OWN_SCOPE;
  if (typeof raw === "string") {
    const scope: ClientScope = parseClientParam(raw);
    if (!scope) throw new AdsError('client must be "company:<id>" or "contact:<id>" (leave it out for PiB\'s own ads).');
    return scopeKeyOf(scope);
  }
  if (typeof raw === "object") {
    const o = raw as { kind?: unknown; id?: unknown };
    if ((o.kind === "company" || o.kind === "contact") && typeof o.id === "string") return `${o.kind}:${o.id}`;
  }
  throw new AdsError('client must be "company:<id>" or "contact:<id>".');
}

export interface Period {
  since: string;
  until: string;
  label: string;
}

export function periodFrom(params: Record<string, unknown>, today: string): Period {
  const choice = optionalChoice(params, "period", ["last_7d", "last_30d", "this_month", "last_month"] as const);
  const since = typeof params.since === "string" ? params.since : undefined;
  const until = typeof params.until === "string" ? params.until : undefined;
  if (since || until) {
    if (!since || !isDay(since) || (until && !isDay(until))) throw new AdsError("since and until must be YYYY-MM-DD.");
    const end = until ?? today;
    if (end < since) throw new AdsError("until is before since.");
    if ((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / 86_400_000 > 400) throw new AdsError("At most 400 days at a time.");
    return { since, until: end, label: `${since} to ${end}` };
  }
  if (choice === "last_30d") return { since: addDays(today, -29), until: today, label: "last 30 days" };
  if (choice === "this_month") return { since: monthStart(monthOf(today)), until: today, label: "this month" };
  if (choice === "last_month") {
    const last = monthOf(addDays(monthStart(monthOf(today)), -1));
    return { since: monthStart(last), until: monthEnd(last), label: "last month" };
  }
  return { since: addDays(today, -6), until: today, label: "last 7 days" };
}

const today = (rt: AdsRuntime) => todayIn(rt.config.timezone, rt.now());

function totalsOf(row: { spend: number; impressions: number; clicks: number; conversions: number; value: number }): Totals {
  return { spend: row.spend, impressions: row.impressions, clicks: row.clicks, conversions: row.conversions, value: row.value };
}

function shaped(row: { spend: number; impressions: number; clicks: number; conversions: number; value: number }, currency: string) {
  const t = withDerived(totalsOf(row));
  return {
    spendMinor: t.spend,
    spend: formatMoney(t.spend, currency),
    impressions: t.impressions,
    clicks: t.clicks,
    conversions: t.conversions,
    ctr: t.ctr === null ? null : Math.round(t.ctr * 10_000) / 10_000,
    cpcMinor: t.cpc,
    cpc: t.cpc === null ? null : formatMoney(t.cpc, currency),
    cpaMinor: t.cpa,
    cpa: t.cpa === null ? null : formatMoney(t.cpa, currency),
    conversionValueMinor: t.value,
    roas: t.roas,
  };
}

/** The cross-platform picture: spend, impressions, clicks, conversions, CPC, CPA and ROAS, grouped, one currency at a time. */
export async function summaryRecord(rt: AdsRuntime, params: Record<string, unknown>) {
  const scopeKey = scopeFromParams(params);
  const period = periodFrom(params, today(rt));
  const groupBy = (optionalChoice(params, "groupBy", ["platform", "campaign", "day", "scope", "account"] as const) ?? "platform") as GroupBy;
  const platform = optionalChoice(params, "platform", ["meta", "google", "mock"] as const);
  const rows = await summaryRows(rt.ctx, rt.companyId, { since: period.since, until: period.until, groupBy, ...(scopeKey ? { scopeKey } : {}), ...(platform ? { platform } : {}) });
  const names = await clientNames(rt.ctx, rt.companyId);
  const byCurrency = new Map<string, Totals>();
  for (const r of rows) byCurrency.set(r.currency, sumRows([byCurrency.get(r.currency) ?? { spend: 0, impressions: 0, clicks: 0, conversions: 0, value: 0 }, totalsOf(r)]));
  return {
    period,
    groupBy,
    scope: scopeKey ?? "all scopes",
    groups: rows.slice(0, 200).map((r) => ({
      key: r.key,
      label: groupBy === "scope" ? scopeLabelOf(r.key, names[r.key]) : r.label,
      platform: r.platform,
      accountId: r.account_id,
      campaignExternalId: r.campaign_external_id,
      scopeKey: r.scope_key,
      currency: r.currency,
      ...shaped(r, r.currency),
    })),
    totals: [...byCurrency.entries()].map(([currency, t]) => ({ currency, ...shaped(t, currency) })),
    note: byCurrency.size > 1 ? "Totals are per currency: amounts in different currencies are never added together." : undefined,
    hasData: rows.length > 0,
  };
}

/** Campaigns with the last 7 days of numbers. */
export async function campaignsRecord(rt: AdsRuntime, params: Record<string, unknown>) {
  const scopeKey = scopeFromParams(params);
  const accountId = typeof params.accountId === "string" ? params.accountId : undefined;
  const status = optionalChoice(params, "status", ["active", "paused", "archived", "other"] as const);
  const campaigns = await listCampaigns(rt.ctx, rt.companyId, { ...(scopeKey ? { scopeKey } : {}), ...(accountId ? { accountId } : {}), ...(status ? { status } : {}), limit: 200 });
  const since = addDays(today(rt), -6);
  const rows = await dailyRows(rt.ctx, rt.companyId, since);
  const key = (accountId_: string, ext: string) => `${accountId_}|${ext}`;
  const sums = new Map<string, Totals>();
  for (const r of rows) sums.set(key(r.account_id, r.campaign_external_id), sumRows([sums.get(key(r.account_id, r.campaign_external_id)) ?? { spend: 0, impressions: 0, clicks: 0, conversions: 0, value: 0 }, r]));
  return {
    last7Days: { since, until: today(rt) },
    campaigns: campaigns.map((c) => ({
      accountId: c.account_id,
      accountName: c.account_name,
      platform: c.platform,
      scopeKey: c.scope_key,
      campaignExternalId: c.external_id,
      name: c.name,
      status: c.status,
      objective: c.objective,
      dailyBudgetMinor: c.daily_budget_minor,
      dailyBudget: c.daily_budget_minor === null ? null : formatMoney(c.daily_budget_minor, c.currency),
      currency: c.currency,
      ...shaped(sums.get(key(c.account_id, c.external_id)) ?? { spend: 0, impressions: 0, clicks: 0, conversions: 0, value: 0 }, c.currency),
    })),
  };
}

export async function ledgerRecord(rt: AdsRuntime, params: Record<string, unknown>) {
  const scopeKey = scopeFromParams(params);
  const month = typeof params.month === "string" ? params.month : undefined;
  if (month !== undefined && !isMonth(month)) throw new AdsError("month must be YYYY-MM.");
  const accountId = typeof params.accountId === "string" ? params.accountId : undefined;
  const limit = typeof params.limit === "number" ? params.limit : 100;
  const entries = await listLedger(rt.ctx, rt.companyId, { ...(scopeKey ? { scopeKey } : {}), ...(accountId ? { accountId } : {}), ...(month ? { since: monthStart(month), until: monthEnd(month) } : {}), limit });
  return {
    month: month ?? null,
    entries: entries.map((e) => ({ day: e.day, scopeKey: e.scope_key, accountId: e.account_id, campaignExternalId: e.campaign_external_id, deltaMinor: e.delta_minor, totalMinor: e.total_minor, delta: formatMoney(e.delta_minor, e.currency), currency: e.currency, kind: e.kind, recordedAt: e.recorded_at })),
    note: "Append-only: each entry is one change to a campaign's spend for a day (the platforms restate recent days). The latest total per campaign and day is its spend.",
  };
}

export async function budgetStatusRecord(rt: AdsRuntime, params: Record<string, unknown>) {
  const scopeKey = scopeFromParams(params);
  const names = await clientNames(rt.ctx, rt.companyId);
  const scopes = (await listScopes(rt.ctx, rt.companyId)).filter((s) => !scopeKey || s.scope_key === scopeKey);
  const open = await listProposals(rt.ctx, rt.companyId, { open: true, limit: 200 });
  const out = [];
  for (const scope of scopes) {
    const sp = await scopePace(rt, scope);
    const overrides = await budgetOverrides(rt.ctx, rt.companyId, scope.scope_key);
    const c = scope.currency;
    out.push({
      scopeKey: scope.scope_key,
      label: scopeLabelOf(scope.scope_key, names[scope.scope_key]),
      currency: c,
      month: sp.month,
      capMinor: sp.pace.capMinor,
      cap: sp.pace.capMinor === null ? "none set" : formatMoney(sp.pace.capMinor, c),
      spentMinor: sp.pace.spentMinor,
      spent: formatMoney(sp.pace.spentMinor, c),
      pctUsed: sp.pace.pctUsed === null ? null : Math.round(sp.pace.pctUsed * 100),
      expectedPctByNow: Math.round(sp.pace.expectedPct * 100),
      daysLeft: sp.pace.daysLeft,
      runRateDailyMinor: sp.pace.runRateDailyMinor,
      projectedRunRateMinor: sp.pace.projectedRunRateMinor,
      projectedRunRate: formatMoney(sp.pace.projectedRunRateMinor, c),
      committedDailyMinor: sp.committedDailyMinor,
      projectedIfBudgetsSpentMinor: sp.pace.projectedCommittedMinor,
      headroomMinor: sp.pace.headroomMinor,
      state: sp.pace.state,
      alertPct: scope.alert_pct,
      targetCpaMinor: scope.target_cpa_minor,
      allowWrites: scope.allow_writes,
      signoffs: scope.signoffs,
      overrides,
      openPauseRequests: open.filter((p) => p.scope_key === scope.scope_key && p.kind === "pause_campaign" && p.origin.startsWith("budget_")).map((p) => ({ proposalId: p.id, status: p.status })),
      mismatchedAccounts: sp.mismatchedAccounts,
      note: sp.pace.capMinor === null ? "No monthly budget cap is set for this scope. A person sets it on the Ads page (Budgets); until then no change that adds spend can run." : undefined,
    });
  }
  return { scopes: out };
}

export async function alertsRecord(rt: AdsRuntime, params: Record<string, unknown>) {
  const scopeKey = scopeFromParams(params);
  const status = optionalChoice(params, "status", ["open", "acknowledged", "resolved"] as const) ?? "open";
  const alerts = await listAlerts(rt.ctx, rt.companyId, { ...(scopeKey ? { scopeKey } : {}), status, limit: 100 });
  return { alerts: alerts.map((a) => ({ alertId: a.id, kind: a.kind, severity: a.severity, scopeKey: a.scope_key, accountId: a.account_id, campaignExternalId: a.campaign_external_id, title: a.title, text: a.body, status: a.status, note: a.note, firstSeenAt: a.first_seen_at, lastSeenAt: a.last_seen_at, issueId: a.issue_id })) };
}

export function proposalSummary(p: ProposalRow, currency: string) {
  return {
    proposalId: p.id,
    kind: p.kind,
    kindLabel: PROPOSAL_KIND_LABELS[p.kind],
    status: p.status,
    statusLabel: STATUS_LABELS[p.status],
    scopeKey: p.scope_key,
    title: p.title,
    summary: p.summary,
    capState: p.cap_state,
    reviewState: p.review_state,
    requiresSignoffs: p.requires_signoffs,
    origin: p.origin,
    issueId: p.approval_issue_id,
    clientAskIssueId: p.client_ask_issue_id,
    clientActionRef: p.client_action_ref,
    createdAt: p.created_at,
    expiresAt: p.expires_at,
    executedAt: p.executed_at,
    currency,
  };
}

export async function proposalsRecord(rt: AdsRuntime, params: Record<string, unknown>) {
  const scopeKey = scopeFromParams(params);
  const status = typeof params.status === "string" && params.status !== "open" ? params.status : undefined;
  const proposals = await listProposals(rt.ctx, rt.companyId, { ...(scopeKey ? { scopeKey } : {}), ...(status ? { status } : {}), ...(params.status === "open" || params.status === undefined ? { open: true } : {}), limit: 100 });
  const scopes = new Map((await listScopes(rt.ctx, rt.companyId)).map((s) => [s.scope_key, s]));
  return { proposals: proposals.map((p) => proposalSummary(p, scopes.get(p.scope_key)?.currency ?? "ZAR")) };
}

export async function proposalDetail(rt: AdsRuntime, proposalId: string) {
  const p = await getProposal(rt.ctx, rt.companyId, proposalId);
  if (!p) throw new AdsError("That proposal was not found.");
  const scope = (await listScopes(rt.ctx, rt.companyId)).find((s) => s.scope_key === p.scope_key);
  const currency = scope?.currency ?? "ZAR";
  const approvals = await listApprovals(rt.ctx, rt.companyId, p.id);
  const state = signoffState(p, approvals, rt.now());
  const name = await clientName(rt.ctx, rt.companyId, p.scope_key);
  const owner = state.valid.owner;
  return {
    ...proposalSummary(p, currency),
    scopeLabel: scopeLabelOf(p.scope_key, name),
    numbers: numberLines(p, currency),
    budget: impactLines(p),
    impact: impactOf(p),
    precheck: p.precheck,
    reviewNotes: p.review_notes,
    reviewBy: p.review_by,
    payload: p.payload,
    execution: p.execution,
    error: p.error,
    signoffs: {
      required: state.required,
      missing: state.missing,
      given: Object.fromEntries(Object.entries(state.valid).map(([role, a]) => [role, { approvalId: a!.id, by: a!.decided_by, at: a!.created_at, expiresAt: a!.expires_at, note: a!.note, overCapAcknowledged: a!.over_cap_ack }])),
      refused: state.rejected ? { by: state.rejected.decided_by, note: state.rejected.note } : null,
    },
    // The approval id `execute-ad-change` needs, once the owner has said yes.
    approvalId: p.status === "approved" ? owner?.id ?? null : null,
    clientMessage: p.requires_signoffs.includes("client") ? clientMessage(p, name, currency) : null,
    next: nextStep(p, state.missing),
  };
}

function nextStep(p: ProposalRow, missing: string[]): string {
  switch (p.status) {
    case "needs_changes":
      return p.review_state === "changes" ? "The Reviewer asked for changes: read reviewNotes, then revise-ad-proposal." : "Fix the blockers in precheck, then revise-ad-proposal.";
    case "in_review":
      return p.review_state === "pending" ? "Waiting for the Reviewer, then a person." : `Waiting for a person's yes${missing.length ? ` (still needed: ${missing.join(", ")})` : ""}.`;
    case "approved":
      return "Approved. execute-ad-change with this proposalId and the approvalId, if changes are switched on for the scope; otherwise a person makes the change and marks it done.";
    case "cleared":
      return "The copy is cleared. Use it in a create_campaign proposal.";
    case "executed":
      return "Done. Check the campaign in the next sync and comment what changed.";
    case "failed":
      return "It did not complete and the approval is used up. Read error, tell the owner what happened, and propose again only if it is still wanted.";
    default:
      return "Closed. Nothing more to do on it.";
  }
}

// ── scopes: caps, switches, rules ───────────────────────────────────────────

/** The page's picture of everything: connections, accounts, scopes with their pace, open proposals, alerts, the agent and the recent audit. */
export async function overviewRecord(rt: AdsRuntime, params: Record<string, unknown> = {}) {
  const scopeKey = scopeFromParams(params);
  const [accounts, connections, budgets, alerts, proposals, audits, agent, names] = await Promise.all([
    describeAccounts(rt.ctx, rt.companyId),
    listConnections(rt.ctx, rt.companyId),
    budgetStatusRecord(rt, scopeKey ? { scopeKey } : {}),
    alertsRecord(rt, { ...(scopeKey ? { scopeKey } : {}), status: "open" }),
    proposalsRecord(rt, { ...(scopeKey ? { scopeKey } : {}), status: "open" }),
    listAudit(rt.ctx, rt.companyId, 30),
    agentSummary(rt.ctx, rt.companyId),
    clientNames(rt.ctx, rt.companyId),
  ]);
  const t = today(rt);
  const month = await summaryRecord(rt, { period: "this_month", groupBy: "platform", ...(scopeKey ? { scopeKey } : {}) });
  const daily = await summaryRecord(rt, { period: "last_30d", groupBy: "day", ...(scopeKey ? { scopeKey } : {}) });
  return {
    today: t,
    platforms: (["meta", "google", "mock"] as const).map((p) => ({ label: platformLabel(p), ...rt.config.platform(p) })),
    writesEnabled: rt.config.writesEnabled,
    settingsSaved: rt.config.saved,
    connections: connections.map(connectionView),
    accounts,
    budgets: budgets.scopes,
    alerts: alerts.alerts,
    proposals: proposals.proposals,
    month,
    daily,
    audit: audits,
    agent,
    clients: names,
  };
}

async function requirePersonScope(rt: AdsRuntime, scopeKey: string): Promise<ScopeRow> {
  if (!validScopeKey(scopeKey)) throw new AdsError('The scope must be "own" or a CRM client like "company:<id>".');
  const scope = (await listScopes(rt.ctx, rt.companyId)).find((s) => s.scope_key === scopeKey);
  if (!scope) throw new AdsError(`${scopeLabelOf(scopeKey)} has no ad account registered yet. Register one first.`);
  return scope;
}

/** A person sets the monthly cap (or one month's different cap). Money governance is never an agent's call. */
export async function setBudgetCap(rt: AdsRuntime, actor: RecordActor, params: Record<string, unknown>) {
  if (!actor.userId) throw new AdsError("Only a signed-in person sets a budget cap.");
  const scope = await requirePersonScope(rt, String(params.scopeKey ?? ""));
  const cap = minorField(params, "monthlyCapMinor", { required: true })!;
  if (cap <= 0) throw new AdsError("The cap must be more than zero.");
  const month = typeof params.month === "string" && params.month ? params.month : null;
  if (month && !isMonth(month)) throw new AdsError("month must be YYYY-MM.");
  const noteText = typeof params.note === "string" ? params.note.trim().slice(0, 300) : null;
  if (month) await setBudgetOverride(rt.ctx, rt.companyId, scope.scope_key, month, cap, noteText, `user:${actor.userId}`);
  else await updateScope(rt.ctx, rt.companyId, scope.scope_key, { monthlyCapMinor: cap });
  const alertPct = params.alertPct === undefined ? undefined : Number(params.alertPct);
  if (alertPct !== undefined) {
    if (!Number.isInteger(alertPct) || alertPct < 50 || alertPct > 100) throw new AdsError("alertPct must be a whole number from 50 to 100.");
    await updateScope(rt.ctx, rt.companyId, scope.scope_key, { alertPct });
  }
  await audit(rt.ctx, rt.companyId, { actor: `user:${actor.userId}`, action: month ? "budget.month_cap_set" : "budget.cap_set", scopeKey: scope.scope_key, detail: { capMinor: cap, month, alertPct: alertPct ?? null, previous: scope.monthly_cap_minor } });
  return { ok: true, scopeKey: scope.scope_key, capMinor: cap, month };
}

/** The per-scope switch for changes. Off by default; only a person turns it on. Switching it off needs nobody's approval. */
export async function setAllowWrites(rt: AdsRuntime, actor: RecordActor, params: Record<string, unknown>) {
  if (!actor.userId) throw new AdsError("Only a signed-in person switches changes on or off.");
  const scope = await requirePersonScope(rt, String(params.scopeKey ?? ""));
  const allow = params.allow === true;
  if (allow && !rt.config.writesEnabled) throw new AdsError('Changes are switched off for the whole company in the plugin settings (Changing ads). Switch "Allow changes to ads at all" on there first.');
  if (allow && scope.monthly_cap_minor === null) throw new AdsError("Set a monthly budget cap for this scope before switching changes on: every change that adds spend is checked against it.");
  await updateScope(rt.ctx, rt.companyId, scope.scope_key, { allowWrites: allow, allowWritesBy: `user:${actor.userId}` });
  await audit(rt.ctx, rt.companyId, { actor: `user:${actor.userId}`, action: allow ? "writes.enabled" : "writes.disabled", scopeKey: scope.scope_key });
  return { ok: true, scopeKey: scope.scope_key, allowWrites: allow };
}

export async function setSignoffs(rt: AdsRuntime, actor: RecordActor, params: Record<string, unknown>) {
  if (!actor.userId) throw new AdsError("Only a signed-in person changes who must approve.");
  const scope = await requirePersonScope(rt, String(params.scopeKey ?? ""));
  const signoffs = optionalChoice(params, "signoffs", ["owner", "owner_client"] as const);
  if (!signoffs) throw new AdsError("signoffs must be owner or owner_client.");
  if (scope.scope_key === OWN_SCOPE && signoffs === "owner_client") throw new AdsError("PiB's own ads have no client to sign off.");
  await updateScope(rt.ctx, rt.companyId, scope.scope_key, { signoffs });
  await audit(rt.ctx, rt.companyId, { actor: `user:${actor.userId}`, action: "signoffs.set", scopeKey: scope.scope_key, detail: { signoffs, previous: scope.signoffs } });
  return { ok: true, scopeKey: scope.scope_key, signoffs };
}

/** What helps the agent do its job and never loosens a control: the cost per result to aim for, banned words, a brand note. */
export async function setScopeRules(rt: AdsRuntime, actor: RecordActor, params: Record<string, unknown>) {
  const scope = await requirePersonScope(rt, String(params.scopeKey ?? ""));
  const patch: Parameters<typeof updateScope>[3] = {};
  const target = minorField(params, "targetCpaMinor");
  if (params.targetCpaMinor !== undefined) patch.targetCpaMinor = target === 0 ? null : target ?? null;
  if (params.bannedWords !== undefined) {
    // Words may be added by an agent; taking one away is a person's call (a missing banned word is a missed check).
    const next = stringList(params.bannedWords);
    const removed = scope.banned_words.filter((w) => !next.some((n) => n.toLowerCase() === w.toLowerCase()));
    if (removed.length > 0 && !actor.userId) throw new AdsError(`A banned word can only be removed by a person (${removed.slice(0, 3).join(", ")}). Send the full list including them, or ask the owner.`);
    patch.bannedWords = next;
  }
  if (typeof params.brandNote === "string") patch.brandNote = params.brandNote.trim().slice(0, 1000) || null;
  await updateScope(rt.ctx, rt.companyId, scope.scope_key, patch);
  await audit(rt.ctx, rt.companyId, { actor: actorText(actor), action: "scope.rules_set", scopeKey: scope.scope_key, detail: { targetCpaMinor: patch.targetCpaMinor, bannedWords: patch.bannedWords?.length, brandNote: patch.brandNote !== undefined } });
  return { ok: true, scopeKey: scope.scope_key };
}

/** The CRM tells us a client's brand (kit contract `client.brand.updated`): the banned words become the scope's, without trusting an agent to copy them. */
export async function rememberBrand(rt: AdsRuntime, scopeKey: ScopeKey, bannedWords: string[], brandNote: string | null): Promise<void> {
  await ensureScope(rt.ctx, rt.companyId, scopeKey, "ZAR");
  await updateScope(rt.ctx, rt.companyId, scopeKey, { bannedWords: stringList(bannedWords), ...(brandNote !== null ? { brandNote: brandNote.slice(0, 1000) } : {}) });
}

export async function connectionsRecord(rt: AdsRuntime) {
  return { connections: (await listConnections(rt.ctx, rt.companyId)).map(connectionView) };
}

export async function accountsRecord(rt: AdsRuntime, params: Record<string, unknown>) {
  const scopeKey = scopeFromParams(params);
  const accounts = await describeAccounts(rt.ctx, rt.companyId, scopeKey);
  const budgets = await budgetStatusRecord(rt, scopeKey ? { scopeKey } : {});
  return { accounts, scopes: budgets.scopes.map((b) => ({ scopeKey: b.scopeKey, label: b.label, currency: b.currency, cap: b.cap, spent: b.spent, pctUsed: b.pctUsed, state: b.state, allowWrites: b.allowWrites, signoffs: b.signoffs })) };
}

