/** Provider registry: platform → implementation. */
import type { SocialPlatform } from "./types.js";
import type { SocialProviderImpl } from "./providers/base.js";
import { facebookProvider, instagramProvider, threadsProvider } from "./providers/meta.js";
import { linkedinProvider, xProvider } from "./providers/linkedin-x.js";
import {
  tiktokProvider,
  youtubeProvider,
  pinterestProvider,
  redditProvider,
  blueskyProvider,
  mastodonProvider,
  dribbbleProvider,
} from "./providers/others.js";

const REGISTRY: Record<SocialPlatform, SocialProviderImpl> = {
  facebook: facebookProvider,
  instagram: instagramProvider,
  threads: threadsProvider,
  linkedin: linkedinProvider,
  x: xProvider,
  tiktok: tiktokProvider,
  bluesky: blueskyProvider,
  mastodon: mastodonProvider,
  pinterest: pinterestProvider,
  reddit: redditProvider,
  dribbble: dribbbleProvider,
  youtube: youtubeProvider,
};

export function providerFor(platform: SocialPlatform): SocialProviderImpl {
  const impl = REGISTRY[platform];
  if (!impl) throw new Error(`No provider for platform: ${platform}`);
  return impl;
}

export function isSupportedPlatform(value: string): value is SocialPlatform {
  return value in REGISTRY;
}

/** Platforms that connect via user-supplied credentials instead of OAuth. */
export function isCredentialConnect(platform: SocialPlatform): boolean {
  return platform === "bluesky";
}

/** Platforms that need a stateful start() (OAuth1 / dynamic client registration). */
export function needsStartFlow(platform: SocialPlatform): boolean {
  return platform === "x" || platform === "mastodon";
}
