/** How the page reads an "asset-urls" reply (PAR-8102). No React here, so tests can load it. */

/** Links last five minutes; renew them before they expire. */
export const URL_REFRESH_MS = 4 * 60 * 1000;
/** After a failure, try again this soon (the host's secret limit is per minute). */
export const URL_RETRY_MS = 20 * 1000;

export interface PreviewState {
  urls: Record<string, string>;
  /** Safe to show a person; null while loading or when every link came back. */
  error: string | null;
}

interface AssetUrlsReply {
  urls?: Record<string, string>;
  failed?: string[];
  error?: string | null;
}

/** What one reply means for the page, and when to ask again. */
export function previewReply(out: unknown): PreviewState & { retryInMs: number } {
  const reply = (out ?? {}) as AssetUrlsReply;
  const error = reply.error || (reply.failed?.length ? "Some previews couldn't load." : null);
  return { urls: reply.urls ?? {}, error: error ?? null, retryInMs: error ? URL_RETRY_MS : URL_REFRESH_MS };
}

/** The text a card shows while it has no link. */
export function previewPlaceholder(error: string | null): string {
  return error ? "Preview didn't load. Trying again…" : "Loading preview…";
}
