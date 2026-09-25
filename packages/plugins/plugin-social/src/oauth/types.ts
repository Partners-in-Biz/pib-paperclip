/**
 * OAuth + publishing layer for real social platform integrations.
 * Modeled on the Partners in Biz legacy provider layer (lib/social/providers).
 */

export type SocialPlatform =
  | "facebook"
  | "instagram"
  | "threads"
  | "linkedin"
  | "x"
  | "tiktok"
  | "bluesky"
  | "mastodon"
  | "pinterest"
  | "reddit"
  | "dribbble"
  | "youtube";

export const ALL_PLATFORMS: SocialPlatform[] = [
  "facebook",
  "instagram",
  "threads",
  "linkedin",
  "x",
  "tiktok",
  "bluesky",
  "mastodon",
  "pinterest",
  "reddit",
  "dribbble",
  "youtube",
];

export const PLATFORM_LABELS: Record<SocialPlatform, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  threads: "Threads",
  linkedin: "LinkedIn",
  x: "X (Twitter)",
  tiktok: "TikTok",
  bluesky: "Bluesky",
  mastodon: "Mastodon",
  pinterest: "Pinterest",
  reddit: "Reddit",
  dribbble: "Dribbble",
  youtube: "YouTube",
};

/** OAuth app credentials resolved from plugin instance config. */
export interface PlatformAppConfig {
  clientId: string;
  clientSecret?: string;
  /** Extra per-platform config (e.g. mastodon instance URL, reddit subreddit). */
  extra?: Record<string, unknown>;
}

/** A connected account's stored token bundle (encrypt at rest in the DB). */
export interface AccountTokenBundle {
  accessToken: string;
  accessTokenSecret?: string; // OAuth1 (X)
  refreshToken?: string;
  tokenType?: string;
  expiresAt?: string; // ISO
  scopes: string[];
  externalId: string;
  name: string;
  handle?: string;
  avatarUrl?: string;
  /** Meta: page-scoped token when publishing to a Page. */
  pageToken?: string;
  pageId?: string;
  /** Meta: Instagram business account id. */
  igUserId?: string;
  /** Mastodon/PBSX etc. */
  instanceUrl?: string;
  extra?: Record<string, unknown>;
}

export interface PublishInput {
  text: string;
  mediaUrls?: string[];
  altTexts?: string[];
  replyToId?: string;
  link?: string;
  title?: string;
  /** LinkedIn/YouTube visibility */
  visibility?: "public" | "unlisted" | "private";
  /** X thread continuation */
  threadPart?: boolean;
  /** Provider-specific extras (e.g. reels, subreddit). */
  extra?: Record<string, unknown>;
}

export interface PublishResult {
  ok: boolean;
  externalId?: string;
  url?: string;
  error?: string;
}

export interface ProviderContext {
  cfg: PlatformAppConfig;
  /** Absolute base URL of this Paperclip instance (Auth publicBaseUrl). */
  publicBaseUrl: string;
  redirectPath: string;
}

/** OAuth state session (rows in plugin_social_*.oauth_sessions). */
export interface OauthSessionRow {
  state: string;
  company_id: string;
  platform: string;
  account_label: string | null;
  created_at: unknown;
  expires_at: unknown;
}
