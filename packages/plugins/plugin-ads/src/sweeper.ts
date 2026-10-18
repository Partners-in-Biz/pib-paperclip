/** Hourly sweep: auto-pause ACTIVE campaigns at/over lifetime or scope monthly cap using fresh insights. */
import { listAccounts, listCampaigns, findAlert, listScopes, table, getConnection, updateCampaignStatus } from "./db.js";
import { monthOf, monthStart, todayIn, lifetimeWindowStart } from "./dates.js";
import { errorMessage } from "./domain.js";
import { raiseSweepAlert } from "./evaluate.js";
import { tokenFor } from "./connections.js";
import { providerEnv } from "./runtime.js";
import type { AdsRuntime } from "./runtime.js";
import type { AlertCandidate } from "./alerts.js";
import type { ProviderEnv, TokenBundle, AdsProvider } from "./providers/types.js";

export interface SweepResult {
  accounts: number;
  campaigns: number;
  paused: number;
  retried: number;
  critical: number;
  disapprovedAlerts: number;
  errors: number;
}

interface ProviderContext {
  env: ProviderEnv;
  token: TokenBundle;
  provider: AdsProvider;
  ref: { externalId: string; currency: string; loginCustomerId?: string | null; conversionActions?: string[] };
}

async function getProviderContext(rt: AdsRuntime, accountId: string, connectionId: string, platform: string): Promise<ProviderContext | null> {
  const conn = await getConnection(rt.ctx, rt.companyId, connectionId);
  if (!conn || (conn.status !== "connected" && conn.status !== "expiring")) return null;
  const account = await listAccounts(rt.ctx, rt.companyId).then((a) => a.find((x) => x.id === accountId));
  if (!account) return null;
  const token = await tokenFor(rt, conn);
  const env = await providerEnv(rt, platform as any);
  const provider = rt.provider(platform as any);
  return { env, token, provider, ref: { externalId: account.external_id, currency: account.currency, loginCustomerId: account.login_customer_id, conversionActions: account.conversion_actions } };
}

async function alertFor(rt: AdsRuntime, scope: Awaited<ReturnType<typeof listScopes>>[number], severity: "info" | "warn" | "bad", dedupeKey: string, title: string, text: string, detail: Record<string, unknown>, accountId: string, campaignExternalId: string): Promise<void> {
  const candidate: AlertCandidate = { kind: "spend_spike", severity, dedupeKey, title, text, detail };
  await raiseSweepAlert(rt, scope, candidate, { accountId, campaignExternalId });
}

