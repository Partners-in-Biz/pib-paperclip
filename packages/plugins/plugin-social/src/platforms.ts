/**
 * Platform constants shared by the worker, the manifest and the UI bundle.
 * Keep this file free of Node imports: the UI bundle imports it.
 */

export const PLUGIN_ID = "partnersinbiz.social";
export const SOCIAL_AGENT_KEY = "social-media-manager";
export const SOCIAL_PROJECT_KEY = "social";
/**
 * The weekly plan routine. It declares no `issueTemplate`: the host then opens
 * its issues as `routine_execution` with the routine's own id as origin id (the
 * Routines page and the host's run lookup both rely on that). A template with
 * an `originId` of our own and no `surfaceVisibility: "plugin_operation"` makes
 * the host query a uuid column with that string and fail the whole dispatch.
 */
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

/** `awaiting_manual`: the publish time came on a manual account; a person posts it by hand and marks it as posted. */
export const DESTINATION_STATUSES = ["pending", "publishing", "retrying", "awaiting_manual", "published", "failed"] as const;
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

/**
 * A person can open these for editing: saving moves the post back to draft first, so changed content is approved again.
 * Published and partly published posts stay as they are: what went out cannot be changed from here.
 */
export function editableViaDraft(status: string): boolean {
  return status === "approved" || status === "scheduled" || status === "failed";
}

/**
 * X's own reply box, open on the post with `text` already in it. X refuses most replies through its API, so a person
 * posts them there, signed in to X in their own browser. No id: null.
 */
export function xReplyIntentUrl(postId: string | null | undefined, text: string): string | null {
  if (!postId || !/^\d+$/.test(postId)) return null;
  const trimmed = text.trim();
  return `https://x.com/intent/post?in_reply_to=${postId}${trimmed ? `&text=${encodeURIComponent(trimmed)}` : ""}`;
}

/** What a hand-posted destination carries to the platform's own composer. */
export interface ComposeIntentInput {
  text: string;
  title?: string | null;
  link?: string | null;
  subreddit?: string | null;
  /** Public address of the first image (Pinterest takes it). */
  imageUrl?: string | null;
  /** The Mastodon instance of the account. */
  instanceUrl?: string | null;
}

export interface ComposeIntent {
  /** The platform's own composer or upload page. */
  url: string;
  /** True when `url` opens with the text already in the box. False: the person pastes the copied caption. */
  prefilled: boolean;
  /** True when the media cannot ride along in `url` and the person adds it there (always, except a Pinterest image). */
  mediaByHand: boolean;
}

const enc = encodeURIComponent;

/**
 * Where a person posts by hand, signed in to the platform in their own browser or app. A platform that documents a
 * share link gets the text in the box; TikTok, Instagram, YouTube, Facebook (without a link) and Dribbble document
 * none, so the page copies the caption and opens the upload screen. No platform takes a video or an uploaded image
 * through a link: the post page shares or saves the file.
 */
export function composeIntent(platform: SocialPlatform, input: ComposeIntentInput): ComposeIntent {
  const text = input.text.trim();
  const link = input.link?.trim() || null;
  const withLink = link && !text.includes(link) ? `${text}${text ? "\n\n" : ""}${link}` : text;
  switch (platform) {
    case "x":
      return { url: `https://x.com/intent/post?text=${enc(withLink)}`, prefilled: true, mediaByHand: true };
    case "linkedin":
      return { url: `https://www.linkedin.com/feed/?shareActive=true&text=${enc(withLink)}`, prefilled: true, mediaByHand: true };
    case "threads":
      return { url: `https://www.threads.net/intent/post?text=${enc(text)}${link ? `&url=${enc(link)}` : ""}`, prefilled: true, mediaByHand: true };
    case "bluesky":
      return { url: `https://bsky.app/intent/compose?text=${enc(withLink)}`, prefilled: true, mediaByHand: true };
    case "mastodon": {
      const base = (input.instanceUrl?.trim() || "https://mastodon.social").replace(/\/+$/, "");
      return { url: `${base}/share?text=${enc(withLink)}`, prefilled: true, mediaByHand: true };
    }
    case "reddit": {
      const sub = input.subreddit?.trim().replace(/^\/?r\//i, "");
      const title = (input.title?.trim() || text.split("\n")[0] || "").slice(0, 300);
      const base = sub ? `https://www.reddit.com/r/${enc(sub)}/submit` : "https://www.reddit.com/submit";
      return { url: `${base}?title=${enc(title)}${link ? `&url=${enc(link)}` : `&type=TEXT&text=${enc(text)}`}`, prefilled: true, mediaByHand: true };
    }
    case "pinterest": {
      if (!input.imageUrl) return { url: "https://www.pinterest.com/pin-creation-tool/", prefilled: false, mediaByHand: true };
      return {
        url: `https://www.pinterest.com/pin/create/button/?media=${enc(input.imageUrl)}&description=${enc(text)}${link ? `&url=${enc(link)}` : ""}`,
        prefilled: true,
        mediaByHand: false,
      };
    }
    case "facebook":
      // Facebook's share dialog takes a link only; it ignores prefilled text.
      return link
        ? { url: `https://www.facebook.com/sharer/sharer.php?u=${enc(link)}`, prefilled: false, mediaByHand: true }
        : { url: "https://www.facebook.com/", prefilled: false, mediaByHand: true };
    case "tiktok":
      return { url: "https://www.tiktok.com/upload", prefilled: false, mediaByHand: true };
    case "youtube":
      return { url: "https://www.youtube.com/upload", prefilled: false, mediaByHand: true };
    case "instagram":
      return { url: "https://www.instagram.com/", prefilled: false, mediaByHand: true };
    case "dribbble":
      return { url: "https://dribbble.com/uploads/new", prefilled: false, mediaByHand: true };
  }
}

/** `manual:<handle>`: the stable external id of a manual account (it has no platform id). */
export function manualExternalId(handle: string): string {
  return `manual:${handle.trim().replace(/^@+/, "").toLowerCase()}`;
}
