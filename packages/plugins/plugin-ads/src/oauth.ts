/**
 * Connecting an ad platform: sign in through the static bridge page (the same flow Social uses), or save a Meta system-user token in the
 * settings and connect with it. Signing in is a person's one-time grant: only a signed-in person can start or finish it.
 *
 * start (page action) -> provider -> /_plugins/<installation uuid>/ui/oauth-callback.html -> POST /oauth/complete {companyId, state, params}
 * -> code exchange -> sealed token in a connection row. The first connection is read-only unless the settings ask for the write grant.
 */
import { randomBytes } from "node:crypto";
import { sealJson, withClientParam } from "@partnersinbiz/pib-plugin-kit";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { audit, consumeOauthSession, createOauthSession, getOauthSession, insertConnection, listAccounts, listConnections, updateAccount, updateConnection } from "./db.js";
import { AdsError } from "./domain.js";
import { closeIssue } from "./issues.js";
import { isAdPlatform, PLATFORM_LABELS, type AdPlatform } from "./platforms.js";
import type { TokenBundle } from "./providers/types.js";
import { providerEnv, type AdsRuntime } from "./runtime.js";

export class OAuthFlowError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "OAuthFlowError";
  }
}

const SESSION_TTL_SECONDS = 900;

export async function startOAuth(rt: AdsRuntime, userId: string | null, platformInput: string) {
  if (!userId) throw new AdsError("A signed-in person connects an ad platform.");
  if (!isAdPlatform(platformInput)) throw new AdsError(`Unsupported platform: ${platformInput}`);
  const platform: AdPlatform = platformInput;
  const state = randomBytes(24).toString("base64url");
  const env = await providerEnv(rt, platform, { needRedirect: true });
  if (!env.app.clientId || !env.app.clientSecret) throw new AdsError(`${PLATFORM_LABELS[platform]} has no app saved for signing in. Add the app ID and secret in the plugin settings first.`);
  await rt.config.keyring();
  const { url, scopes } = rt.provider(platform).authorize(env, state);
  await createOauthSession(rt.ctx, { state, companyId: rt.companyId, platform, userId, ttlSeconds: SESSION_TTL_SECONDS });
  return { authorizeUrl: url, state, platform, label: PLATFORM_LABELS[platform], redirectUri: env.redirectUri, scopes, readOnly: env.app.requestWrite !== true };
}

/** Where the person goes back to: the Ads page on the accounts tab. */
export async function adsPath(ctx: PluginContext, companyId: string, query: Record<string, string>): Promise<string | null> {
  try {
    const company = await ctx.companies.get(companyId);
    if (!company?.issuePrefix) return null;
    return withClientParam(`/${company.issuePrefix}/ads?${new URLSearchParams({ tab: "accounts", ...query }).toString()}`, null);
  } catch {
    return null;
  }
}

/** Called by the `oauth-complete` API route (the bridge page). */
export async function completeOAuth(
  rt: AdsRuntime,
  input: { userId: string | null; state: string; params: Record<string, string> },
): Promise<{ redirectTo: string | null; platform: string; connectionId: string; canWrite: boolean }> {
  const session = await getOauthSession(rt.ctx, input.state);
  if (!session) throw new OAuthFlowError("This sign-in expired or was already used. Start the connection again.", 400);
  if (session.company_id !== rt.companyId) throw new OAuthFlowError("This sign-in was started for another company.", 403);
  if (session.created_by_user_id && input.userId && session.created_by_user_id !== input.userId) throw new OAuthFlowError("This sign-in was started by another user.", 403);
  if (session.expired) throw new OAuthFlowError("This sign-in expired. Start the connection again.", 400);
  if (input.params.error) throw new OAuthFlowError(input.params.error_description || input.params.error_message || input.params.error, 400);
  if (!(await consumeOauthSession(rt.ctx, input.state))) throw new OAuthFlowError("This sign-in was already used. Start the connection again.", 409);
  if (!isAdPlatform(session.platform)) throw new OAuthFlowError("Unsupported platform.");
  const platform = session.platform;
  const env = await providerEnv(rt, platform, { needRedirect: true });
  const exchanged = await rt.provider(platform).exchange(env, input.params);
  const keyring = await rt.config.keyring();
  const id = await insertConnection(rt.ctx, {
    companyId: rt.companyId,
    platform,
    label: exchanged.label,
    mode: "oauth",
    tokenEnc: sealJson(exchanged.token, keyring),
    keyVersion: keyring.currentVersion,
    expiresAt: exchanged.token.expiresAt ?? null,
    scopes: exchanged.scopes,
    // A connection may change ads only when the settings asked for it AND the platform granted it.
    canWrite: exchanged.canWrite && env.app.requestWrite === true,
    externalUserId: exchanged.externalUserId,
    createdBy: input.userId,
  });
  await audit(rt.ctx, rt.companyId, { actor: input.userId ? `user:${input.userId}` : "system", action: "connection.created", subject: id, detail: { platform, scopes: exchanged.scopes, canWrite: exchanged.canWrite && env.app.requestWrite === true } });
  await takeOverFrom(rt, id, platform, exchanged.externalUserId, exchanged.token);
  return { redirectTo: await adsPath(rt.ctx, rt.companyId, { connected: platform }), platform, connectionId: id, canWrite: exchanged.canWrite && env.app.requestWrite === true };
}

