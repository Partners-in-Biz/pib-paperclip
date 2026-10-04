import { normalizeToolResult } from "@partnersinbiz/pib-plugin-kit";
import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginContext,
  type PluginEvent,
  type PluginPerformActionContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import {
  COCKPIT_ROUTE,
  SETUP_STATUS_ROUTE,
  checkDoneOnUpdate,
  createSkillSyncer,
  linkAgent,
  publishSetupStatus,
  registerClientProjectWatch,
  registerCompanyBootstrap,
  registerCrmProjection,
  registerHireWatch,
  registerModuleWatch,
  registerRoleWatch,
  rememberPluginUiBase,
  startHire,
  syncAllCompanies,
  trackJob,
  unlinkAgent,
  type SkillSyncer,
} from "@partnersinbiz/pib-plugin-kit";
import { discoverAccounts, registerAccount, removeAccount } from "./accounts.js";
import { agentSummary, hireOptions, onAdsAgentLinked, resumeHint, resyncAgent, tryLinkAdsHire } from "./agent.js";
import { checkCreative } from "./creative.js";
import { cockpitSnapshot, publishCockpitSnapshots } from "./cockpit.js";
import { refreshAllConnections } from "./connections.js";
import { deleteExpiredOauthSessions, getConnection, getScope, updateConnection, audit } from "./db.js";
import { AdsError, errorMessage, objectParams, optionalString, requiredString } from "./domain.js";
import { ADS_DONE_CHECKS } from "./done-checks.js";
import { acknowledgeAlert, evaluateCompany, resolveStaleAlerts } from "./evaluate.js";
import { executeProposal } from "./execute.js";
import { ADS_HIRE_ROLE, ADS_MATCH_ROLE } from "./hire.js";
import { ORIGIN_KIND, ensureAdsProject } from "./issues.js";
import { adsOn, companyUsesAds, knownCompanies, MODULE_OFF_MESSAGE } from "./modules.js";
import { OAuthFlowError, completeOAuth, connectMock, connectWithToken, startOAuth } from "./oauth.js";
import { OWN_SCOPE, PLUGIN_ID } from "./platforms.js";
import { cancelProposal, createProposal, markDoneManually, onApprovalIssue, recordClientRequest, recordReview, recordSignoff, reviseProposal, sweepProposals } from "./proposals.js";
import {
  accountsRecord,
  alertsRecord,
  budgetStatusRecord,
  campaignsRecord,
  connectionsRecord,
  ledgerRecord,
  overviewRecord,
  proposalDetail,
  proposalsRecord,
  rememberBrand,
  scopeFromParams,
  setAllowWrites,
  setBudgetCap,
  setScopeRules,
  setSignoffs,
  summaryRecord,
} from "./records.js";
import { runtimeFor, type AdsRuntime } from "./runtime.js";
import { adsSetupStatus } from "./setup-status.js";
import { syncCompany } from "./sync.js";
import { SKILLS } from "./skills.js";
import { ADS_TOOLS } from "./tools.js";

let pluginCtx: PluginContext | null = null;
let skillSync: SkillSyncer | null = null;
const lastRuns: Record<string, { at: string; ok: boolean; summary?: unknown; error?: string }> = {};

// ── viewers ─────────────────────────────────────────────────────────────────

interface Viewer {
  companyId: string;
  /** Set only for a signed-in person (the host's actor, never a value from the page's payload). */
  userId: string | null;
  agentId: string | null;
  runId: string | null;
  isAgent: boolean;
}

function actionViewer(context: PluginPerformActionContext): Viewer {
  const companyId = context.companyId ?? context.actor.companyId;
  if (!companyId) throw new AdsError("Company is required");
  const isUser = context.actor.type === "user";
  return { companyId, userId: isUser ? context.actor.userId : null, agentId: context.actor.agentId ?? null, runId: context.actor.runId ?? null, isAgent: context.actor.type === "agent" };
}

function toolViewer(run: ToolRunContext): Viewer {
  return { companyId: run.companyId, userId: null, agentId: run.agentId, runId: run.runId, isAgent: true };
}

