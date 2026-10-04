/**
 * The only place that changes an ad platform. A change runs only when ALL of this holds, checked in this order and refused with a plain reason
 * (and an audit entry) otherwise:
 *   1. the proposal is approved, and runs a kind that changes something;
 *   2. the approval id given is a person's yes for this proposal, for exactly these numbers, unused and under 72 hours old;
 *      every other sign-off the scope needs is in; the Reviewer's check stands;
 *   3. changes are switched on for the company (settings) AND for the scope (a person's switch, off by default);
 *   4. the connection may change ads, the platform is on, the account is active;
 *   5. a change that adds spend has a monthly cap to be checked against, and stays inside it unless the approver said "over the cap";
 *   6. the numbers still match what was approved (a budget changed in the platform since is a new proposal).
 * Then the approval is used up (a second call with it is refused), the proposal moves to `executing`, and only then does the platform get a request.
 * A created campaign is always paused. Nothing here is retried by itself.
 */
import { capImpact, type SpendAddition } from "./budgets.js";
import { audit, consumeApproval, getAccount, getApproval, getCampaign, getConnection, getProposal, getScope, listApprovals, table, transitionProposal, updateProposal, type AccountRow, type ProposalRow } from "./db.js";
import { AdsError, actorText, errorMessage } from "./domain.js";
import { markNeedsReconnect, tokenFor } from "./connections.js";
import { closeRunIssue, note } from "./issues.js";
import { scopePace } from "./pacing.js";
import { SPEND_KINDS } from "./platforms.js";
import { ProviderError } from "./providers/http.js";
import type { AccountRef } from "./providers/types.js";
import type { CampaignTarget } from "./proposal-input.js";
import { providerEnv, type AdsRuntime } from "./runtime.js";
import { reviewStands, signoffState } from "./signoffs.js";
import { syncAccount } from "./sync.js";

export interface ExecuteActor {
  userId?: string | null;
  agentId?: string | null;
}

export interface ExecuteResult {
  proposalId: string;
  status: "executed" | "failed";
  results: Array<{ what: string; ok: boolean; externalId?: string; error?: string }>;
  message: string;
}

/** What a proposal adds to a month's spend, rebuilt from its checked payload. */
export function additionFromPayload(p: Pick<ProposalRow, "kind" | "payload">): SpendAddition | null {
  const x = p.payload;
  if (p.kind === "create_campaign") return { dailyMinor: Number(x.dailyBudgetMinor) || 0, fromDay: (x.startDate as string | null) ?? null, toDay: (x.endDate as string | null) ?? null };
  if (p.kind === "change_budget") return x.campaignStatus === "active" ? { dailyMinor: Math.max(0, Number(x.newDailyBudgetMinor) - Number(x.currentDailyBudgetMinor)) } : null;
  if (p.kind === "resume_campaign") return { dailyMinor: ((x.targets as CampaignTarget[]) ?? []).reduce((sum, t) => sum + (t.dailyBudgetMinor ?? 0), 0) };
  return null;
}

async function refuse(rt: AdsRuntime, actor: ExecuteActor, p: ProposalRow | null, code: string, message: string): Promise<never> {
  await audit(rt.ctx, rt.companyId, { actor: actorText(actor), action: "write.refused", scopeKey: p?.scope_key ?? null, subject: p?.id ?? null, detail: { code, reason: message.slice(0, 300) } });
  throw new AdsError(message, code);
}

