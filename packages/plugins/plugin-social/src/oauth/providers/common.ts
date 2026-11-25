/** Small helpers shared by providers. */
import type { MediaRef } from "../../db.js";
import { PublishRejected, ProviderHttpError } from "../http.js";
import type { InboxCandidate, InboxSkip, PublishOutcome } from "../types.js";

export function requireCode(params: Record<string, string>, label: string): string {
  if (params.error) throw new Error(params.error_description || params.error_message || params.error);
  const code = params.code;
  if (!code) throw new Error(`${label} did not return an authorization code`);
  return code;
}

export function images(media: MediaRef[]): MediaRef[] {
  return media.filter((m) => m.kind === "image");
}

export function videos(media: MediaRef[]): MediaRef[] {
  return media.filter((m) => m.kind === "video");
}

/** Append a link to the text when the platform has no link field for this post type. */
export function withLink(text: string, link: string | undefined): string {
  if (!link || text.includes(link)) return text;
  return text ? `${text}\n\n${link}` : link;
}

/** Turn a thrown error into a publish outcome with the right retry flags. */
export function failure(error: unknown): PublishOutcome {
  if (error instanceof PublishRejected) return { ok: false, error: error.message, retryable: false };
  if (error instanceof ProviderHttpError) {
    return { ok: false, error: error.message, retryable: error.retryable, tokenInvalid: error.tokenInvalid };
  }
  const message = error instanceof Error ? error.message : String(error);
  // Network failures (fetch TypeError, aborts) are worth another attempt.
  return { ok: false, error: message, retryable: true };
}

/** Run a publish body and convert thrown errors to outcomes. */
export async function guard(run: () => Promise<PublishOutcome>): Promise<PublishOutcome> {
  try {
    return await run();
  } catch (error) {
    return failure(error);
  }
}

/** Best-effort follow-up (first comment): never fails the publish. */
export async function bestEffort<T>(run: () => Promise<T>): Promise<{ value?: T; error?: string }> {
  try {
    return { value: await run() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function count(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

export function optionalCount(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Quota and rate-limit answers come back as 403 on YouTube; they are account-wide, so they are never skipped per post. */
const ACCOUNT_LIMIT = /quotaExceeded|rateLimitExceeded|dailyLimitExceeded|userRateLimitExceeded/i;

/**
 * True when a per-post read failed for a reason only that post can cause: comments switched off, a private
 * or deleted video or post (HTTP 400/403/404). An invalid token, a rate limit, a quota or a server error is
 * account-wide or worth a retry, so it is not skippable.
 */
export function skippablePostError(error: unknown): error is ProviderHttpError {
  if (!(error instanceof ProviderHttpError)) return false;
  if (error.tokenInvalid || error.retryable || ACCOUNT_LIMIT.test(error.body)) return false;
  return error.status === 400 || error.status === 403 || error.status === 404;
}

/**
 * Read the inbox one post at a time. A post that fails in a skippable way is left out and reported through
 * `onSkip`; any other error stops the read as before. When every post failed, the first error is thrown, so
 * an account-wide problem (a missing permission answers 403 on every post) still fails the account's poll.
 */
export async function perPostInbox(
  published: Array<{ externalId: string }>,
  read: (externalId: string) => Promise<InboxCandidate[]>,
  onSkip?: InboxSkip,
): Promise<InboxCandidate[]> {
  const out: InboxCandidate[] = [];
  const skipped: Array<{ externalId: string; error: ProviderHttpError }> = [];
  for (const post of published) {
    try {
      out.push(...(await read(post.externalId)));
    } catch (error) {
      if (!skippablePostError(error)) throw error;
      skipped.push({ externalId: post.externalId, error });
    }
  }
  if (skipped.length > 0 && skipped.length === published.length) throw skipped[0]!.error;
  for (const s of skipped) onSkip?.(s.externalId, s.error.message);
  return out;
}