/** The host's person behind an action. Throws for an agent: changing money controls is a person's call. */
function requireUser(v: Viewer, what: string): string {
  if (!v.userId) throw new AdsError(`A signed-in person ${what}. An agent cannot.`);
  return v.userId;
}

async function ensureCompany(ctx: PluginContext, companyId: string): Promise<void> {
  await skillSync?.ensure(companyId).catch(() => undefined);
}

// ── agent tools ─────────────────────────────────────────────────────────────

/** Tools work on one scope: PiB's own ads unless the call names a client. `client: "all"` is allowed only for the read-only overviews. */
const OVERVIEW_TOOLS = new Set(["list-ad-accounts", "get-ads-summary", "list-ad-campaigns", "get-spend-ledger", "get-budget-status", "list-ad-alerts", "list-ad-proposals"]);

function toolParams(name: string, params: Record<string, unknown>): Record<string, unknown> {
  if (params.client === "all") {
    if (!OVERVIEW_TOOLS.has(name)) throw new AdsError('client "all" is only for the read-only overviews. Name one scope.');
    const { client: _client, ...rest } = params;
    return rest;
  }
  if (OVERVIEW_TOOLS.has(name) && params.client === undefined && params.scopeKey === undefined) return { ...params, client: "own" };
  return params;
}

function oneScope(params: Record<string, unknown>): string {
  return scopeFromParams(params) ?? OWN_SCOPE;
}