export async function executeProposal(rt: AdsRuntime, actor: ExecuteActor, input: { proposalId: string; approvalId: string }): Promise<ExecuteResult> {
  const p = await getProposal(rt.ctx, rt.companyId, input.proposalId);
  if (!p) throw new AdsError("That proposal was not found.");
  if (p.kind === "creative_check") return refuse(rt, actor, p, "nothing_to_run", "Ad copy is only checked; there is nothing to run.");
  if (p.status !== "approved") return refuse(rt, actor, p, "not_approved", `This proposal is ${p.status}, not approved. Nothing runs without every sign-off recorded.`);
  if (!input.approvalId) return refuse(rt, actor, p, "no_approval", "An approval id is required on every change.");

  // 2. the approval, the other sign-offs, the review
  const approval = await getApproval(rt.ctx, rt.companyId, input.approvalId);
  if (!approval || approval.proposal_id !== p.id) return refuse(rt, actor, p, "bad_approval", "That approval id is not an approval of this proposal.");
  if (approval.role !== "owner" || approval.decision !== "approved" || !approval.decided_by.startsWith("user:")) return refuse(rt, actor, p, "bad_approval", "That approval is not a person's yes (the owner's approval id is needed).");
  if (approval.consumed_at) return refuse(rt, actor, p, "approval_used", "That approval was already used. An approval runs one change, once; ask for a new one.");
  if (!approval.expires_at || Date.parse(approval.expires_at) <= rt.now().getTime()) return refuse(rt, actor, p, "approval_expired", "That approval is older than 72 hours. Ask the owner to approve again.");
  if (approval.content_hash !== p.content_hash) return refuse(rt, actor, p, "approval_stale", "The proposal changed after it was approved. The approval no longer covers these numbers.");
  const state = signoffState(p, await listApprovals(rt.ctx, rt.companyId, p.id), rt.now());
  if (!state.complete) return refuse(rt, actor, p, "signoff_missing", `Still needed before this can run: ${state.missing.join(", ")} sign-off.`);
  if (!reviewStands(p)) return refuse(rt, actor, p, "review_missing", "The Reviewer's check does not stand for these numbers.");

  // 3. the switches
  const scope = await getScope(rt.ctx, rt.companyId, p.scope_key);
  if (!scope) return refuse(rt, actor, p, "no_scope", "That scope is gone.");
  if (!rt.config.writesEnabled) return refuse(rt, actor, p, "writes_off", "Changes to ads are switched off for this company in the plugin settings (Changing ads). A person switches them on there.");
  if (!scope.allow_writes) return refuse(rt, actor, p, "writes_off", "Changes to ads are switched off for this scope. A person switches them on for the scope on the Ads page (Budgets).");

  // 4. the accounts, connections, platforms
  const targets = await resolveTargets(rt, actor, p);

  // 5. the cap
  if (SPEND_KINDS.includes(p.kind)) {
    const sp = await scopePace(rt, scope);
    if (sp.pace.capMinor === null) return refuse(rt, actor, p, "no_cap", "This scope has no monthly budget cap, so a change that adds spend cannot be checked and will not run. A person sets the cap on the Ads page (Budgets).");
    const impact = capImpact(sp.pace, sp.today, additionFromPayload(p) ?? {}, sp.spentTodayMinor);
    if (impact.state === "exceeds" && !approval.over_cap_ack) {
      return refuse(rt, actor, p, "over_cap", `This would take the month to about ${impact.projectedAfterMinor} (minor units) against a cap of ${impact.capMinor}, and the approver did not accept that. Propose a smaller change, or ask the owner to approve it over the cap.`);
    }
  }

  // 6. the numbers still match
  if (p.kind === "change_budget") {
    const campaign = await getCampaign(rt.ctx, rt.companyId, String(p.payload.accountId), String(p.payload.campaignExternalId));
    if (!campaign || campaign.daily_budget_minor !== Number(p.payload.currentDailyBudgetMinor)) {
      return refuse(rt, actor, p, "stale", "The campaign's budget is not what it was when this was proposed (somebody changed it, or it has not synced). Propose the change again against the current budget.");
    }
  }
  if (p.kind === "resume_campaign") {
    // The cap check above used the budgets seen when this was proposed; a campaign whose budget changed since (somebody raised it in the platform) would
    // switch on at a different number than the one that was checked and approved.
    for (const t of (p.payload.targets as CampaignTarget[]) ?? []) {
      const campaign = await getCampaign(rt.ctx, rt.companyId, t.accountId, t.campaignExternalId);
      if (!campaign || campaign.daily_budget_minor !== t.dailyBudgetMinor) {
        return refuse(rt, actor, p, "stale", `The budget of "${t.campaignName}" is not what it was when this was proposed (somebody changed it, or it has not synced). Propose resuming it again against the current budget.`);
      }
    }
  }
  if (p.kind === "create_campaign") {
    const dup = (await rt.ctx.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table(rt.ctx, "campaigns")} WHERE company_id = $1 AND account_id = $2 AND lower(name) = lower($3)`, [rt.companyId, String(p.payload.accountId), String(p.payload.name)]))[0];
    if (Number(dup?.n ?? 0) > 0) return refuse(rt, actor, p, "duplicate", "A campaign with that name already exists on the account. If an earlier run partly worked, check the ad platform before asking again.");
  }

  // The approval is used up, and the proposal is claimed, before the platform is asked for anything.
  if (!(await transitionProposal(rt.ctx, rt.companyId, p.id, ["approved"], "executing"))) return refuse(rt, actor, p, "busy", "This proposal is already being run.");
  if (!(await consumeApproval(rt.ctx, rt.companyId, approval.id))) {
    await transitionProposal(rt.ctx, rt.companyId, p.id, ["executing"], "approved");
    return refuse(rt, actor, p, "approval_used", "That approval was just used by another call.");
  }
  await audit(rt.ctx, rt.companyId, { actor: actorText(actor), action: "write.started", scopeKey: p.scope_key, subject: p.id, detail: { kind: p.kind, approvalId: approval.id, approvedBy: approval.decided_by } });

  const results: ExecuteResult["results"] = [];
  const startedAt = rt.now().toISOString();
  const touched = new Map<string, AccountRow>();
  for (const t of targets) {
    touched.set(t.account.id, t.account);
    try {
      if (p.kind === "create_campaign") {
        const created = await t.provider.createCampaign(t.env, t.token, t.ref, {
          name: String(p.payload.name),
          objective: String(p.payload.objective),
          dailyBudgetMinor: Number(p.payload.dailyBudgetMinor),
          specialAdCategories: (p.payload.specialAdCategories as string[]) ?? [],
        });
        results.push({ what: `Created "${created.name}" (paused)`, ok: true, externalId: created.externalId });
      } else if (p.kind === "change_budget") {
        await t.provider.setCampaignBudget(t.env, t.token, t.ref, String(p.payload.campaignExternalId), Number(p.payload.newDailyBudgetMinor));
        results.push({ what: `Set the daily budget of "${String(p.payload.campaignName)}" to ${Number(p.payload.newDailyBudgetMinor)} minor units`, ok: true, externalId: String(p.payload.campaignExternalId) });
      } else {
        const status = p.kind === "pause_campaign" ? "paused" : "active";
        await t.provider.setCampaignStatus(t.env, t.token, t.ref, t.target!.campaignExternalId, status);
        results.push({ what: `${status === "paused" ? "Paused" : "Resumed"} "${t.target!.campaignName}"`, ok: true, externalId: t.target!.campaignExternalId });
      }
    } catch (error) {
      if (error instanceof ProviderError && error.tokenInvalid) {
        const conn = t.account.connection_id ? await getConnection(rt.ctx, rt.companyId, t.account.connection_id) : null;
        if (conn) await markNeedsReconnect(rt, conn, error.message);
      }
      results.push({ what: t.target ? `${p.kind === "pause_campaign" ? "Pause" : "Resume"} "${t.target.campaignName}"` : p.kind === "create_campaign" ? `Create "${String(p.payload.name)}"` : "Change the budget", ok: false, error: errorMessage(error).slice(0, 300) });
      break;
    }
  }
  const ok = results.length > 0 && results.every((r) => r.ok) && results.length === targets.length;
  const failed = results.find((r) => !r.ok);
  await updateProposal(rt.ctx, rt.companyId, p.id, {
    status: ok ? "executed" : "failed",
    executedNow: true,
    execution: { startedAt, finishedAt: rt.now().toISOString(), by: actorText(actor), approvalId: approval.id, results },
    error: ok ? null : failed?.error ?? "Not every part ran.",
  });
  await audit(rt.ctx, rt.companyId, { actor: actorText(actor), action: ok ? "write.executed" : "write.failed", scopeKey: p.scope_key, subject: p.id, detail: { kind: p.kind, results: results.map((r) => ({ what: r.what, ok: r.ok, error: r.error })) } });
  const summary = results.map((r) => `- ${r.ok ? "Done" : "Failed"}: ${r.what}${r.error ? ` (${r.error})` : ""}`).join("\n");
  await note(rt.ctx, rt.companyId, p.approval_issue_id, `${ok ? "**Executed.**" : "**Did not complete.**"}\n${summary}`);
  await closeRunIssue(rt.ctx, rt.companyId, p.id, ok ? "Executed." : `Did not complete: ${failed?.error ?? "see the proposal"}. A person decides what next; nothing is retried by itself.`);
  // Look at the account again so the new campaign or status shows up (best effort: the change already happened).
  for (const account of touched.values()) await syncAccount(rt, account, { days: 1 }).catch(() => undefined);
  return {
    proposalId: p.id,
    status: ok ? "executed" : "failed",
    results,
    message: ok ? "Done. Nothing else runs by itself: a created campaign is paused until a separate approved change switches it on." : `Did not complete: ${failed?.error ?? "not every part ran"}. The approval is used up; ask for a new one to try again.`,
  };
}

interface ResolvedTarget {
  account: AccountRow;
  ref: AccountRef;
  provider: ReturnType<AdsRuntime["provider"]>;
  env: Awaited<ReturnType<typeof providerEnv>>;
  token: Awaited<ReturnType<typeof tokenFor>>;
  target?: CampaignTarget;
}

/** Every account the change touches, with its connection, platform and token: each must be able to change ads. */
async function resolveTargets(rt: AdsRuntime, actor: ExecuteActor, p: ProposalRow): Promise<ResolvedTarget[]> {
  const wanted: Array<{ accountId: string; target?: CampaignTarget }> =
    p.kind === "pause_campaign" || p.kind === "resume_campaign"
      ? ((p.payload.targets as CampaignTarget[]) ?? []).map((t) => ({ accountId: t.accountId, target: t }))
      : [{ accountId: String(p.payload.accountId) }];
  const out: ResolvedTarget[] = [];
  for (const w of wanted) {
    const account = await getAccount(rt.ctx, rt.companyId, w.accountId);
    if (!account || account.status !== "active") return refuse(rt, actor, p, "account_gone", "An ad account in this change is gone or not active.");
    if (account.scope_key !== p.scope_key) return refuse(rt, actor, p, "scope_mismatch", "An ad account in this change belongs to another scope.");
    const conn = account.connection_id ? await getConnection(rt.ctx, rt.companyId, account.connection_id) : null;
    if (!conn || (conn.status !== "connected" && conn.status !== "expiring")) return refuse(rt, actor, p, "connection_down", "The connection for this ad account needs signing in again before anything can change.");
    if (!conn.can_write) return refuse(rt, actor, p, "read_only_connection", "This connection was made read-only (it was not given the change permission). Connect with the change permission switched on in the plugin settings.");
    let env;
    try {
      env = await providerEnv(rt, conn.platform);
    } catch (error) {
      return refuse(rt, actor, p, "platform_off", errorMessage(error));
    }
    let token;
    try {
      token = await tokenFor(rt, conn);
    } catch (error) {
      return refuse(rt, actor, p, "connection_down", errorMessage(error));
    }
    out.push({ account, ref: { externalId: account.external_id, currency: account.currency, loginCustomerId: account.login_customer_id, conversionActions: account.conversion_actions }, provider: rt.provider(conn.platform), env, token, ...(w.target ? { target: w.target } : {}) });
  }
  return out;
}

