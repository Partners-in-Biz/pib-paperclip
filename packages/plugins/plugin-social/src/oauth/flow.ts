/**
 * OAuth through the static bridge page.
 *
 * start (UI action) → provider → /_plugins/<installation uuid>/ui/oauth-callback.html
 * → bridge POSTs {companyId, state, params} to the `oauth-complete` route
 * → exchange → one account, or a picker (sealed options) the UI confirms.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { openJson, sealJson } from "@partnersinbiz/pib-plugin-kit";
import { envFor, sealToken } from "../accounts.js";
import { resolveClient } from "../clients.js";
import { loadSocialConfig, type ProviderApp, type SocialConfig } from "../config.js";
import {
  consumeOauthSession,
  createOauthSession,
  deleteOauthSession,
  findAccountByExternal,
  getAccount,
  getMastodonApp,
  getOauthSession,
  getPickerSession,
  saveMastodonApp,
  sessionExtra,
  setSessionPending,
  upsertAccount,
} from "../db.js";
import { SocialError } from "../domain.js";
import { CONNECT_MODE, isSocialPlatform, PLATFORM_LABELS, type SocialPlatform } from "../platforms.js";
import { publicOrigin } from "./http.js";
import { connectBluesky } from "./providers/bluesky.js";
import { registerMastodonApp } from "./providers/mastodon.js";
import { providerFor } from "./registry.js";
import type { ConnectCandidate, ProviderEnv } from "./types.js";

export class OAuthFlowError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "OAuthFlowError";
  }
}

const SESSION_TTL_SECONDS = 900;

async function mastodonApp(ctx: PluginContext, config: SocialConfig, instanceUrl: string): Promise<ProviderApp> {
  const redirectUri = config.redirectUri();
  const keyring = await config.keyring();
  const cached = await getMastodonApp(ctx, config.companyId, instanceUrl);
  if (cached && cached.redirect_uri === redirectUri) {
    try {
      return { platform: "mastodon", clientId: cached.client_id, clientSecret: openJson<string>(cached.client_secret_enc, keyring) };
    } catch {
      // Key rotated without the old key: register again below.
    }
  }
  const app = await registerMastodonApp(instanceUrl, redirectUri, config.publicBaseUrl ?? redirectUri);
  await saveMastodonApp(ctx, {
    companyId: config.companyId,
    instanceUrl,
    clientId: app.clientId,
    clientSecretEnc: sealJson(app.clientSecret, keyring),
    redirectUri,
    keyVersion: keyring.currentVersion,
  });
  return { platform: "mastodon", ...app };
}

export interface StartInput {
  platform: string;
  instanceUrl?: string;
  defaultSubreddit?: string;
  reconnectAccountId?: string;
  clientRef?: string;
}

export async function startOAuth(ctx: PluginContext, companyId: string, userId: string | null, input: StartInput) {
  if (!isSocialPlatform(input.platform)) throw new SocialError(`Unsupported platform: ${input.platform}`);
  const platform: SocialPlatform = input.platform;
  if (CONNECT_MODE[platform] === "credentials") throw new SocialError("Bluesky connects with a handle and an app password, not OAuth");
  const config = await loadSocialConfig(ctx, companyId);
  const redirectUri = config.redirectUri();
  const provider = providerFor(platform);
  if (!provider.authorize) throw new SocialError(`${PLATFORM_LABELS[platform]} cannot be connected with OAuth`);

  const sessionExtraInput: Record<string, unknown> = {};
  const authorizeInput: Record<string, string> = {};
  let app: ProviderApp;
  if (platform === "mastodon") {
    const instanceUrl = await publicOrigin(input.instanceUrl || config.mastodonDefaultInstance || "https://mastodon.social", "Mastodon instance URL");
    app = await mastodonApp(ctx, config, instanceUrl);
    authorizeInput.instanceUrl = instanceUrl;
  } else {
    const status = config.platform(platform);
    if (!status.configured) {
      throw new SocialError(`${PLATFORM_LABELS[platform]} is not configured. Add ${status.missing.join(" and ")} in the Social plugin settings.`);
    }
    app = { platform, clientId: status.clientId!, apiVersion: status.apiVersion ?? undefined, scopes: status.scopes ?? undefined };
  }
  if (input.reconnectAccountId) {
    const existing = await getAccount(ctx, companyId, input.reconnectAccountId);
    if (!existing) throw new SocialError("The account to reconnect was not found");
    sessionExtraInput.reconnectAccountId = existing.id;
  }
  if (input.defaultSubreddit) sessionExtraInput.defaultSubreddit = input.defaultSubreddit;
  if (input.clientRef) {
    const client = await resolveClient(ctx, companyId, input.clientRef);
    if (client?.clientRef) sessionExtraInput.clientRef = client.clientRef;
  }
  const env: ProviderEnv = { app, redirectUri, linkedinOrgPages: config.linkedinOrgPages };
  const state = randomBytes(24).toString("base64url");
  const result = await provider.authorize(env, state, authorizeInput);
  await createOauthSession(ctx, {
    state,
    companyId,
    platform,
    label: PLATFORM_LABELS[platform],
    extra: { ...(result.sessionExtra ?? {}), ...sessionExtraInput },
    createdByUserId: userId,
    ttlSeconds: SESSION_TTL_SECONDS,
  });
  return { authorizeUrl: result.url, state, platform, label: PLATFORM_LABELS[platform], redirectUri };
}

async function socialPath(ctx: PluginContext, companyId: string, query: Record<string, string>): Promise<string | null> {
  try {
    const company = await ctx.companies.get(companyId);
    if (!company?.issuePrefix) return null;
    return `/${company.issuePrefix}/social?${new URLSearchParams({ tab: "accounts", ...query }).toString()}`;
  } catch {
    return null;
  }
}

async function saveCandidate(
  ctx: PluginContext,
  config: SocialConfig,
  input: { companyId: string; userId: string | null; candidate: ConnectCandidate; clientRef?: string | null },
): Promise<{ id: string; created: boolean; platform: SocialPlatform; displayName: string }> {
  const keyring = await config.keyring();
  const client = input.clientRef ? await resolveClient(ctx, input.companyId, input.clientRef) : undefined;
  const c = input.candidate;
  const saved = await upsertAccount(ctx, {
    company_id: input.companyId,
    platform: c.platform,
    display_name: c.displayName,
    external_id: c.externalId,
    handle: c.handle,
    avatar_url: c.avatarUrl,
    token_enc: sealToken(c.token, keyring),
    token_expires_at: c.expiresAt,
    scopes: c.scopes,
    meta: { ...c.meta, kind: c.meta.kind ?? c.kind },
    key_version: keyring.currentVersion,
    client_ref: client?.clientRef ?? null,
    client_name: client?.clientName ?? null,
    created_by_user_id: input.userId,
  });
  return { ...saved, platform: c.platform, displayName: c.displayName };
}

/** Called by the `oauth-complete` API route (the bridge page). */
export async function completeOAuth(
  ctx: PluginContext,
  input: { companyId: string; userId: string | null; state: string; params: Record<string, string> },
): Promise<{ redirectTo: string | null; platform: string; connected: number; pickerId: string | null }> {
  const session = await getOauthSession(ctx, input.state);
  if (!session) throw new OAuthFlowError("This sign-in expired or was already used. Start the connection again.", 400);
  if (session.company_id !== input.companyId) throw new OAuthFlowError("This sign-in was started for another company.", 403);
  if (session.created_by_user_id && input.userId && session.created_by_user_id !== input.userId) {
    throw new OAuthFlowError("This sign-in was started by another user.", 403);
  }
  if (input.params.error) {
    await deleteOauthSession(ctx, input.state);
    throw new OAuthFlowError(input.params.error_description || input.params.error_message || input.params.error, 400);
  }
  if (!(await consumeOauthSession(ctx, input.state))) throw new OAuthFlowError("This sign-in was already used. Start the connection again.", 409);
  const platform = session.platform as SocialPlatform;
  const extra = sessionExtra(session);
  try {
    const config = await loadSocialConfig(ctx, input.companyId);
    const provider = providerFor(platform);
    if (!provider.exchange) throw new OAuthFlowError(`${PLATFORM_LABELS[platform]} has no OAuth exchange`);
    let env: ProviderEnv;
    if (platform === "mastodon") {
      const instanceUrl = typeof extra.instanceUrl === "string" ? extra.instanceUrl : "";
      if (!instanceUrl) throw new OAuthFlowError("The Mastodon sign-in lost its instance URL. Start again.");
      env = { app: await mastodonApp(ctx, config, instanceUrl), redirectUri: config.redirectUri() };
    } else {
      env = await envFor(config, platform, {});
    }
    const { candidates } = await provider.exchange(env, input.params, extra);
    if (candidates.length === 0) throw new OAuthFlowError(`No ${PLATFORM_LABELS[platform]} accounts were returned.`);
    const clientRef = typeof extra.clientRef === "string" ? extra.clientRef : null;

    const reconnectId = typeof extra.reconnectAccountId === "string" ? extra.reconnectAccountId : null;
    if (reconnectId) {
      const existing = await getAccount(ctx, input.companyId, reconnectId);
      const match = existing && candidates.find((c) => c.platform === existing.platform && c.externalId === existing.external_id);
      if (match) {
        await saveCandidate(ctx, config, { companyId: input.companyId, userId: input.userId, candidate: match, clientRef });
        await deleteOauthSession(ctx, input.state);
        return { redirectTo: await socialPath(ctx, input.companyId, { connected: platform }), platform, connected: 1, pickerId: null };
      }
    }
    if (candidates.length === 1) {
      await saveCandidate(ctx, config, { companyId: input.companyId, userId: input.userId, candidate: candidates[0]!, clientRef });
      await deleteOauthSession(ctx, input.state);
      return { redirectTo: await socialPath(ctx, input.companyId, { connected: candidates[0]!.platform }), platform, connected: 1, pickerId: null };
    }
    const keyring = await config.keyring();
    const pickerId = randomUUID();
    await setSessionPending(ctx, input.state, pickerId, sealJson(candidates, keyring));
    return { redirectTo: await socialPath(ctx, input.companyId, { picker: pickerId }), platform, connected: 0, pickerId };
  } catch (error) {
    await deleteOauthSession(ctx, input.state).catch(() => undefined);
    throw error;
  }
}