async function dispatchTool(rt: AdsRuntime, v: Viewer, name: string, raw: Record<string, unknown>): Promise<unknown> {
  const p = toolParams(name, raw);
  const actor = { agentId: v.agentId, userId: null };
  switch (name) {
    case "list-ad-accounts":
      return accountsRecord(rt, p);
    case "list-ad-connections": {
      const base = await connectionsRecord(rt);
      const connectionId = optionalString(p, "connectionId");
      return connectionId ? { ...base, connectionId, accountsVisible: await discoverAccounts(rt, connectionId) } : base;
    }
    case "register-ad-account": {
      const result = await registerAccount(rt, actor, { connectionId: requiredString(p, "connectionId"), externalId: requiredString(p, "externalId"), scopeKey: oneScope(p), ...(Array.isArray(p.conversionActions) ? { conversionActions: p.conversionActions.filter((s): s is string => typeof s === "string") } : {}) });
      return { accountId: result.account.id, created: result.created, scopeKey: result.scope.scope_key, currency: result.scope.currency, monthlyCapSet: result.scope.monthly_cap_minor !== null, next: result.scope.monthly_cap_minor === null ? "No monthly budget cap is set for this scope. A person sets it on the Ads page (Budgets); until then no change that adds spend can run. The first sync runs within 3 hours, or call sync-ad-account." : "The first sync runs within 3 hours, or call sync-ad-account." };
    }
    case "sync-ad-account": {
      const accountId = optionalString(p, "accountId");
      const days = typeof p.days === "number" ? p.days : undefined;
      // An agent call stays short: ten accounts at most (the three-hourly job reads the rest).
      const sync = await syncCompany(rt, { ...(accountId ? { accountId } : {}), ...(days ? { days } : {}), limit: 10 });
      const evaluated = await evaluateCompany(rt);
      return { accounts: sync.accounts, ok: sync.ok, failed: sync.failed, skipped: sync.skipped, results: sync.results, alertsNew: evaluated.alertsNew, pauseRequests: evaluated.pauseRequests };
    }
    case "get-ads-summary":
      return summaryRecord(rt, p);
    case "list-ad-campaigns":
      return campaignsRecord(rt, p);
    case "get-spend-ledger":
      return ledgerRecord(rt, p);
    case "get-budget-status":
      return budgetStatusRecord(rt, p);
    case "list-ad-alerts":
      return alertsRecord(rt, p);
    case "acknowledge-ad-alert":
      await acknowledgeAlert(rt, actor, requiredString(p, "alertId"), requiredString(p, "note", 400));
      return { ok: true };
    case "set-ad-scope-rules":
      return setScopeRules(rt, actor, { ...p, scopeKey: oneScope(p) });
    case "check-ad-creative": {
      const scope = await getScope(rt.ctx, rt.companyId, oneScope(p));
      const extra = Array.isArray(p.bannedWords) ? p.bannedWords.filter((w): w is string => typeof w === "string") : [];
      const platform = p.platform === "google" ? "google" : "meta";
      const result = checkCreative(
        { platform, headline: optionalString(p, "headline") ?? null, primaryText: optionalString(p, "primaryText") ?? null, description: optionalString(p, "description") ?? null, callToAction: optionalString(p, "callToAction") ?? null, landingUrl: optionalString(p, "landingUrl") ?? null, specialAdCategories: Array.isArray(p.specialAdCategories) ? p.specialAdCategories.filter((s): s is string => typeof s === "string") : [] },
        { bannedWords: [...(scope?.banned_words ?? []), ...extra] },
      );
      return { ...result, bannedWordsChecked: (scope?.banned_words.length ?? 0) + extra.length, note: "A machine check only. It never clears copy: propose it (creative_check, or inside create_campaign) and the Reviewer reads it against the client's brand profile." };
    }
    case "propose-ad-change":
      return createProposal(rt, actor, { ...p, scopeKey: oneScope(p) });
    case "revise-ad-proposal": {
      const { proposalId, ...changes } = p;
      return reviseProposal(rt, actor, requiredString({ proposalId }, "proposalId"), changes);
    }
    case "list-ad-proposals":
      return proposalsRecord(rt, p);
    case "get-ad-proposal":
      return proposalDetail(rt, requiredString(p, "proposalId"));
    case "record-ad-review": {
      const verdict = requiredString(p, "verdict");
      if (verdict !== "pass" && verdict !== "changes") throw new AdsError("verdict must be pass or changes");
      const proposal = await recordReview(rt, actor, { proposalId: requiredString(p, "proposalId"), verdict, notes: optionalString(p, "notes", 1500) ?? null });
      return { proposalId: proposal.id, status: proposal.status, reviewState: proposal.review_state };
    }
    case "record-client-request": {
      const proposal = await recordClientRequest(rt, actor, requiredString(p, "proposalId"), requiredString(p, "clientActionId", 120));
      return { proposalId: proposal.id, clientActionRef: proposal.client_action_ref, next: "When the client answers yes, a person records it on the Ads page. Nothing runs before that." };
    }
    case "cancel-ad-proposal": {
      const proposal = await cancelProposal(rt, actor, requiredString(p, "proposalId"), optionalString(p, "reason", 400) ?? null);
      return { proposalId: proposal.id, status: proposal.status };
    }
    case "execute-ad-change":
      return executeProposal(rt, actor, { proposalId: requiredString(p, "proposalId"), approvalId: requiredString(p, "approvalId") });
    default:
      throw new AdsError(`Unknown ads tool ${name}`);
  }
}

function toolContent(data: unknown): string {
  const json = JSON.stringify(data, null, 2) ?? "null";
  return json.length > 24_000 ? `${json.slice(0, 24_000)}\n... (truncated; narrow the request)` : json;
}

async function runTool(ctx: PluginContext, name: string, params: unknown, run: ToolRunContext): Promise<ToolResult> {
  try {
    if (!(await adsOn(ctx, run.companyId))) return { error: MODULE_OFF_MESSAGE };
    await ensureCompany(ctx, run.companyId);
    const rt = await runtimeFor(ctx, run.companyId);
    const data = await dispatchTool(rt, toolViewer(run), name, objectParams(params));
    return { content: toolContent(data), data: data as ToolResult["data"] };
  } catch (error) {
    return { error: errorMessage(error) || "Ads tool failed" };
  }
}

// ── UI actions ──────────────────────────────────────────────────────────────

type ActionHandler = (ctx: PluginContext, rt: AdsRuntime, v: Viewer, params: Record<string, unknown>) => Promise<unknown>;

