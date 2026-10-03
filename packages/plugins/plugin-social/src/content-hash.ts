/**
 * A fingerprint of what a post will publish: its text, first comment, overrides,
 * media, destination accounts and proposed time. A sign-off belongs to one
 * fingerprint, so editing a post after it was checked or approved makes the
 * earlier sign-off stale (the Reviewer, the owner or the client sees what they
 * approve, and approval never covers a later edit).
 */
import { createHash } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { destinationsForPost, iso, postMedia, postOverrides, type PostRow } from "./db.js";

/** JSON with sorted keys, so the same content always gives the same text. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The fingerprint of a post and its destination accounts. Pure. */
export function contentHashOf(post: Pick<PostRow, "body" | "first_comment" | "overrides" | "media" | "scheduled_at">, accountIds: string[]): string {
  return sha256Hex(
    stableJson({
      body: post.body.trim(),
      firstComment: post.first_comment?.trim() || null,
      overrides: postOverrides(post),
      media: postMedia(post).map((m) => ({ url: m.url, kind: m.kind, altText: m.altText ?? null })),
      accounts: Array.from(new Set(accountIds)).sort(),
      scheduledAt: iso(post.scheduled_at),
    }),
  );
}

/** The post's current fingerprint and its destination account ids. */
export async function postFingerprint(ctx: PluginContext, post: PostRow): Promise<{ hash: string; accountIds: string[] }> {
  const accountIds = (await destinationsForPost(ctx, post.id)).map((d) => d.account_id);
  return { hash: contentHashOf(post, accountIds), accountIds };
}
