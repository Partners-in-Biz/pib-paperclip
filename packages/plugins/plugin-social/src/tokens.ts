/**
 * Token lifecycle (`refresh-tokens` job, hourly).
 *
 * - refresh_token platforms (LinkedIn, X, TikTok, YouTube, Pinterest,
 *   Reddit): refresh when the access token expires within 48 hours.
 * - long-lived platforms (Facebook/Instagram via fb_exchange_token,
 *   Instagram Login via ig_refresh_token, Threads via th_refresh_token):
 *   re-exchange within 10 days of expiry.
 * - tokens that cannot be refreshed: mark `expiring` a week ahead and open a
 *   reconnect issue; `needs_reconnect` once expired or when a refresh fails.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { AccountUnavailable, markNeedsReconnect, openToken, refreshAccountToken, toProviderAccount } from "./accounts.js";
import { loadSocialConfig, type SocialConfig } from "./config.js";
import { accountsExpiringBefore, companiesWithAccounts, iso, setAccountState, type AccountRow } from "./db.js";
import { LONG_LIVED_HORIZON_MS, needsRefreshBeforePublish, refreshDecision } from "./domain.js";
import { openReconnectIssue } from "./issues.js";
import { ProviderHttpError } from "./oauth/http.js";
import { providerFor } from "./oauth/registry.js";
import type { ProviderAccount } from "./oauth/types.js";
import { isSocialPlatform } from "./platforms.js";

export interface RefreshRunSummary {
  checked: number;
  refreshed: number;
  warned: number;
  needsReconnect: number;
  errors: number;
}

async function warnExpiring(ctx: PluginContext, companyId: string, row: AccountRow, message: string): Promise<void> {
  await setAccountState(ctx, row.id, { status: row.status === "needs_reconnect" ? undefined : "expiring", lastError: message });
  if (row.reconnect_issue_id) return;
  const issueId = await openReconnectIssue(ctx, companyId, row, message);
  if (issueId) await setAccountState(ctx, row.id, { reconnectIssueId: issueId });
}

export async function refreshCompanyTokens(ctx: PluginContext, config: SocialConfig, now = new Date()): Promise<RefreshRunSummary> {
  const summary: RefreshRunSummary = { checked: 0, refreshed: 0, warned: 0, needsReconnect: 0, errors: 0 };
  const companyId = config.companyId;
  const horizon = new Date(now.getTime() + LONG_LIVED_HORIZON_MS).toISOString();
  const rows = await accountsExpiringBefore(ctx, companyId, horizon);
  if (rows.length === 0) return summary;
  const keyring = await config.keyring();
  for (const row of rows) {
    if (!isSocialPlatform(row.platform)) continue;
    summary.checked += 1;
    const provider = providerFor(row.platform);
    let hasRefreshToken = false;
    try {
      hasRefreshToken = Boolean(openToken(row, keyring).refreshToken);
    } catch (error) {
      await markNeedsReconnect(ctx, companyId, row, error instanceof Error ? error.message : String(error));
      summary.needsReconnect += 1;
      continue;
    }
    const decision = refreshDecision({
      id: row.id,
      platform: row.platform,
      status: row.status,
      expiresAt: iso(row.token_expires_at),
      refreshKind: provider.refreshKind,
      hasRefreshToken,
    }, now);
    if (decision.action === "skip") continue;
    if (decision.action === "expired") {
      await markNeedsReconnect(ctx, companyId, row, "The access token expired and this platform cannot refresh it. Reconnect the account.");
      summary.needsReconnect += 1;
      continue;
    }
    if (decision.action === "warn") {
      const when = iso(row.token_expires_at)?.slice(0, 10) ?? "soon";
      await warnExpiring(ctx, companyId, row, `The access token expires on ${when} and cannot be refreshed automatically. Reconnect before then.`);
      summary.warned += 1;
      continue;
    }
    try {
      await refreshAccountToken(ctx, config, row);
      summary.refreshed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const expired = needsRefreshBeforePublish(iso(row.token_expires_at), now);
      const transient = error instanceof ProviderHttpError && error.retryable && !expired;
      if (transient) {
        await setAccountState(ctx, row.id, { lastError: `Token refresh failed, will retry: ${message}` });
        summary.errors += 1;
      } else {
        await markNeedsReconnect(ctx, companyId, row, `Token refresh failed: ${message}`);
        summary.needsReconnect += 1;
      }
    }
  }
  return summary;
}

export async function refreshTokensJob(
  ctx: PluginContext,
  ensureCompany: (companyId: string) => Promise<void>,
  /** Extra per-company work (the hourly hire link check). Errors are swallowed. */
  eachCompany?: (companyId: string) => Promise<void>,
): Promise<RefreshRunSummary> {
  const total: RefreshRunSummary = { checked: 0, refreshed: 0, warned: 0, needsReconnect: 0, errors: 0 };
  for (const companyId of await companiesWithAccounts(ctx)) {
    await ensureCompany(companyId).catch(() => undefined);
    if (eachCompany) await eachCompany(companyId).catch(() => undefined);
    const config = await loadSocialConfig(ctx, companyId);
    if (!config.saved) continue;
    try {
      const s = await refreshCompanyTokens(ctx, config);
      total.checked += s.checked;
      total.refreshed += s.refreshed;
      total.warned += s.warned;
      total.needsReconnect += s.needsReconnect;
      total.errors += s.errors;
    } catch (error) {
      total.errors += 1;
      ctx.logger.error("Social token refresh failed for company", { companyId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return total;
}

/** Open an account for a read call (metrics, inbox, reply), refreshing it first if it lapses soon. */
export async function freshAccount(ctx: PluginContext, config: SocialConfig, row: AccountRow): Promise<ProviderAccount> {
  if (!row.token_enc || row.status === "disabled") throw new AccountUnavailable(`${row.display_name} is disconnected`, false);
  const keyring = await config.keyring();
  const provider = providerFor(row.platform);
  if (provider.refresh && provider.refreshKind !== "none" && needsRefreshBeforePublish(iso(row.token_expires_at))) {
    return (await refreshAccountToken(ctx, config, row)).account;
  }
  return toProviderAccount(row, keyring);
}
