/** Small helpers shared by providers. */
import type { MediaRef } from "../../db.js";
import { PublishRejected, ProviderHttpError } from "../http.js";
import type { PublishOutcome } from "../types.js";

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
