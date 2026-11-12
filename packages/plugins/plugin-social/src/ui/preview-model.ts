/**
 * What a post looks like on one platform: the text that platform gets (its override, else the main post), where the
 * feed cuts it with "more", and what the platform would refuse. Pure, so the page and the specs share it.
 */
import { PLATFORM_LABELS, PLATFORM_LIMITS, isSocialPlatform, type PlatformOverride, type SocialPlatform } from "../platforms.js";

export type PreviewLayout = "feed" | "micro" | "instagram" | "vertical" | "video" | "pin";

/** The look each platform's mock-up uses. */
export const PREVIEW_LAYOUT: Record<SocialPlatform, PreviewLayout> = {
  facebook: "feed",
  linkedin: "feed",
  reddit: "feed",
  dribbble: "feed",
  x: "micro",
  threads: "micro",
  bluesky: "micro",
  mastodon: "micro",
  instagram: "instagram",
  tiktok: "vertical",
  youtube: "video",
  pinterest: "pin",
};

/** Characters a feed shows before "more" (about what each app shows on a phone); 0 = never cut. */
export const FOLD_AT: Record<SocialPlatform, number> = {
  facebook: 480,
  linkedin: 210,
  reddit: 600,
  dribbble: 300,
  x: 0,
  threads: 0,
  bluesky: 0,
  mastodon: 0,
  instagram: 125,
  tiktok: 90,
  youtube: 160,
  pinterest: 100,
};

export interface PreviewSource {
  body: string;
  firstComment?: string | null;
  overrides?: Partial<Record<SocialPlatform, PlatformOverride>>;
  media: Array<{ url: string; kind: string; altText?: string | null }>;
}

export interface PreviewModel {
  platform: SocialPlatform | null;
  label: string;
  layout: PreviewLayout;
  text: string;
  title: string | null;
  link: string | null;
  subreddit: string | null;
  firstComment: string | null;
  /** Media in the order and number the platform takes. */
  media: PreviewSource["media"];
  /** Characters of `text` (by code point, as the platforms count). */
  length: number;
  maxText: number | null;
  /** What the platform would refuse, in plain words. */
  problems: string[];
}

const clean = (value: string | null | undefined): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

export function previewModel(source: PreviewSource, platform: string | null | undefined): PreviewModel {
  const known = platform && isSocialPlatform(platform) ? platform : null;
  const override = known ? source.overrides?.[known] : undefined;
  const text = clean(override?.text) ?? source.body;
  const length = Array.from(text).length;
  const limits = known ? PLATFORM_LIMITS[known] : null;
  const problems: string[] = [];
  const label = known ? PLATFORM_LABELS[known] : platform || "This account";
  if (limits && length > limits.maxText) problems.push(`${length - limits.maxText} characters over ${label}'s limit of ${limits.maxText}.`);
  const images = source.media.filter((m) => m.kind !== "video").length;
  const videos = source.media.length - images;
  if (limits?.needsMedia === "any" && source.media.length === 0) problems.push(`${label} needs an image or video.`);
  if (limits?.needsMedia === "image" && images === 0) problems.push(`${label} needs an image.`);
  if (limits?.needsMedia === "video" && videos === 0) problems.push(`${label} needs a video.`);
  if (limits && source.media.length > limits.maxMedia) problems.push(`${label} takes ${limits.maxMedia} media item${limits.maxMedia === 1 ? "" : "s"}; this post has ${source.media.length}.`);
  if (limits && !limits.video && videos > 0) problems.push(`${label} does not take video here.`);
  return {
    platform: known,
    label,
    layout: known ? PREVIEW_LAYOUT[known] : "feed",
    text,
    title: clean(override?.title),
    link: clean(override?.link),
    subreddit: clean(override?.subreddit),
    firstComment: clean(source.firstComment),
    media: limits ? source.media.slice(0, limits.maxMedia) : source.media,
    length,
    maxText: limits?.maxText ?? null,
    problems,
  };
}

/** The part of `text` a feed shows before "more". Cuts at a word where it can; `cut` is false when all of it shows. */
export function foldText(text: string, platform: SocialPlatform | null): { shown: string; cut: boolean } {
  const at = platform ? FOLD_AT[platform] : 300;
  const chars = Array.from(text);
  // A feed also folds after a few lines, whatever the length.
  const lines = text.split("\n");
  const maxLines = at === 0 ? Infinity : platform === "instagram" || platform === "tiktok" ? 2 : 5;
  if ((at === 0 || chars.length <= at) && lines.length <= maxLines) return { shown: text, cut: false };
  let shown = lines.slice(0, maxLines).join("\n");
  if (at > 0 && Array.from(shown).length > at) {
    shown = Array.from(shown).slice(0, at).join("");
    const space = shown.lastIndexOf(" ");
    if (space > at * 0.6) shown = shown.slice(0, space);
  }
  return { shown: shown.trimEnd(), cut: true };
}

export type TextPart = { kind: "text" | "tag" | "link"; value: string };

/** Splits post text into plain text, #tags / @mentions, and links, so the mock-up can colour them as the platform does. */
export function textParts(text: string): TextPart[] {
  const parts: TextPart[] = [];
  const pattern = /(https?:\/\/[^\s]+)|((?<![\w/])[#@][\p{L}\p{N}_]+)/gu;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ kind: "text", value: text.slice(last, index) });
    parts.push({ kind: match[1] ? "link" : "tag", value: match[0] });
    last = index + match[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", value: text.slice(last) });
  return parts;
}

/** "@handle" for a handle saved with or without the @ or as a profile link; null when there is none. */
export function atHandle(handle: string | null | undefined): string | null {
  const raw = clean(handle);
  if (!raw) return null;
  const last = raw.replace(/\/+$/, "").split("/").pop() ?? raw;
  const name = last.replace(/^@/, "");
  return name ? `@${name}` : null;
}