const ACTIONS: Record<string, ActionHandler> = {
  "ads.load": async (ctx, rt, v, p) => {
    // The page reports /_plugins/<installation uuid>/ui/ so OAuth redirect URIs can use it.
    await rememberPluginUiBase(ctx, p.uiBase);
    if (v.userId) await tryLinkAdsHire(ctx, v.companyId);
    const fresh = await runtimeFor(ctx, v.companyId);
    const overview = await overviewRecord(fresh, p.client === undefined || p.client === null ? {} : { client: p.client });
    let redirectUri: string | null = null;
    try {
      redirectUri = fresh.config.redirectUri();
    } catch {
      redirectUri = null;
    }
    return { ...overview, redirectUri, publicBaseUrlError: fresh.config.publicBaseUrlError, encryptionKey: fresh.config.encryptionKeyConfigured };
  },
  "ads.oauth-start": (_ctx, rt, v, p) => startOAuth(rt, requireUser(v, "connects an ad platform"), requiredString(p, "platform")),
  "ads.connect-token": (_ctx, rt, v, p) => connectWithToken(rt, requireUser(v, "connects an ad platform"), requiredString(p, "platform")),
  "ads.connect-mock": (_ctx, rt, v) => connectMock(rt, requireUser(v, "connects an ad platform")),
  "ads.disconnect": async (ctx, rt, v, p) => {
    const userId = requireUser(v, "removes a connection");
    const conn = await getConnection(ctx, v.companyId, requiredString(p, "connectionId"));
    if (!conn) throw new AdsError("That connection was not found.");
    await updateConnection(ctx, v.companyId, conn.id, { status: "disabled", tokenEnc: null, statusDetail: "Removed by a person." });
    await audit(ctx, v.companyId, { actor: `user:${userId}`, action: "connection.removed", subject: conn.id, detail: { platform: conn.platform } });
    return { ok: true };
  },
  "ads.discover-accounts": async (_ctx, rt, v, p) => {
    requireUser(v, "browses ad accounts");
    return { accounts: await discoverAccounts(rt, requiredString(p, "connectionId")) };
  },
  "ads.register-account": async (_ctx, rt, v, p) => {
    const userId = requireUser(v, "registers an ad account");
    const result = await registerAccount(rt, { userId }, { connectionId: requiredString(p, "connectionId"), externalId: requiredString(p, "externalId"), scopeKey: typeof p.scopeKey === "string" && p.scopeKey ? p.scopeKey : OWN_SCOPE });
    return { accountId: result.account.id, created: result.created, scopeKey: result.scope.scope_key, ...(result.capCleared ? { capCleared: true, notice: "The scope changed currency, so its monthly cap and changes switch were cleared. Set the cap again on the Budgets tab." } : {}) };
  },
  "ads.remove-account": async (ctx, _rt, v, p) => {
    await removeAccount(ctx, v.companyId, { userId: requireUser(v, "removes an ad account") }, requiredString(p, "accountId"));
    return { ok: true };
  },
  "ads.sync": async (_ctx, rt, v, p) => {
    requireUser(v, "reads the numbers now");
    const accountId = optionalString(p, "accountId");
    const sync = await syncCompany(rt, accountId ? { accountId } : {});
    const evaluated = await evaluateCompany(rt);
    return { ...sync, alertsNew: evaluated.alertsNew, pauseRequests: evaluated.pauseRequests };
  },
  "ads.performance": async (_ctx, rt, _v, p) => ({ summary: await summaryRecord(rt, p), campaigns: await campaignsRecord(rt, p.client === undefined ? {} : { client: p.client }), ledger: await ledgerRecord(rt, { ...(p.client === undefined ? {} : { client: p.client }), limit: 60 }) }),
  "ads.set-cap": (_ctx, rt, v, p) => setBudgetCap(rt, { userId: v.userId }, p),
  "ads.set-allow-writes": (_ctx, rt, v, p) => setAllowWrites(rt, { userId: v.userId }, p),
  "ads.set-signoffs": (_ctx, rt, v, p) => setSignoffs(rt, { userId: v.userId }, p),
  "ads.set-rules": (_ctx, rt, v, p) => setScopeRules(rt, { userId: v.userId, agentId: v.agentId }, p),
  "ads.proposals": (_ctx, rt, _v, p) => proposalsRecord(rt, p),
  "ads.proposal": (_ctx, rt, _v, p) => proposalDetail(rt, requiredString(p, "proposalId")),
  "ads.approve": async (_ctx, rt, v, p) => {
    const userId = requireUser(v, "approves or refuses a change");
    const role = p.role === "client" ? "client" : "owner";
    const decision = p.decision === "rejected" ? "rejected" : "approved";
    const result = await recordSignoff(rt, { proposalId: requiredString(p, "proposalId"), userId, role, decision, note: optionalString(p, "note", 1000) ?? null, evidenceRef: optionalString(p, "evidenceRef", 200) ?? null, overCapAck: p.overCapAck === true, via: "page" });
    return { proposalId: result.proposal.id, status: result.proposal.status, approvalId: result.approvalId };
  },
  "ads.cancel-proposal": async (_ctx, rt, v, p) => {
    const userId = requireUser(v, "cancels a proposal");
    const proposal = await cancelProposal(rt, { userId }, requiredString(p, "proposalId"), optionalString(p, "reason", 400) ?? null);
    return { proposalId: proposal.id, status: proposal.status };
  },
  "ads.mark-done": async (_ctx, rt, v, p) => {
    const proposal = await markDoneManually(rt, { proposalId: requiredString(p, "proposalId"), userId: v.userId, note: optionalString(p, "note", 400) ?? null });
    return { proposalId: proposal.id, status: proposal.status };
  },
  "ads.execute": async (_ctx, rt, v, p) => {
    const userId = requireUser(v, "runs an approved change from the page");
    const proposalId = requiredString(p, "proposalId");
    const detail = await proposalDetail(rt, proposalId);
    const approvalId = optionalString(p, "approvalId") ?? detail.approvalId;
    if (!approvalId) throw new AdsError("There is no valid owner approval to run this with. Approve it first.");
    return executeProposal(rt, { userId }, { proposalId, approvalId });
  },
  "ads.ack-alert": async (_ctx, rt, v, p) => {
    await acknowledgeAlert(rt, { userId: requireUser(v, "acknowledges an alert") }, requiredString(p, "alertId"), optionalString(p, "note", 400) ?? "Seen.");
    return { ok: true };
  },
  // Hiring: a normal task spells out the agent; the plugin links it when it appears, or a person links one by hand.
  "ads.hire-options": (ctx, _rt, v) => {
    requireUser(v, "hires the ads agent");
    return hireOptions(ctx, v.companyId);
  },
  "ads.start-hire": (ctx, _rt, v, p) => {
    const actorUserId = requireUser(v, "hires the ads agent");
    return startHire(ctx, v.companyId, ADS_HIRE_ROLE, {
      title: optionalString(p, "title"),
      description: optionalString(p, "description"),
      assigneeAgentId: optionalString(p, "assigneeAgentId") ?? null,
      assigneeUserId: optionalString(p, "assigneeUserId") ?? null,
      actorUserId,
    });
  },
  "ads.link-agent": async (ctx, _rt, v, p) => {
    const userId = requireUser(v, "links the ads agent");
    const { agent, steps } = await linkAgent(ctx, v.companyId, ADS_HIRE_ROLE, requiredString(p, "agentId"), { by: "manual", userId, onLinked: onAdsAgentLinked(ctx) });
    return { agent, steps, message: [...steps, resumeHint(agent.name, agent.status)].filter(Boolean).join(" ") };
  },
  "ads.unlink-agent": async (ctx, _rt, v) => {
    requireUser(v, "unlinks the ads agent");
    await unlinkAgent(ctx, v.companyId, ADS_HIRE_ROLE);
    return { ok: true, message: "The agent is no longer the ads agent." };
  },
  "ads.resync-agent": (ctx, _rt, v) => resyncAgent(ctx, v.companyId, requireUser(v, "re-syncs the ads agent")),
  "ads.agent": (ctx, _rt, v) => agentSummary(ctx, v.companyId),
  // Called by the deploy script for every company after a release (the same action every PiB plugin has); it only brings the skill up to date.
  "ads.sync-skills": async (_ctx, _rt, v) => ({ results: await skillSync!.force(v.companyId) }),
};

