/**
 * Account token handling: seal/open token bundles, build provider envs,
 * refresh with a DB lock, and mark accounts that need reconnecting.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { openJson, sealJson, TokenKeyError, type TokenKeyring } from "@partnersinbiz/pib-plugin-kit";
import { sameClient, scopeColumns, scopeLabel, scopeOfRow, scopeOut, type ClientScope, type ResolvedScope } from "./clients.js";
import type { SocialConfig } from "./config.js";
import {
  accountMeta,
  detachAccountFromOtherFeeds,
  getAccount,
  iso,
  lockAccountRefresh,
  saveAccountToken,
  setAccountScope,
  setAccountState,
  setInboxScopeForAccount,
  unlockAccountRefresh,
  unpublishedDestinationsOutside,
  type AccountRow,
} from "./db.js";
import { SocialError } from "./domain.js";
import { openReconnectIssue } from "./issues.js";
import { isSocialPlatform, PLATFORM_LABELS, type SocialPlatform } from "./platforms.js";
import { appPlatformFor, providerFor } from "./oauth/registry.js";
import type { ProviderAccount, ProviderEnv, TokenBundle } from "./oauth/types.js";
import { timing } from "./oauth/http.js";

export function sealToken(bundle: TokenBundle, keyring: TokenKeyring): string {
  return sealJson(bundle, keyring);
}

export class AccountUnavailable extends Error {
  constructor(message: string, readonly needsReconnect: boolean) {
    super(message);
    this.name = "AccountUnavailable";
  }
}

export function openToken(row: AccountRow, keyring: TokenKeyring): TokenBundle {
  if (!row.token_enc) throw new AccountUnavailable(`${row.display_name} has no stored token; reconnect it`, true);
  try {
    const bundle = openJson<TokenBundle>(row.token_enc, keyring);
    if (!bundle || typeof bundle !== "object") throw new TokenKeyError("Stored token is empty");
    return bundle;
  } catch (error) {
    if (error instanceof TokenKeyError || error instanceof SyntaxError) {
      throw new AccountUnavailable(`${row.display_name}: ${error.message}`, true);
    }
    throw error;
  }
}

export function toProviderAccount(row: AccountRow, keyring: TokenKeyring): ProviderAccount {
  if (!isSocialPlatform(row.platform)) throw new AccountUnavailable(`Unsupported platform ${row.platform}`, false);
  return {
    id: row.id,
    platform: row.platform,
    externalId: row.external_id ?? "",
    handle: row.handle,
    displayName: row.display_name,
    meta: accountMeta(row),
    token: openToken(row, keyring),
  };
}

export async function envFor(
  config: SocialConfig,
  platform: SocialPlatform,
  meta: Record<string, unknown>,
  extra: Partial<ProviderEnv> = {},
): Promise<ProviderEnv> {
  const appPlatform = appPlatformFor(platform, meta);
  const app = await config.app(appPlatform);
  return { app, redirectUri: config.redirectUri(), linkedinOrgPages: config.linkedinOrgPages, ...extra };
}

/** Set needs_reconnect, remember the error and open one reconnect issue. */
export async function markNeedsReconnect(ctx: PluginContext, companyId: string, row: AccountRow, reason: string): Promise<void> {
  await setAccountState(ctx, row.id, { status: "needs_reconnect", lastError: reason.slice(0, 1000) });
  if (row.reconnect_issue_id) return;
  const issueId = await openReconnectIssue(ctx, companyId, row, reason);
  if (issueId) await setAccountState(ctx, row.id, { reconnectIssueId: issueId });
}

/**
 * Refresh the account's token now. Takes a short DB lock because refresh
 * tokens may rotate (X, TikTok); if another run holds the lock, waits and
 * re-reads the row instead.
 */
