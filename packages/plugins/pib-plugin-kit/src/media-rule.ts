/**
 * The media rule (pure). A playbook can carry one fenced `media-rule` block; the rubric reads it to say whether a post needs
 * an image or video and whether every one has alt text. `enforce: advise` turns a miss into a warning, `enforce: block` into a blocker.
 *
 * A post may skip media only inside a running media experiment (the `no_media` arm), up to `minPerArm` posts.
 */
import type { CreativePlatform } from "./creative-rubric.js";

export type MediaEnforce = "advise" | "block";

export interface MediaRule {
  enforce: MediaEnforce;
  /** Platforms where a post needs an image or a video. X is text-first, so it is not listed. */
  mediaPlatforms: CreativePlatform[];
  /** A video longer than this many seconds does not count as the post's media. */
  maxVideoSeconds: number;
  /** Post kinds that carry the message in text and so need no media. */
  textNative: string[];
  altTextRequired: boolean;
}

export const DEFAULT_MEDIA_RULE: MediaRule = {
  enforce: "advise",
  mediaPlatforms: ["linkedin", "instagram", "facebook"],
  maxVideoSeconds: 30,
  textNative: ["question", "thread", "quote"],
  altTextRequired: true,
};

const BLOCK = /```media-rule[^\S\n]*\n([\s\S]*?)```/i;

/** Reads the first fenced `media-rule` block. No block, or an unreadable value, keeps the default for that field. */
export function parseMediaRule(playbook: string | null | undefined): MediaRule {
  const rule: MediaRule = { ...DEFAULT_MEDIA_RULE, mediaPlatforms: [...DEFAULT_MEDIA_RULE.mediaPlatforms], textNative: [...DEFAULT_MEDIA_RULE.textNative] };
  const body = BLOCK.exec(playbook ?? "")?.[1];
  if (!body) return rule;
  for (const raw of body.split("\n")) {
    const m = /^\s*([a-z_]+)\s*:\s*(.*?)\s*$/i.exec(raw);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.toLowerCase();
    if (key === "enforce" && (value === "advise" || value === "block")) rule.enforce = value;
  }
  return rule;
}

/** True when this post needs an image or a video under the rule. */
export function postNeedsMedia(rule: MediaRule, platform: CreativePlatform, textNative: boolean): boolean {
  return rule.mediaPlatforms.includes(platform) && !textNative;
}

export interface MediaExperiment {
  id: string;
  status: string;
  hypothesisType: string;
  minPerArm: number;
  /** Posts in this experiment on the `no_media` arm, counting the post being checked. */
  noMediaPosts: number;
}

/** Only a running media experiment, a matching `experimentId`, the `no_media` arm and room under `minPerArm` exempt a post. */
export function noMediaExempt(post: { experimentId?: string | null; arm?: string | null }, experiment: MediaExperiment | null | undefined): boolean {
  if (!post.experimentId || !experiment || experiment.id !== post.experimentId) return false;
  return experiment.status === "running" && experiment.hypothesisType === "media" && post.arm === "no_media" && experiment.noMediaPosts <= experiment.minPerArm;
}