// ── API routes ──────────────────────────────────────────────────────────────

async function handleApiRoute(ctx: PluginContext, input: PluginApiRequestInput) {
  if (input.routeKey === COCKPIT_ROUTE.routeKey || input.routeKey === SETUP_STATUS_ROUTE.routeKey) {
    const companyId = input.companyId;
    if (!companyId) return { status: 400, body: { error: "companyId is required" } };
    try {
      return { status: 200, body: input.routeKey === COCKPIT_ROUTE.routeKey ? await cockpitSnapshot(ctx, companyId) : await adsSetupStatus(ctx, companyId) };
    } catch (error) {
      return { status: 500, body: { error: errorMessage(error) } };
    }
  }
  if (input.routeKey !== "oauth-complete") return { status: 404, body: { error: "Not found" } };
  // OAuth completion (called by the static bridge page).
  try {
    if (input.actor.actorType !== "user") return { status: 403, body: { error: "Only a signed-in person can finish connecting an ad platform." } };
    const body = (input.body && typeof input.body === "object" ? input.body : {}) as Record<string, unknown>;
    const companyId = typeof body.companyId === "string" ? body.companyId : "";
    const state = typeof body.state === "string" ? body.state : "";
    if (!companyId || companyId !== input.companyId) return { status: 400, body: { error: "companyId is missing or does not match." } };
    if (!state) return { status: 400, body: { error: "state is required" } };
    const rawParams = body.params && typeof body.params === "object" && !Array.isArray(body.params) ? (body.params as Record<string, unknown>) : {};
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawParams)) if (typeof value === "string" && key.length <= 64) params[key] = value.slice(0, 4096);
    await ensureCompany(ctx, companyId);
    const rt = await runtimeFor(ctx, companyId);
    const result = await completeOAuth(rt, { userId: input.actor.userId ?? input.actor.actorId, state, params });
    return { status: 200, body: { ok: true, ...result } };
  } catch (error) {
    const status = error instanceof OAuthFlowError ? error.status : 400;
    const message = errorMessage(error);
    // The message may quote the platform's own words; tokens are redacted where they could appear (providers/http.ts).
    ctx.logger.info("Ads OAuth completion failed", { error: message.slice(0, 300) });
    return { status, body: { error: message } };
  }
}