async function openPicker(ctx: PluginContext, companyId: string, userId: string | null, pickerId: string) {
  const session = await getPickerSession(ctx, companyId, pickerId);
  if (!session || !session.pending_options) throw new SocialError("This account choice expired. Connect again.");
  if (session.created_by_user_id && userId && session.created_by_user_id !== userId) throw new SocialError("This account choice belongs to another user.");
  const config = await loadSocialConfig(ctx, companyId);
  const candidates = openJson<ConnectCandidate[]>(session.pending_options, await config.keyring());
  return { session, config, candidates };
}

/** Options for the picker. Tokens never leave the worker. */
export async function pendingOptions(ctx: PluginContext, companyId: string, userId: string | null, pickerId: string) {
  const { session, candidates } = await openPicker(ctx, companyId, userId, pickerId);
  const options = [];
  for (const c of candidates) {
    const existing = await findAccountByExternal(ctx, companyId, c.platform, c.externalId);
    options.push({
      key: c.key,
      platform: c.platform,
      kind: c.kind,
      externalId: c.externalId,
      displayName: c.displayName,
      handle: c.handle,
      avatarUrl: c.avatarUrl,
      alreadyConnected: Boolean(existing && existing.token_enc && existing.status !== "disabled"),
      detail: typeof c.meta.pageName === "string" ? `Linked to ${c.meta.pageName}` : typeof c.meta.boardName === "string" ? `Board: ${c.meta.boardName}` : null,
    });
  }
  const extra = sessionExtra(session);
  return {
    pickerId,
    platform: session.platform,
    label: isSocialPlatform(session.platform) ? PLATFORM_LABELS[session.platform] : session.platform,
    clientRef: typeof extra.clientRef === "string" ? extra.clientRef : null,
    options,
  };
}

