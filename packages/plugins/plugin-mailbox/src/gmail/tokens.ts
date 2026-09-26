/**
 * Sealed Gmail tokens: open, refresh (and persist the refreshed token), and
 * on a dead grant move the account to needs_reconnect with one reconnect
 * issue for the person who connected it.
 */
import { buildKeyring, createWorkIssue, openJson, sealJson, sealedVersion, TokenKeyError, type TokenKeyring } from "@partnersinbiz/pib-plugin-kit";
import type { LoadedConfig } from "../config.js";
import { GmailUnavailable, MailboxError } from "../domain.js";
import { PLUGIN_ID } from "../namespace.js";
import { GmailApiError, refreshGoogleToken, tokenNeedsRefresh } from "./api.js";
import { errorMessage, type Env } from "./env.js";
import type { AccountRow } from "./types.js";

export interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scope: string;
}

const OPEN_ISSUE = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);

export async function keyringFor(loaded: LoadedConfig): Promise<TokenKeyring> {
  const secret = await loaded.secrets.get("encryptionKey");
  if (!secret) throw new MailboxError("The token encryption key is not set. Add it in the Mailbox settings before connecting Gmail.");
  return buildKeyring({ purpose: "mailbox-gmail", companyId: loaded.companyId, secret });
}

export async function googleClient(loaded: LoadedConfig): Promise<{ clientId: string; clientSecret: string }> {
  const clientSecret = await loaded.secrets.get("google.clientSecret");
  if (!clientSecret) throw new MailboxError("The Google client secret is not set in the Mailbox settings.");
  return { clientId: loaded.config.googleClientId, clientSecret };
}

export function sealTokens(tokens: StoredTokens, keyring: TokenKeyring): { sealed: string; version: number | null } {
  const sealed = sealJson(tokens, keyring);
  return { sealed, version: sealedVersion(sealed) };
}

/** A usable access token for the account; refreshes and persists when it is about to expire. */
export async function accessToken(env: Env, loaded: LoadedConfig, account: AccountRow, options: { force?: boolean } = {}): Promise<string> {
  if (!account.token_sealed || account.status === "disconnected" || account.status === "manual") {
    throw new GmailUnavailable(`Gmail is not connected for ${account.address}. Connect it on the Mailbox page.`);
  }
  if (account.status === "needs_reconnect") {
    throw new GmailUnavailable(`Gmail access for ${account.address} stopped working. A person must reconnect it on the Mailbox page.`);
  }
  const cached = env.tokenCache.get(account.id);
  if (!options.force && cached && cached.expiresAt - 120_000 > env.now()) return cached.token;
  const keyring = await keyringFor(loaded);
  let tokens: StoredTokens;
  try {
    tokens = openJson<StoredTokens>(account.token_sealed, keyring);
  } catch (error) {
    const message = error instanceof TokenKeyError ? error.message : errorMessage(error);
    await markNeedsReconnect(env, loaded, account, message);
    throw new GmailUnavailable(`The stored Gmail token for ${account.address} cannot be read (${message}). Reconnect Gmail.`);
  }
  if (options.force || !tokens.accessToken || tokenNeedsRefresh(tokens, env.now())) {
    if (!tokens.refreshToken) {
      await markNeedsReconnect(env, loaded, account, "No refresh token stored");
      throw new GmailUnavailable(`Gmail for ${account.address} must be reconnected (no refresh token).`);
    }
    let refreshed;
    try {
      refreshed = await refreshGoogleToken(env.fetch, { ...(await googleClient(loaded)), refreshToken: tokens.refreshToken }, env.now());
    } catch (error) {
      if (error instanceof GmailApiError && error.reconnect) {
        await markNeedsReconnect(env, loaded, account, error.message);
        throw new GmailUnavailable(`Gmail access for ${account.address} was revoked or expired (${error.message}). Reconnect Gmail.`);
      }
      throw error;
    }
    tokens = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
      expiresAt: refreshed.expiresAt,
      scope: refreshed.scope || tokens.scope,
    };
    const { sealed, version } = sealTokens(tokens, keyring);
    await env.store.updateAccount(account.company_id, account.id, {
      token_sealed: sealed,
      token_expires_at: new Date(tokens.expiresAt).toISOString(),
      key_version: version,
    });
    account.token_sealed = sealed;
  }
  env.tokenCache.set(account.id, { token: tokens.accessToken, expiresAt: tokens.expiresAt });
  return tokens.accessToken;
}

