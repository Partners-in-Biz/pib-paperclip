/**
 * Connect Gmail through the kit's static OAuth bridge page:
 * Mailbox page (connect-start action) → Google consent → /_plugins/<uuid>/ui/oauth-callback.html
 * → POST {companyId, state, params} to the `oauth-complete` route → tokens sealed on the account.
 */
import { randomUUID } from "node:crypto";
import type { PluginApiRequestInput, PluginApiResponse } from "@paperclipai/plugin-sdk";
import { pluginUiBase, requirePublicBaseUrl, TokenKeyError } from "@partnersinbiz/pib-plugin-kit";
import { gmailRedirectUri, loadMailboxConfig } from "../config.js";
import { MailboxError } from "../domain.js";
import { buildGoogleAuthorizeUrl, exchangeGoogleCode, getProfile, GMAIL_MODIFY_SCOPE, GMAIL_SEND_SCOPE, GmailApiError } from "./api.js";
import { errorMessage, type Env } from "./env.js";
import { closeReconnectIssue, googleClient, keyringFor, sealTokens } from "./tokens.js";

export const SESSION_TTL_SECONDS = 15 * 60;

function safeReturnTo(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = value.trim();
  // Same-origin paths only; the callback page follows it.
  return path.startsWith("/") && !path.startsWith("//") && path.length <= 500 ? path : null;
}

export async function connectStart(env: Env, companyId: string, userId: string | null, params: Record<string, unknown>) {
  if (!userId) throw new MailboxError("A person must connect Gmail from the Mailbox page");
  const loaded = await loadMailboxConfig(env.ctx, companyId);
  const base = requirePublicBaseUrl(loaded.config.publicBaseUrl);
  await keyringFor(loaded);
  await googleClient(loaded);
  const redirectUri = gmailRedirectUri(base, await pluginUiBase(env.ctx));
  const state = randomUUID();
  await env.store.insertOAuthSession({ state, companyId, createdByUserId: userId, returnTo: safeReturnTo(params.returnTo), ttlSeconds: SESSION_TTL_SECONDS });
  const loginHint = typeof params.loginHint === "string" && params.loginHint.includes("@") ? params.loginHint.trim() : null;
  return {
    authorizeUrl: buildGoogleAuthorizeUrl({ clientId: loaded.config.googleClientId, redirectUri, state, loginHint }),
    state,
    redirectUri,
    expiresInSeconds: SESSION_TTL_SECONDS,
  };
}

function apiError(status: number, error: string): PluginApiResponse {
  return { status, body: { error } };
}

export async function oauthComplete(env: Env, input: PluginApiRequestInput): Promise<PluginApiResponse> {
  const body = (input.body && typeof input.body === "object" ? input.body : {}) as Record<string, unknown>;
  const state = typeof body.state === "string" ? body.state : "";
  const params = (body.params && typeof body.params === "object" ? body.params : {}) as Record<string, unknown>;
  if (!state) return apiError(400, "Missing state");
  const session = await env.store.getOAuthSession(state);
  if (!session) return apiError(400, "This connection attempt expired or was already used. Start again from the Mailbox page.");
  if (session.companyId !== input.companyId) return apiError(403, "This connection was started in another company");
  await env.store.deleteOAuthSession(state);
  if (session.expired) return apiError(400, "This connection attempt expired. Start again from the Mailbox page.");
  if (input.actor.actorType !== "user") return apiError(403, "Only a person can finish connecting Gmail");
  if (typeof params.error === "string" && params.error) {
    return apiError(400, `Google did not grant access: ${String(params.error_description ?? params.error)}`);
  }
  const code = typeof params.code === "string" ? params.code : "";
  if (!code) return apiError(400, "Google did not return an authorization code");
  try {
    const loaded = await loadMailboxConfig(env.ctx, session.companyId);
    const base = requirePublicBaseUrl(loaded.config.publicBaseUrl);
    const client = await googleClient(loaded);
    const keyring = await keyringFor(loaded);
    const tokens = await exchangeGoogleCode(env.fetch, { ...client, redirectUri: gmailRedirectUri(base, await pluginUiBase(env.ctx)), code }, env.now());
    if (!tokens.refreshToken) {
      return apiError(400, "Google did not return a refresh token. Remove this app at myaccount.google.com/permissions for that Google account, then connect again.");
    }
    const granted = tokens.scope.split(/\s+/);
    if (!granted.includes(GMAIL_MODIFY_SCOPE) || !granted.includes(GMAIL_SEND_SCOPE)) {
      return apiError(400, "Gmail read and send access were not both granted. Connect again and tick every permission.");
    }
    const profile = await getProfile(env.fetch, tokens.accessToken);
    if (!profile.emailAddress) return apiError(400, "Gmail did not return the account address");
    const { sealed, version } = sealTokens(tokens, keyring);
    const userId = input.actor.userId ?? input.actor.actorId;
    const existing = await env.store.findAccountByAddress(session.companyId, profile.emailAddress);
    const accountId = existing?.id ?? randomUUID();
    if (!existing) {
      const current = await env.store.defaultAccount(session.companyId);
      await env.store.insertAccount({ id: accountId, companyId: session.companyId, provider: "gmail", address: profile.emailAddress, ownerUserId: userId, isDefault: !current });
    }
    await env.store.updateAccount(session.companyId, accountId, {
      provider: "gmail",
      address: profile.emailAddress,
      status: "connected",
      token_sealed: sealed,
      token_expires_at: new Date(tokens.expiresAt).toISOString(),
      scopes: tokens.scope,
      key_version: version,
      // Keep the cursor on a reconnect so nothing between is missed; a new account starts with a 7-day resync.
      history_id: existing?.history_id ?? null,
      last_error: null,
      connected_by_user_id: userId,
      connected_at: new Date(env.now()).toISOString(),
    });
    env.tokenCache.set(accountId, { token: tokens.accessToken, expiresAt: tokens.expiresAt });
    const account = await env.store.getAccount(session.companyId, accountId);
    if (account) await closeReconnectIssue(env, account);
    return { status: 200, body: { redirectTo: session.returnTo ?? "/", address: profile.emailAddress, accountId } };
  } catch (error) {
    const message =
      error instanceof MailboxError || error instanceof GmailApiError || error instanceof TokenKeyError ? error.message : `Connection failed: ${errorMessage(error)}`;
    return apiError(400, message);
  }
}

export async function disconnect(env: Env, companyId: string, accountId: string) {
  const account = await env.store.getAccount(companyId, accountId);
  if (!account) throw new MailboxError("Mailbox not found");
  await env.store.updateAccount(companyId, accountId, {
    status: "disconnected",
    token_sealed: null,
    token_expires_at: null,
    last_error: null,
    is_default: false,
  });
  env.tokenCache.delete(accountId);
  return { id: accountId, status: "disconnected" };
}