// ── jobs ────────────────────────────────────────────────────────────────────

function registerJob(ctx: PluginContext, key: string, run: () => Promise<unknown>) {
  ctx.jobs.register(key, async () => {
    try {
      const summary = await trackJob(ctx, key, run);
      lastRuns[key] = { at: new Date().toISOString(), ok: true, summary };
      ctx.logger.info(`Ads job ${key} finished`, { summary });
    } catch (error) {
      const message = errorMessage(error);
      lastRuns[key] = { at: new Date().toISOString(), ok: false, error: message };
      ctx.logger.error(`Ads job ${key} failed`, { error: message });
      throw error;
    }
  });
}

/** Every company that uses Ads, one at a time: a failure in one never stops the others. */
async function forEachCompany<T>(ctx: PluginContext, run: (rt: AdsRuntime) => Promise<T>): Promise<Array<{ companyId: string; result?: T; error?: string }>> {
  const out: Array<{ companyId: string; result?: T; error?: string }> = [];
  for (const companyId of await knownCompanies(ctx)) {
    try {
      if (!(await companyUsesAds(ctx, companyId))) continue;
      out.push({ companyId, result: await run(await runtimeFor(ctx, companyId)) });
    } catch (error) {
      out.push({ companyId, error: errorMessage(error) });
      ctx.logger.info("Ads job skipped a company", { companyId, error: errorMessage(error) });
    }
  }
  return out;
}

