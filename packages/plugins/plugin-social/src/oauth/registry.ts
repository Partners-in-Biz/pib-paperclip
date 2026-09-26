/** Provider registry: platform → implementation. */
import { isSocialPlatform, type SocialPlatform } from "../platforms.js";
import type { SocialProvider } from "./types.js";
import { facebookProvider, instagramProvider, threadsProvider } from "./providers/meta.js";
import { linkedinProvider } from "./providers/linkedin.js";
import { xProvider } from "./providers/x.js";
import { tiktokProvider } from "./providers/tiktok.js";
import { youtubeProvider } from "./providers/youtube.js";
import { pinterestProvider } from "./providers/pinterest.js";
import { redditProvider } from "./providers/reddit.js";
import { blueskyProvider } from "./providers/bluesky.js";
import { mastodonProvider } from "./providers/mastodon.js";
import { dribbbleProvider } from "./providers/dribbble.js";

export const PROVIDERS: Record<SocialPlatform, SocialProvider> = {
  facebook: facebookProvider,
  instagram: instagramProvider,
  threads: threadsProvider,
  linkedin: linkedinProvider,
  x: xProvider,
  tiktok: tiktokProvider,
  youtube: youtubeProvider,
  pinterest: pinterestProvider,
  reddit: redditProvider,
  bluesky: blueskyProvider,
  mastodon: mastodonProvider,
  dribbble: dribbbleProvider,
};

export function providerFor(platform: string): SocialProvider {
  if (!isSocialPlatform(platform)) throw new Error(`Unsupported platform: ${platform}`);
  return PROVIDERS[platform];
}

/**
 * Which app credentials an account uses. Instagram accounts connected
 * through Facebook Login use the Meta (facebook) app.
 */
export function appPlatformFor(platform: SocialPlatform, meta: Record<string, unknown>): SocialPlatform {
  if (platform === "instagram" && meta.via === "facebook_login") return "facebook";
  return platform;
}