export async function refreshAccountToken(
  ctx: PluginContext,
  config: SocialConfig,
  row: AccountRow,
): Promise<{ account: ProviderAccount; row: AccountRow }> {
  const platform = row.platform as SocialPlatform;
  const provider = providerFor(platform);
  if (!provider.refresh) throw new AccountUnavailable(`${PLATFORM_LABELS[platform]} tokens cannot be refreshed; reconnect before they expire`, true);
  const keyring = await config.keyring();
  if (!(await lockAccountRefresh(ctx, row.id))) {
    await timing.sleep(3_000);
    const fresh = await getAccount(ctx, row.company_id, row.id);
    if (!fresh) throw new AccountUnavailable("Account was removed", false);
    return { account: toProviderAccount(fresh, keyring), row: fresh };
  }
  try {
    const current = toProviderAccount(row, keyring);
    const env = await envFor(config, platform, current.meta);
    const next = await provider.refresh(env, current);
    const tokenEnc = sealToken(next.token, keyring);
    await saveAccountToken(ctx, row.id, {
      tokenEnc,
      keyVersion: keyring.currentVersion,
      expiresAt: next.expiresAt,
      status: "connected",
      meta: next.meta,
    });
    const updated: AccountRow = {
      ...row,
      token_enc: tokenEnc,
      key_version: keyring.currentVersion,
      token_expires_at: next.expiresAt,
      status: "connected",
      last_error: null,
      meta: { ...accountMeta(row), ...(next.meta ?? {}) },
    };
    return { account: { ...current, token: next.token, meta: accountMeta(updated) }, row: updated };
  } catch (error) {
    await unlockAccountRefresh(ctx, row.id).catch(() => undefined);
    throw error;
  }
}

/** Shape sent to the UI and to agents. Never includes tokens. */
export function publicAccount(row: AccountRow): Record<string, unknown> {
  const meta = accountMeta(row);
  return {
    id: row.id,
    platform: row.platform,
    scope: row.scope,
    ownerUserId: row.owner_user_id,
    status: row.status,
    displayName: row.display_name,
    handle: row.handle ?? null,
    externalId: row.external_id ?? null,
    avatarUrl: row.avatar_url ?? null,
    connected: Boolean(row.token_enc) && row.status !== "disabled",
    tokenExpiresAt: iso(row.token_expires_at),
    lastRefreshedAt: iso(row.last_refreshed_at),
    lastError: row.last_error ?? null,
    ...scopeOut(row),
    kind: typeof meta.kind === "string" ? meta.kind : null,
    via: typeof meta.via === "string" ? meta.via : null,
    boardId: typeof meta.boardId === "string" ? meta.boardId : null,
    boardName: typeof meta.boardName === "string" ? meta.boardName : null,
    defaultSubreddit: typeof meta.defaultSubreddit === "string" ? meta.defaultSubreddit : null,
    instanceUrl: typeof meta.instanceUrl === "string" ? meta.instanceUrl : null,
    pageName: typeof meta.pageName === "string" ? meta.pageName : null,
    scopes: Array.isArray(row.scopes) ? row.scopes : [],
    reconnectIssueId: row.reconnect_issue_id ?? null,
  };
}

// ── Scope moves ─────────────────────────────────────────────────────────────

/**
 * An account can change scope (own work ↔ a client) only when no unpublished
 * post outside the new scope still targets it: those posts would otherwise
 * publish one client's content to another client's account.
 */
export async function assertAccountMovable(ctx: PluginContext, companyId: string, account: AccountRow, target: ResolvedScope): Promise<void> {
  if (sameClient(scopeOfRow(account), target.scope)) return;
  const blocking = await unpublishedDestinationsOutside(ctx, companyId, account.id, target.scope);
  if (blocking.length === 0) return;
  const scheduled = blocking.filter((b) => b.post_status === "scheduled" || b.post_status === "publishing").length;
  const n = blocking.length;
  throw new SocialError(
    `${account.display_name} cannot move to ${scopeLabel(target)}: ${n}${n === 50 ? "+" : ""} unpublished post${n === 1 ? "" : "s"} for ${scopeLabel(account)} still use${n === 1 ? "s" : ""} it` +
      `${scheduled ? ` (${scheduled} scheduled)` : ""}. Let them publish, or remove this account from them (unschedule first), then move it.`,
  );
}

/** Move an account and its inbox to `target`; RSS feeds of the old scope stop drafting to it. */
export async function moveAccountScope(
  ctx: PluginContext,
  companyId: string,
  account: AccountRow,
  target: ResolvedScope,
): Promise<{ moved: boolean; feedsDetached: number; from: ClientScope }> {
  const from = scopeOfRow(account);
  if (sameClient(from, target.scope)) return { moved: false, feedsDetached: 0, from };
  await assertAccountMovable(ctx, companyId, account, target);
  const columns = scopeColumns(target);
  await setAccountScope(ctx, companyId, account.id, columns);
  await setInboxScopeForAccount(ctx, companyId, account.id, columns);
  const feedsDetached = await detachAccountFromOtherFeeds(ctx, companyId, account.id, target.scope);
  return { moved: true, feedsDetached, from };
}