export async function publishSetupStatuses(ctx: PluginContext): Promise<{ published: number; skipped: number }> {
  const result = { published: 0, skipped: 0 };
  for (const companyId of await knownCompanies(ctx)) {
    try {
      if (!(await adsOn(ctx, companyId))) {
        result.skipped += 1;
        continue;
      }
      // A company that never saved the settings still gets its status (one optional item), so the Setup page can offer it.
      await publishSetupStatus(ctx, companyId, await adsSetupStatus(ctx, companyId));
      result.published += 1;
    } catch (error) {
      result.skipped += 1;
      ctx.logger.info("Ads setup status skipped", { companyId, error: errorMessage(error) });
    }
  }
  return result;
}

// ── events ──────────────────────────────────────────────────────────────────

/**
 * An issue changed. This is the plugin's only `issue.updated` subscription (a second one would deliver each event twice): it handles the
 * approval issues (a person's close is the decision; an agent's close is reopened) and then the done-checks of the plugin's other issues.
 */
async function onIssueUpdated(ctx: PluginContext, event: PluginEvent): Promise<void> {
  if (!event.companyId || !event.entityId) return;
  const issue = await ctx.issues.get(event.entityId, event.companyId);
  if (!issue) return;
  const originKind = (issue as { originKind?: string | null }).originKind;
  if (originKind !== ORIGIN_KIND) return;
  const rt = await runtimeFor(ctx, event.companyId);
  if (await onApprovalIssue(rt, event, issue.status)) return;
  await checkDoneOnUpdate(ctx, ADS_DONE_CHECKS, event);
}

/** The CRM's brand profile for a client (kit-style contract, emitted by the CRM): the banned words become the scope's. */
async function onBrandUpdated(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const p = event.payload as { clientKind?: string; clientRef?: string; bannedWords?: unknown; brandNote?: unknown } | undefined;
  if (!event.companyId || !p?.clientRef || (p.clientKind !== "company" && p.clientKind !== "contact")) return;
  const scopeKey = `${p.clientKind}:${p.clientRef}`;
  // Only clients that already have ads here: a brand update for any other client is not ours.
  if (!(await getScope(ctx, event.companyId, scopeKey))) return;
  const words = Array.isArray(p.bannedWords) ? p.bannedWords.filter((w): w is string => typeof w === "string") : [];
  await rememberBrand(await runtimeFor(ctx, event.companyId), scopeKey, words, typeof p.brandNote === "string" ? p.brandNote : null);
}

