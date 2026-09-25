/** Provider contract implemented by every platform. */
import type { AccountTokenBundle, PlatformAppConfig, ProviderContext, PublishInput, PublishResult, SocialPlatform } from "../types.js";

export interface SocialProviderImpl {
  platform: SocialPlatform;
  /** OAuth2 authorization-code provider (true) vs credential-based (false). */
  oauth2: boolean;
  requiresClientSecret?: boolean;
  /** OAuth2: build the platform authorize URL. */
  getAuthorizeUrl(ctx: ProviderContext, state: string, extra?: Record<string, string>): string;
  /**
   * OAuth1/stateful flows: start a connection and return the browser URL plus
   * session extra to persist (e.g. X request-token secret). When present the
   * route uses this instead of getAuthorizeUrl.
   */
  start?(ctx: ProviderContext, state: string, extra?: Record<string, string>): Promise<{ authorizeUrl: string; sessionExtra?: Record<string, unknown> }>;
  /** OAuth2: exchange the authorization code for tokens + profile. */
  exchangeCode(ctx: ProviderContext, code: string, extra?: Record<string, string>): Promise<AccountTokenBundle>;
  /** Renew an expired token bundle (platforms with refresh tokens). */
  refresh?(ctx: ProviderContext, bundle: AccountTokenBundle): Promise<AccountTokenBundle>;
  /** Publish a post using the stored tokens. */
  publish(ctx: ProviderContext, bundle: AccountTokenBundle, input: PublishInput): Promise<PublishResult>;
  /** Platforms that connect with user-supplied credentials instead of OAuth (bluesky, mastodon). */
  connectWithCredentials?(cfg: PlatformAppConfig, creds: Record<string, string>): Promise<AccountTokenBundle>;
}

export const NO_AUTH_URL = "";
