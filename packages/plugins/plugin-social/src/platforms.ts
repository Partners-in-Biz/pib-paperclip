/**
 * Platform constants shared by the worker, the manifest and the UI bundle.
 * Keep this file free of Node imports: the UI bundle imports it.
 */

export const PLUGIN_ID = "partnersinbiz.social";
export const SOCIAL_AGENT_KEY = "social-media-manager";
export const SOCIAL_PROJECT_KEY = "social";
export const PLAN_ROUTINE_KEY = "plan-next-week";

export type SocialPlatform =
  | "facebook"
  | "instagram"
  | "threads"
  | "linkedin"
  | "x"
  | "tiktok"
  | "youtube"
  | "pinterest"
  | "reddit"
  | "bluesky"
  | "mastodon"
  | "dribbble";

/** Connection order shown in the UI (Meta first, per the rollout plan). */
export const ALL_PLATFORMS: SocialPlatform[] = [
  "facebook",
  "instagram",
  "threads",
  "linkedin",
  "x",
  "tiktok",
  "youtube",
  "pinterest",
  "reddit",
  "bluesky",
  "mastodon",
  "dribbble",
];

export const PLATFORM_LABELS: Record<SocialPlatform, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  threads: "Threads",
  linkedin: "LinkedIn",
  x: "X",
  tiktok: "TikTok",
  youtube: "YouTube",
  pinterest: "Pinterest",
  reddit: "Reddit",
  bluesky: "Bluesky",
  mastodon: "Mastodon",
  dribbble: "Dribbble",
};

/** How an account is connected. */
export const CONNECT_MODE: Record<SocialPlatform, "oauth" | "credentials" | "instance"> = {
  facebook: "oauth",
  instagram: "oauth",
  threads: "oauth",
  linkedin: "oauth",
  x: "oauth",
  tiktok: "oauth",
  youtube: "oauth",
  pinterest: "oauth",
  reddit: "oauth",
  bluesky: "credentials",
  mastodon: "instance",
  dribbble: "oauth",
};

/** Platforms whose OAuth app credentials live in plugin settings (Bluesky and Mastodon need none). */
export const NEEDS_APP_CREDENTIALS: Record<SocialPlatform, boolean> = {
  facebook: true,
  instagram: true,
  threads: true,
  linkedin: true,
  x: true,
  tiktok: true,
  youtube: true,
  pinterest: true,
  reddit: true,
  bluesky: false,
  mastodon: false,
  dribbble: true,
};

export function isSocialPlatform(value: unknown): value is SocialPlatform {
  return typeof value === "string" && (ALL_PLATFORMS as string[]).includes(value);
}

export const ACCOUNT_STATUSES = ["connected", "expiring", "needs_reconnect", "disabled"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const POST_STATUSES = [
  "draft",
  "review",
  "approved",
  "scheduled",
  "publishing",
  "published",
  "partially_published",
  "failed",
] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export const DESTINATION_STATUSES = ["pending", "publishing", "retrying", "published", "failed"] as const;
export type DestinationStatus = (typeof DESTINATION_STATUSES)[number];

/** Per-platform override fields. */
export interface PlatformOverride {
  text?: string;
  title?: string;
  link?: string;
  privacy?: string;
  subreddit?: string;
  boardId?: string;
}

export const OVERRIDE_FIELDS: Record<SocialPlatform, Array<keyof PlatformOverride>> = {
  facebook: ["text", "link"],
  instagram: ["text"],
  threads: ["text", "link"],
  linkedin: ["text", "link"],
  x: ["text", "link"],
  tiktok: ["text", "title", "privacy"],
  youtube: ["text", "title", "privacy"],
  pinterest: ["text", "title", "link", "boardId"],
  reddit: ["text", "title", "link", "subreddit"],
  bluesky: ["text", "link"],
  mastodon: ["text", "privacy"],
  dribbble: ["text", "title"],
};

export const PRIVACY_OPTIONS: Partial<Record<SocialPlatform, Array<{ value: string; label: string }>>> = {
  youtube: [
    { value: "private", label: "Private" },
    { value: "unlisted", label: "Unlisted" },
    { value: "public", label: "Public" },
  ],
  tiktok: [
    { value: "SELF_ONLY", label: "Only me" },
    { value: "MUTUAL_FOLLOW_FRIENDS", label: "Friends" },
    { value: "FOLLOWER_OF_CREATOR", label: "Followers" },
    { value: "PUBLIC_TO_EVERYONE", label: "Everyone" },
  ],
  mastodon: [
    { value: "public", label: "Public" },
    { value: "unlisted", label: "Unlisted" },
    { value: "private", label: "Followers only" },
  ],
};

/** Content limits used by the composer and the publish validation. */
export const PLATFORM_LIMITS: Record<SocialPlatform, {
  maxText: number;
  maxMedia: number;
  needsMedia: "none" | "image" | "video" | "any";
  video: boolean;
}> = {
  facebook: { maxText: 63206, maxMedia: 10, needsMedia: "none", video: true },
  instagram: { maxText: 2200, maxMedia: 10, needsMedia: "any", video: true },
  threads: { maxText: 500, maxMedia: 20, needsMedia: "none", video: true },
  linkedin: { maxText: 3000, maxMedia: 20, needsMedia: "none", video: true },
  x: { maxText: 280, maxMedia: 4, needsMedia: "none", video: true },
  tiktok: { maxText: 2200, maxMedia: 1, needsMedia: "video", video: true },
  youtube: { maxText: 5000, maxMedia: 1, needsMedia: "video", video: true },
  pinterest: { maxText: 500, maxMedia: 5, needsMedia: "image", video: false },
  reddit: { maxText: 40000, maxMedia: 1, needsMedia: "none", video: false },
  bluesky: { maxText: 300, maxMedia: 4, needsMedia: "none", video: false },
  mastodon: { maxText: 500, maxMedia: 4, needsMedia: "none", video: true },
  dribbble: { maxText: 1000, maxMedia: 1, needsMedia: "image", video: false },
};

export const MEDIA_MAX_BYTES = 512 * 1024 * 1024;
export const SOCIAL_MEDIA_MIME = ["image/jpeg", "image/png", "image/gif", "image/webp", "video/mp4", "video/quicktime"];

export const COMPLETE_ROUTE_PATH = `/api/plugins/${PLUGIN_ID}/api/oauth/complete`;

const UI_BASE_RE = /^\/_plugins\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/ui\/$/;

/**
 * `<publicBaseUrl>/_plugins/<installation uuid>/ui/oauth-callback.html`. The host
 * serves static plugin files only by installation uuid (the key form fails),
 * and the Social page reports that base on load.
 */
export function bridgeRedirectUri(publicBaseUrl: string, uiBase: string): string {
  if (!UI_BASE_RE.test(uiBase)) throw new Error("The Social callback address is not known yet. Open the Social page once, then try again.");
  return `${publicBaseUrl.replace(/\/$/, "")}${uiBase}oauth-callback.html`;
}