const plugin = definePlugin({
  async setup(ctx) {
    pluginCtx = ctx;
    skillSync = createSkillSyncer(ctx, SKILLS);

    for (const tool of ADS_TOOLS) {
      ctx.tools.register(tool.name, tool, async (params, run) => normalizeToolResult(await runTool(ctx, tool.name, params, run)));
    }
    for (const [key, handler] of Object.entries(ACTIONS)) {
      ctx.actions.register(key, async (params, context) => {
        const v = actionViewer(context);
        await ensureCompany(ctx, v.companyId);
        return handler(ctx, await runtimeFor(ctx, v.companyId), v, objectParams(params));
      });
    }

    // Read the numbers (read-only), then look for anomalies and budget alerts. Every 3 hours, per company that saved its settings.
    registerJob(ctx, "sync-insights", async () => {
      const runs = await forEachCompany(ctx, async (rt) => {
        const sync = await syncCompany(rt);
        const evaluated = await evaluateCompany(rt);
        return { accounts: sync.accounts, ok: sync.ok, failed: sync.failed, skipped: sync.skipped, alertsNew: evaluated.alertsNew, issuesOpened: evaluated.issuesOpened, pauseRequests: evaluated.pauseRequests, errors: evaluated.errors.length };
      });
      return { companies: runs.length, failed: runs.filter((r) => r.error).length, runs };
    });
    // Keep tokens alive, resolve old alerts, tidy sign-in sessions, link a hire whose agent has appeared.
    registerJob(ctx, "refresh-connections", async () => {
      const runs = await forEachCompany(ctx, async (rt) => {
        const outcomes = await refreshAllConnections(rt);
        const resolved = await resolveStaleAlerts(rt);
        await tryLinkAdsHire(ctx, rt.companyId);
        return { connections: outcomes.length, needReconnect: outcomes.filter((o) => o.result === "needs_reconnect").length, failed: outcomes.filter((o) => o.result === "failed").length, alertsResolved: resolved };
      });
      await deleteExpiredOauthSessions(ctx).catch(() => undefined);
      return { companies: runs.length, runs };
    });
    // Hourly: expire proposals nobody decided, tell the Setup plugin and the Cockpit, and bring every company's skills up to date.
    registerJob(ctx, "setup-status", async () => {
      const proposals = await forEachCompany(ctx, (rt) => sweepProposals(rt));
      const setupStatus = await publishSetupStatuses(ctx);
      const cockpit = await publishCockpitSnapshots(ctx).catch((error: unknown) => {
        ctx.logger.info("Ads cockpit publish failed", { error: errorMessage(error) });
        return { published: 0, skipped: 0 };
      });
      const skills = await syncAllCompanies(ctx, skillSync!, { companyIds: await knownCompanies(ctx), isEnabled: (companyId) => companyUsesAds(ctx, companyId), plugin: PLUGIN_ID })
        .then((sweep) => ({ companies: sweep.outcomes.length, reset: sweep.outcomes.filter((o) => o.status === "synced").length, problems: sweep.outcomes.filter((o) => o.status === "failed" || o.status === "needs_settings").length }))
        .catch((error: unknown) => {
          ctx.logger.info("Ads skill sweep failed", { error: errorMessage(error) });
          return { companies: 0, reset: 0, problems: 1 };
        });
      return { proposals, setupStatus, cockpit, skills };
    });

    // Matching leaves out the operating manual every PiB agent carries (see ADS_MATCH_ROLE).
    registerHireWatch(ctx, [{ role: ADS_MATCH_ROLE, onLinked: onAdsAgentLinked(ctx) }]);
    registerModuleWatch(ctx);
    // Cockpit roles (Operator, Reviewer): approvals go to the Reviewer first, then a person.
    registerRoleWatch(ctx);
    // The one company.created wiring (kit): remembers the company, syncs the skill, makes sure the Ads project exists.
    registerCompanyBootstrap(ctx, { syncer: skillSync, ensureResources: (companyId) => ensureAdsProject(ctx, companyId) });
    // The CRM's clients (names for scopes) and their linked projects (a client's ads issues open in the client's own project).
    registerCrmProjection(ctx, ctx.db.namespace);
    registerClientProjectWatch(ctx);
    ctx.events.on("issue.updated", async (event: PluginEvent) => {
      try {
        await onIssueUpdated(ctx, event);
      } catch (error) {
        ctx.logger.info("Ads issue update handling failed", { issueId: event.entityId, error: errorMessage(error) });
      }
    });
    ctx.events.on("plugin.partnersinbiz.crm.client.brand.updated", async (event: PluginEvent) => {
      try {
        await onBrandUpdated(ctx, event);
      } catch (error) {
        ctx.logger.info("Ads brand update failed", { error: errorMessage(error) });
      }
    });
  },
  async onHealth() {
    const failing = Object.entries(lastRuns).filter(([, run]) => !run.ok);
    return {
      status: failing.length ? "degraded" : "ok",
      message: failing.length ? `Last run failed: ${failing.map(([key]) => key).join(", ")}` : "Paid ads plugin ready",
      details: { lastRuns },
    };
  },
  async onApiRequest(input) {
    if (!pluginCtx) return { status: 503, body: { error: "Paid ads plugin is not ready" } };
    return handleApiRoute(pluginCtx, input);
  },
});

export default plugin;
runWorker(plugin, import.meta.url);

