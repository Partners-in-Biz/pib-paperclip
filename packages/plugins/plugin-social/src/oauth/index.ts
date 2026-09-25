/** High-level OAuth orchestration: config, encryption, token round-trips. */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { AccountTokenBundle, PlatformAppConfig, ProviderContext, SocialPlatform } from "./types.js";
import { decryptToken, deriveTokenKey, encryptToken } from "./crypto.js";
import { providerFor } from "./registry.js";

export const OAUTH_REDIRECT_PATH = "/social/oauth/callback";

export function publicBaseFromHeaders(headers: Record<string, string>): string {
  const proto = headers["x-forwarded-proto"] ?? "https";
  const host = headers["host"] ?? headers["x-forwarded-host"] ?? "localhost";
  return `${proto}://${host}`;
}

/** Instance-config shape: { social: { platforms: { facebook: {clientId, clientSecret, extra, scopes} }, encryptionSecret } } */
export async function loadPlatformCfg(ctx: PluginContext, platform: SocialPlatform): Promise<ResolvedCfg> {
  const config = (await ctx.config.get()) as {
    social?: {
      platforms?: Record<string, { clientId?: string; clientSecret?: string; extra?: Record<string, unknown> }>;
      encryptionSecret?: string;
    };
  };
  const social = config.social ?? {};
  const p = social.platforms?.[platform] ?? {};
  return {
    clientId: String(p.clientId ?? ""),
    clientSecret: p.clientSecret ? String(p.clientSecret) : undefined,
    extra: (p.extra ?? {}) as Record<string, unknown>,
    encryptionSecret: social.encryptionSecret,
  };
}

export interface ResolvedCfg extends PlatformAppConfig {
  encryptionSecret?: string;
}

export function makeProviderCtx(baseUrl: string, cfg: ResolvedCfg): ProviderContext {
  return { cfg, publicBaseUrl: baseUrl, redirectPath: OAUTH_REDIRECT_PATH };
}

export function tokenKeyFor(companyId: string, cfg: ResolvedCfg): Buffer {
  const material = cfg.encryptionSecret ?? cfg.clientSecret ?? `pib-social:${companyId}`;
  return deriveTokenKey(companyId, material);
}

export function bundleToEncrypted(bundle: AccountTokenBundle, key: Buffer): { tokenEnc: string; refreshEnc: string | null } {
  const { refreshToken, ...rest } = bundle;
  const tokenEnc = encryptToken(JSON.stringify(rest), key);
  const refreshEnc = refreshToken ? encryptToken(refreshToken, key) : null;
  return { tokenEnc, refreshEnc };
}

export function encryptedToBundle(tokenEnc: string, refreshEnc: string | null, key: Buffer): AccountTokenBundle {
  const parsed = JSON.parse(decryptToken(tokenEnc, key)) as AccountTokenBundle;
  if (refreshEnc) parsed.refreshToken = decryptToken(refreshEnc, key);
  return parsed;
}

/** Build a browser redirect URL for connecting a platform, creating the state session. */
export async function buildConnectUrl(
  ctx: PluginContext,
  headers: Record<string, string>,
  companyId: string,
  platform: SocialPlatform,
  extras: Record<string, string>,
): Promise<{ connectUrl: string; state: string }> {
  const { randomUUID } = await import("node:crypto");
  const state = randomUUID();
  const cfg = await loadPlatformCfg(ctx, platform);
  if (!cfg.clientId && providerFor(platform).requiresClientSecret !== false) {
    throw new Error(`Platform "${platform}" is not configured. Add its client ID/secret in the plugin settings first.`);
  }
  const base = publicBaseFromHeaders(headers);
  const pctx = makeProviderCtx(base, cfg);
  const impl = providerFor(platform);
  const label = extras.accountLabel ?? null;
  if (impl.start) {
    const started = await impl.start(pctx, state, extras);
    await createSession(ctx, { state, company_id: companyId, platform, account_label: label, extra: started.sessionExtra });
    return { connectUrl: started.authorizeUrl, state };
  }
  await createSession(ctx, { state, company_id: companyId, platform, account_label: label });
  const redirectUri = `${base}${OAUTH_REDIRECT_PATH}`;
  const qs = new URLSearchParams(extras ?? {});
  if (qs.get("scopes")) {
    return { connectUrl: impl.getAuthorizeUrl({ ...pctx, cfg }, state, { scopes: qs.get("scopes")! }), state };
  }
  return { connectUrl: impl.getAuthorizeUrl(pctx, state, extras), state };
}

async function createSession(
  ctx: PluginContext,
  session: { state: string; company_id: string; platform: string; account_label: string | null; extra?: Record<string, unknown> },
): Promise<void> {
  const { createOauthSession } = await import("../db.js");
  await createOauthSession(ctx, { ...session, ttlSeconds: 600 });
}

/** Complete a connection: exchange code/tokens and persist the account. */
export async function completeConnect(
  ctx: PluginContext,
  headers: Record<string, string>,
  state: string,
  code: string | undefined,
  oauthToken: string | undefined,
  oauthVerifier: string | undefined,
): Promise<{ platform: SocialPlatform; accountId: string; displayName: string; handle: string | null; avatarUrl: string | null }> {
  const { getOauthSession, deleteOauthSession, insertAccount } = await import("../db.js");
  const { randomUUID } = await import("node:crypto");
  const session = await getOauthSession(ctx, state);
  if (!session) throw new Error("OAuth session expired. Please try connecting again.");
  const platform = session.platform as SocialPlatform;
  const cfg = await loadPlatformCfg(ctx, platform);
  const base = publicBaseFromHeaders(headers);
  const impl = providerFor(platform);
  let bundle: AccountTokenBundle;
  const sessionExtra = (session.extra ?? {}) as Record<string, string>;
  if (platform === "x") {
    const tokenCode = oauthToken && oauthVerifier ? `${oauthToken}:${oauthVerifier}` : "";
    if (!tokenCode) throw new Error("X did not return the authorization verifier");
    bundle = await impl.exchangeCode(makeProviderCtx(base, cfg), tokenCode, { requestTokenSecret: sessionExtra.requestTokenSecret ?? "" });
  } else if (impl.start && sessionExtra.instance) {
    bundle = await impl.exchangeCode(makeProviderCtx(base, cfg), code ?? "", {
      instance: sessionExtra.instance,
      clientId: sessionExtra.clientId ?? "",
      clientSecret: sessionExtra.clientSecret ?? "",
    });
  } else {
    if (!code) throw new Error("OAuth provider did not return an authorization code");
    bundle = await impl.exchangeCode(makeProviderCtx(base, cfg), code);
  }
  const key = tokenKeyFor(session.company_id, cfg);
  const enc = bundleToEncrypted(bundle, key);
  const accountId = randomUUID();
  await insertAccount(ctx, {
    id: accountId,
    company_id: session.company_id,
    platform,
    scope: "org",
    owner_user_id: null,
    status: "connected",
    secret_ref: null,
    display_name: bundle.name,
    external_id: bundle.externalId,
    handle: bundle.handle ?? null,
    avatar_url: bundle.avatarUrl ?? null,
    token_enc: enc.tokenEnc,
    refresh_token_enc: enc.refreshEnc,
    token_expires_at: bundle.expiresAt ?? null,
    scopes: bundle.scopes,
  });
  await deleteOauthSession(ctx, state);
  return { platform, accountId, displayName: bundle.name, handle: bundle.handle ?? null, avatarUrl: bundle.avatarUrl ?? null };
}