export async function sweepCaps(rt: AdsRuntime): Promise<SweepResult> {
  const result: SweepResult = { accounts: 0, campaigns: 0, paused: 0, retried: 0, critical: 0, disapprovedAlerts: 0, errors: 0 };
  const now = rt.now();
  const today = todayIn(rt.config.timezone, now);
  const monthStart_ = monthStart(monthOf(today));

  const allAccounts = await listAccounts(rt.ctx, rt.companyId);
  const activeAccounts = allAccounts.filter((a) => a.status === "active");
  result.accounts = activeAccounts.length;
  if (activeAccounts.length === 0) return result;

  const insightsByAccount: Record<string, { spend: Map<string, number>; lifetimeSpend: Map<string, number> | undefined; rows: Array<{ day: string; spendMinor: number }>; errors: string[]; lifetimeError: boolean }> = {};
  for (const account of activeAccounts) {
    if (!account.connection_id) continue;
    try {
      const ctx = await getProviderContext(rt, account.id, account.connection_id, account.platform);
      if (!ctx) continue;
      const dailyRows = await rt.ctx.db.query<{ day: string }>(`SELECT MIN(day)::text AS day FROM ${table(rt.ctx, "daily")} WHERE account_id = $1`, [account.id]);
      const since = !dailyRows[0]?.day || dailyRows[0].day < monthStart_ ? dailyRows[0]?.day ?? monthStart_ : monthStart_;
      const insights = await ctx.provider.insights(ctx.env, ctx.token, ctx.ref, { since, until: today });
      const spend = new Map<string, number>();
      for (const row of insights) {
        const cur = spend.get(row.campaignExternalId) ?? 0;
        spend.set(row.campaignExternalId, cur + row.spendMinor);
      }
      // For lifetime budgets, fetch all historical spend within the 36-month window.
      let lifetimeSpend: Map<string, number> | undefined;
      let lifetimeError = false;
      try {
        const windowStart = lifetimeWindowStart(today);
        const lifetimeInsights = await ctx.provider.insights(ctx.env, ctx.token, ctx.ref, { since: windowStart, until: today });
        lifetimeSpend = new Map<string, number>();
        for (const row of lifetimeInsights) {
          const cur = lifetimeSpend.get(row.campaignExternalId) ?? 0;
          lifetimeSpend.set(row.campaignExternalId, cur + row.spendMinor);
        }
      } catch {
        lifetimeError = true;
      }
      insightsByAccount[account.id] = { spend, lifetimeSpend, lifetimeError, rows: insights.map((r) => ({ day: r.day, spendMinor: r.spendMinor })), errors: [] };
    } catch (error) {
      const errorMsg = errorMessage(error);
      insightsByAccount[account.id] = { spend: new Map(), lifetimeSpend: undefined, lifetimeError: true, rows: [], errors: [errorMsg] };
      result.errors++;
    }
  }

  for (const scope of await listScopes(rt.ctx, rt.companyId)) {
    const scopeAccounts = activeAccounts.filter((a) => a.scope_key === scope.scope_key);
    if (scopeAccounts.length === 0) continue;

    const campaignsByAccount = new Map<string, Array<{ id: string; external_id: string; name: string; lifetime_budget_minor: number | null }>>();
    for (const account of scopeAccounts) {
      const camps = await listCampaigns(rt.ctx, rt.companyId, { accountId: account.id, status: "active" });
      if (camps.length > 0) campaignsByAccount.set(account.id, camps.map((c) => ({ id: c.id, external_id: c.external_id, name: c.name, lifetime_budget_minor: c.lifetime_budget_minor })));
    }
    result.campaigns += Array.from(campaignsByAccount.values()).reduce((s, c) => s + c.length, 0);

    const paused = new Set<string>();
    // Build provider contexts once per account for reuse
    const ctxByAccountId = new Map<string, ProviderContext | null>();
    const insightFailuresAlerted = new Set<string>();
    for (const [accountId] of campaignsByAccount) {
      const account = activeAccounts.find((a) => a.id === accountId)!;
      if (!account.connection_id) continue;
      ctxByAccountId.set(accountId, await getProviderContext(rt, account.id, account.connection_id, account.platform));
    }

    // Raise sweep-insights-failed alerts once per account at the top level
    for (const [accountId] of campaignsByAccount) {
      const account = activeAccounts.find((a) => a.id === accountId)!;
      const insight = insightsByAccount[accountId];
      if ((insight?.errors.length ?? 0) > 0 || insight?.lifetimeError) {
        if (!insightFailuresAlerted.has(accountId)) {
          await alertFor(rt, scope, "warn", `sweep-insights-failed:${accountId}`, `${account.name}: spend insights unavailable`, `Account "${account.name}" insights failed; pausing decisions use partial data from the ledger.`, { accountId }, accountId, "");
          insightFailuresAlerted.add(accountId);
        }
      }
    }

    for (const [accountId, campaigns] of campaignsByAccount) {
      const account = activeAccounts.find((a) => a.id === accountId)!;
      const insight = insightsByAccount[accountId];
      if (!insight) continue;
      for (const camp of campaigns) {
        if (!paused.has(camp.id) && camp.lifetime_budget_minor !== null) {
          // Lifetime spend is the max of fresh window and full ledger (both are lower bounds, so the larger is safe).
          let lifetimeSpendMinor = insight.lifetimeSpend?.get(camp.external_id) ?? 0;
          // Always check ledger for earlier spend.
          const ledger = await rt.ctx.db.query<{ total: string }>(`SELECT COALESCE(SUM(delta_minor), 0)::text AS total FROM ${table(rt.ctx, "spend_ledger")} WHERE account_id = $1 AND campaign_external_id = $2`, [accountId, camp.external_id]);
          const ledgerTotal = Number(ledger[0]?.total ?? 0);
          lifetimeSpendMinor = Math.max(lifetimeSpendMinor, ledgerTotal);
          if (lifetimeSpendMinor >= camp.lifetime_budget_minor) {
            const ctx = ctxByAccountId.get(accountId);
            if (!ctx) {
              await alertFor(rt, scope, "warn", `cannot-reach-account:${accountId}`, `${account.name}: account unreachable`, `Cannot establish connection to account "${account.name}"; skipping pausing.`, { accountId }, accountId, "");
              continue;
            }
            await pauseWithRetry(rt, account, camp, result, scope, accountId, paused, `lifetime budget ${camp.lifetime_budget_minor} minor units`, today, ctx);
          }
        }
      }
    }

    if (scope.monthly_cap_minor !== null) {
      let scopeSpend = 0;
      for (const acc of scopeAccounts) {
        const insight = insightsByAccount[acc.id];
        if (insight && !insight.errors.length) {
          for (const row of insight.rows) if (row.day >= monthStart_) scopeSpend += row.spendMinor;
        } else {
          const ledger = await rt.ctx.db.query<{ total: string }>(`SELECT COALESCE(SUM(delta_minor), 0)::text AS total FROM ${table(rt.ctx, "spend_ledger")} WHERE account_id = $1 AND day >= $2::date AND day <= $3::date`, [acc.id, monthStart_, today]);
          scopeSpend += Number(ledger[0]?.total ?? 0);
        }
      }
      if (scopeSpend >= scope.monthly_cap_minor) {
        for (const [accountId, campaigns] of campaignsByAccount) {
          const account = activeAccounts.find((a) => a.id === accountId)!;
          const ctx = ctxByAccountId.get(accountId);
          if (!ctx) continue;
          for (const camp of campaigns) {
            if (!paused.has(camp.id)) {
              await pauseWithRetry(rt, account, camp, result, scope, accountId, paused, `scope monthly cap ${scope.monthly_cap_minor} minor units`, today, ctx);
            }
          }
        }
      }
    }

    for (const [accountId, campaigns] of campaignsByAccount) {
      const account = activeAccounts.find((a) => a.id === accountId)!;
      const ctx = ctxByAccountId.get(accountId);
      if (!ctx) continue;
      try {
        const health = await ctx.provider.campaignHealth(ctx.env, ctx.token, ctx.ref, campaigns.map((c) => c.external_id));
        for (const h of health) {
          if (h.disapprovedAds > 0) {
            const camp = campaigns.find((c) => c.external_id === h.campaignExternalId);
            if (camp) {
              const key = `sweep-disapproved:${accountId}:${h.campaignExternalId}`;
              const existing = await findAlert(rt.ctx, rt.companyId, key);
              // Re-alert if the alert was resolved or does not exist.
              if (!existing || existing.status === "resolved") {
                await alertFor(rt, scope, "warn", key, `${camp.name}: ${h.disapprovedAds} disapproved ads`, `Campaign "${camp.name}" on account "${account.name}" has ${h.disapprovedAds} ads disapproved by the platform.`, { accountId, campaignExternalId: h.campaignExternalId, disapprovedAds: h.disapprovedAds }, accountId, h.campaignExternalId);
                result.disapprovedAlerts++;
              }
            }
          }
        }
      } catch (error) {
        result.errors++;
      }
    }
  }

  return result;
}