/** Meta system-user token saved in the settings: verified by listing the ad accounts it can see, then connected without a sign-in. */
export async function connectWithToken(rt: AdsRuntime, userId: string | null, platformInput: string) {
  if (!userId) throw new AdsError("A signed-in person connects an ad platform.");
  if (platformInput !== "meta") throw new AdsError("Only Meta can connect with a saved token. Google signs in.");
  const state = rt.config.platform("meta");
  if (!state.enabled || !state.token) throw new AdsError("No system-user token is saved for Meta in the plugin settings.");
  const token = await rt.config.systemToken("meta");
  if (!token) throw new AdsError("The saved Meta token could not be read.");
  const env = await providerEnv(rt, "meta");
  const accounts = await rt.provider("meta").listAccounts(env, { accessToken: token });
  const id = await insertConnection(rt.ctx, {
    companyId: rt.companyId,
    platform: "meta",
    label: "Meta (system user)",
    mode: "token",
    tokenEnc: null,
    keyVersion: null,
    expiresAt: null,
    scopes: state.requestWrite ? ["ads_read", "ads_management"] : ["ads_read"],
    canWrite: state.requestWrite,
    externalUserId: "system-user",
    createdBy: userId,
  });
  await audit(rt.ctx, rt.companyId, { actor: `user:${userId}`, action: "connection.created", subject: id, detail: { platform: "meta", mode: "token", accountsVisible: accounts.length } });
  return { connectionId: id, accountsVisible: accounts.length };
}

/** The rehearsal platform: connects without any sign-in. */
export async function connectMock(rt: AdsRuntime, userId: string | null) {
  if (!userId) throw new AdsError("A signed-in person connects an ad platform.");
  if (!rt.config.platform("mock").enabled) throw new AdsError("The test platform is switched off in the plugin settings.");
  const id = await insertConnection(rt.ctx, { companyId: rt.companyId, platform: "mock", label: "Test platform (made-up numbers)", mode: "token", tokenEnc: null, keyVersion: null, expiresAt: null, scopes: ["mock"], canWrite: true, externalUserId: "mock-user", createdBy: userId });
  await audit(rt.ctx, rt.companyId, { actor: `user:${userId}`, action: "connection.created", subject: id, detail: { platform: "mock" } });
  return { connectionId: id };
}

/**
 * A new sign-in replaces an old one that is the same person (Meta tells us who) or that needs signing in again (Google tells us nobody):
 * the ad accounts the NEW sign-in can see move over, and an old connection left with no account is retired and its "sign in again" issue closes.
 * An account the new sign-in cannot see stays where it is. Two sign-ins of different people stay separate.
 */
async function takeOverFrom(rt: AdsRuntime, newId: string, platform: AdPlatform, externalUserId: string | null, token: TokenBundle): Promise<void> {
  const olds = (await listConnections(rt.ctx, rt.companyId)).filter((old) => old.id !== newId && old.platform === platform && ((externalUserId && old.external_user_id === externalUserId) || old.status === "needs_reconnect"));
  if (olds.length === 0) return;
  let visible: Set<string>;
  try {
    visible = new Set((await rt.provider(platform).listAccounts(await providerEnv(rt, platform), token)).map((a) => a.externalId));
  } catch (error) {
    rt.ctx.logger.info("Ads sign-in take-over skipped", { platform, error: error instanceof Error ? error.message.slice(0, 200) : String(error) });
    return;
  }
  const accounts = await listAccounts(rt.ctx, rt.companyId, { includeDisabled: true });
  for (const old of olds) {
    const mine = accounts.filter((a) => a.connection_id === old.id);
    for (const account of mine) if (visible.has(account.external_id)) await updateAccount(rt.ctx, rt.companyId, account.id, { connectionId: newId });
    const left = mine.filter((a) => !visible.has(a.external_id));
    if (left.length === 0) {
      await updateConnection(rt.ctx, rt.companyId, old.id, { status: "disabled", tokenEnc: null, statusDetail: "Replaced by a newer sign-in." });
      await closeIssue(rt.ctx, rt.companyId, old.reconnect_issue_id, "done", "Signed in again; the new connection took over this one's ad accounts.");
    }
  }
}
