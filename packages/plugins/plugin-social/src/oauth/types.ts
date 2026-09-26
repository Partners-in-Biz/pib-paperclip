/**
 * Provider contract. Providers are pure network code (native fetch) with no
 * access to the plugin context, so they can be tested with a mocked fetch.
 */
import type { ProviderApp } from "../config.js";
import type { MediaRef } from "../db.js";
import type { SocialPlatform } from "../platforms.js";

export type { SocialPlatform };
export { ALL_PLATFORMS, PLATFORM_LABELS } from "../platforms.js";

export interface ProviderEnv {
  app: ProviderApp;
  /** The bridge redirect URI registered with the provider. */
  redirectUri: string;
  linkedinOrgPages?: boolean;
  /** Stable id used for idempotency keys (destination id) when publishing. */
  idempotencyKey?: string;
}

/** Everything sealed in `accounts.token_enc`. Never leaves the worker. */
export interface TokenBundle {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string | null;
  refreshExpiresAt?: string | null;
  /** Meta: the long-lived user token behind a Page token (re-exchanged by the refresh job). */
  userAccessToken?: string;
  /** Bluesky: identifier + app password (sessions are created per publish). */
  identifier?: string;
  appPassword?: string;
  scopes?: string[];
}

/** One connectable account returned by a code exchange (a picker option when there are several). */
export interface ConnectCandidate {
  key: string;
  platform: SocialPlatform;
  kind: string;
  externalId: string;
  displayName: string;
  handle: string | null;
  avatarUrl: string | null;
  token: TokenBundle;
  /** Expiry used for refresh scheduling (may be the user token's expiry). */
  expiresAt: string | null;
  scopes: string[];
  meta: Record<string, unknown>;
}

export interface ExchangeResult {
  candidates: ConnectCandidate[];
}

export interface AuthorizeResult {
  url: string;
  /** Stored with the OAuth session (PKCE verifier, instance URL...). */
  sessionExtra?: Record<string, unknown>;
}

/** Account as seen by a provider when publishing or reading. */
export interface ProviderAccount {
  id: string;
  platform: SocialPlatform;
  externalId: string;
  handle: string | null;
  displayName: string;
  meta: Record<string, unknown>;
  token: TokenBundle;
}

export interface PublishRequest {
  text: string;
  title?: string;
  link?: string;
  privacy?: string;
  subreddit?: string;
  boardId?: string;
  firstComment?: string;
  media: MediaRef[];
}

export interface PublishOutcome {
  ok: boolean;
  externalId?: string;
  url?: string;
  error?: string;
  /** false when a retry cannot help. Defaults to true for failures. */
  retryable?: boolean;
  /** true when the provider rejected the token: the account needs reconnecting. */
  tokenInvalid?: boolean;
  /** Extra result detail stored on the destination (e.g. first comment id, processing state). */
  detail?: Record<string, unknown>;
}

export interface MetricsSnapshot {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  impressions?: number | null;
  reach?: number | null;
  saves?: number | null;
  clicks?: number | null;
  raw?: Record<string, unknown>;
  /** Updated external id (TikTok resolves the public post id later). */
  externalId?: string;
  url?: string;
}

export interface InboxCandidate {
  externalId: string;
  parentExternalId: string | null;
  kind: "comment" | "mention" | "message";
  author: string;
  body: string;
  permalink: string | null;
  receivedAt: string | null;
  /** The published destination this item belongs to, when known. */
  destinationExternalId?: string | null;
}

export interface ReplyTarget {
  externalId: string;
  parentExternalId: string | null;
  kind: string;
  /** Author handle as stored on the inbox item (Mastodon replies mention it). */
  author?: string | null;
}

export interface SocialProvider {
  platform: SocialPlatform;
  /** How tokens are kept alive. */
  refreshKind: "refresh_token" | "long_lived" | "none";
  /** Default scopes (the settings can override them). */
  defaultScopes(env: ProviderEnv): string[];
  authorize?(env: ProviderEnv, state: string, input: Record<string, string>): Promise<AuthorizeResult> | AuthorizeResult;
  exchange?(env: ProviderEnv, params: Record<string, string>, session: Record<string, unknown>): Promise<ExchangeResult>;
  refresh?(env: ProviderEnv, account: ProviderAccount): Promise<{ token: TokenBundle; expiresAt: string | null; meta?: Record<string, unknown> }>;
  publish(env: ProviderEnv, account: ProviderAccount, request: PublishRequest): Promise<PublishOutcome>;
  metrics?(env: ProviderEnv, account: ProviderAccount, externalId: string): Promise<MetricsSnapshot | null>;
  inbox?(env: ProviderEnv, account: ProviderAccount, published: Array<{ externalId: string }>): Promise<InboxCandidate[]>;
  reply?(env: ProviderEnv, account: ProviderAccount, target: ReplyTarget, text: string): Promise<PublishOutcome>;
}

export function scopesFor(provider: SocialProvider, env: ProviderEnv): string[] {
  return env.app.scopes && env.app.scopes.length ? env.app.scopes : provider.defaultScopes(env);
}