export async function confirmPicker(
  ctx: PluginContext,
  companyId: string,
  userId: string | null,
  input: { pickerId: string; selections: string[]; clientRef?: string | null },
) {
  if (input.selections.length === 0) throw new SocialError("Choose at least one account");
  const { session, config, candidates } = await openPicker(ctx, companyId, userId, input.pickerId);
  const chosen = candidates.filter((c) => input.selections.includes(c.key));
  if (chosen.length === 0) throw new SocialError("None of the chosen accounts are in this sign-in");
  const extra = sessionExtra(session);
  const clientRef = input.clientRef !== undefined ? input.clientRef : typeof extra.clientRef === "string" ? extra.clientRef : null;
  const saved = [];
  for (const candidate of chosen) saved.push(await saveCandidate(ctx, config, { companyId, userId, candidate, clientRef }));
  await deleteOauthSession(ctx, session.state);
  return { connected: saved.length, accounts: saved };
}

export async function connectBlueskyAccount(
  ctx: PluginContext,
  companyId: string,
  userId: string | null,
  input: { identifier: string; appPassword: string; pdsUrl?: string | null; clientRef?: string | null },
) {
  const config = await loadSocialConfig(ctx, companyId);
  await config.keyring();
  const candidate = await connectBluesky({ identifier: input.identifier, appPassword: input.appPassword, pdsUrl: input.pdsUrl, defaultPds: config.blueskyDefaultPds });
  const saved = await saveCandidate(ctx, config, { companyId, userId, candidate, clientRef: input.clientRef ?? null });
  return { ...saved, handle: candidate.handle };
}