/**
 * Run a Gmail call; on a 401 refresh once and retry. A grant that still fails
 * (or lacks scopes) moves the account to needs_reconnect.
 */
export async function withGmail<T>(env: Env, loaded: LoadedConfig, account: AccountRow, fn: (token: string) => Promise<T>): Promise<T> {
  const token = await accessToken(env, loaded, account);
  try {
    return await fn(token);
  } catch (error) {
    if (!(error instanceof GmailApiError) || !error.reconnect) throw error;
    if (error.status === 401) {
      env.tokenCache.delete(account.id);
      const fresh = await accessToken(env, loaded, account, { force: true });
      try {
        return await fn(fresh);
      } catch (again) {
        if (again instanceof GmailApiError && again.reconnect) {
          await markNeedsReconnect(env, loaded, account, again.message);
          throw new GmailUnavailable(`Gmail rejected the connection for ${account.address} (${again.message}). Reconnect Gmail.`);
        }
        throw again;
      }
    }
    await markNeedsReconnect(env, loaded, account, error.message);
    throw new GmailUnavailable(`Gmail access for ${account.address} is missing a permission (${error.message}). Reconnect Gmail and allow every permission.`);
  }
}

export function reconnectIssueDescription(address: string, error: string): string {
  return [
    `Gmail access for **${address}** stopped working.`,
    "",
    `Reason: ${error.slice(0, 300)}`,
    "",
    "Open **Mailbox** and click **Reconnect** next to this address, then sign in with the same Google account.",
    "",
    "Until then the Mailbox cannot sync this inbox or send mail from it. Mail other plugins asked to send waits and is retried for up to three days.",
  ].join("\n");
}

/** Moves the account to needs_reconnect and opens one reconnect issue for the person who connected it. */
export async function markNeedsReconnect(env: Env, loaded: LoadedConfig, account: AccountRow, error: string): Promise<void> {
  env.tokenCache.delete(account.id);
  const changed = await env.store.markNeedsReconnect(account.company_id, account.id, error);
  account.status = "needs_reconnect";
  account.last_error = error.slice(0, 500);
  if (!changed) return;
  if (account.alert_issue_id) {
    try {
      const existing = await env.ctx.issues.get(account.alert_issue_id, account.company_id);
      if (existing && OPEN_ISSUE.has(String(existing.status))) return;
    } catch {
      // Fall through and open a new one.
    }
  }
  try {
    const created = await createWorkIssue(env.ctx, {
      companyId: loaded.companyId,
      title: `Reconnect Gmail: ${account.address}`,
      description: reconnectIssueDescription(account.address, error),
      assigneeUserId: account.connected_by_user_id ?? account.owner_user_id ?? undefined,
      originKind: `plugin:${PLUGIN_ID}`,
      originId: `reconnect:${account.id}`,
      priority: "high",
      wake: false,
    });
    account.alert_issue_id = created.id;
    await env.store.updateAccount(account.company_id, account.id, { alert_issue_id: created.id });
  } catch (issueError) {
    env.ctx.logger.info("Gmail reconnect issue not created", { accountId: account.id, error: errorMessage(issueError) });
  }
}

/** After a reconnect: close the open reconnect issue. */
export async function closeReconnectIssue(env: Env, account: AccountRow): Promise<void> {
  if (!account.alert_issue_id) return;
  try {
    const issue = await env.ctx.issues.get(account.alert_issue_id, account.company_id);
    if (issue && OPEN_ISSUE.has(String(issue.status))) {
      await env.ctx.issues.update(account.alert_issue_id, { status: "done" }, account.company_id);
    }
  } catch (error) {
    env.ctx.logger.info("Gmail reconnect issue not closed", { accountId: account.id, error: errorMessage(error) });
  }
  await env.store.updateAccount(account.company_id, account.id, { alert_issue_id: null });
}