async function pauseWithRetry(rt: AdsRuntime, account: Awaited<ReturnType<typeof listAccounts>>[number], campaign: { id: string; external_id: string; name: string }, result: SweepResult, scope: Awaited<ReturnType<typeof listScopes>>[number], accountId: string, paused: Set<string>, reason: string, today: string, ctx: ProviderContext): Promise<void> {
  if (paused.has(campaign.id)) return;

  let succeeded = false;
  for (let i = 1; i <= 2; i++) {
    try {
      await ctx.provider.setCampaignStatus(ctx.env, ctx.token, ctx.ref, campaign.external_id, "paused");
      const health = await ctx.provider.campaignHealth(ctx.env, ctx.token, ctx.ref, [campaign.external_id]);
      const h = health[0];
      // Success only when status is explicitly 'paused'; missing row or other status = retry/fail.
      if (h && h.status === "paused") {
        succeeded = true;
        if (i === 2) result.retried++;
        break;
      }
      if (i === 2) break;
    } catch {
      if (i === 2) {
        result.critical++;
        result.errors++;
        paused.add(campaign.id);
        await alertFor(rt, scope, "bad", `sweep-unpaused:${account.id}:${campaign.external_id}:${today}`, `${campaign.name}: pause failed (${reason})`, `Campaign "${campaign.name}" pause failed after ${reason}.`, { accountId: account.id, campaignExternalId: campaign.external_id, reason }, account.id, campaign.external_id);
        return;
      }
    }
  }

  if (succeeded) {
    await updateCampaignStatus(rt.ctx, rt.companyId, campaign.id, "paused");
    result.paused++;
    paused.add(campaign.id);
    await alertFor(rt, scope, "info", `sweep-paused:${account.id}:${campaign.external_id}:${today}`, `${campaign.name}: paused`, `Campaign "${campaign.name}" paused after reaching ${reason}.`, { accountId: account.id, campaignExternalId: campaign.external_id, reason }, account.id, campaign.external_id);
  } else {
    result.critical++;
    paused.add(campaign.id);
    await alertFor(rt, scope, "bad", `sweep-unpaused:${account.id}:${campaign.external_id}:${today}`, `${campaign.name}: failed to pause (${reason})`, `Campaign "${campaign.name}" remains ACTIVE after 2 pause attempts. Reason: reached ${reason}.`, { accountId: account.id, campaignExternalId: campaign.external_id, reason }, account.id, campaign.external_id);
  }
}
