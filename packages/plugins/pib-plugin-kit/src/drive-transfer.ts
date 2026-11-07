/**
 * Large Drive transfers (PAR-8125). Files up to 5 MiB still travel inside the event as base64. A bigger file never
 * rides in an event: the producer hands the CRM a short-lived signed R2 link and the CRM streams it, one chunk at a
 * time, to a Google resumable upload. So no worker holds the whole file.
 *
 * The signed link is a secret between two plugins: never return it to an agent, never put it in a log, a reply or an
 * error. `redactR2Url` is what may be shown instead.
 */

/** Files up to this size go inline in the event, as before. */
export const DRIVE_INLINE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * The largest file a Drive transfer takes: 200 MiB, the same as Studio's own MAX_ASSET_BYTES. Studio cannot hold a
 * bigger file, so a smaller cap would only refuse files Studio already has, and a bigger one has nothing to serve.
 */
export const DRIVE_TRANSFER_MAX_BYTES = 200 * 1024 * 1024;

/** Only Cloudflare R2's S3 endpoint (`<account>.r2.cloudflarestorage.com`, or its `eu` / `fedramp` jurisdictions). */
const R2_HOST = /^[a-z0-9][a-z0-9-]{0,62}(\.(eu|fedramp))?\.r2\.cloudflarestorage\.com$/;

/**
 * True for an https link to an R2 object, and nothing else: no other host, no port, no user info. This is the SSRF
 * guard for the CRM, which fetches the link with its own network access.
 */
export function isR2ObjectUrl(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 4096) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  if (!R2_HOST.test(url.hostname)) return false;
  return url.pathname.length > 1;
}

/** What may be shown of a signed link: scheme and host only. */
export function redactR2Url(raw: string): string {
  try {
    return `https://${new URL(raw).hostname}/…`;
  } catch {
    return "(link)";
  }
}

/** A sha256 in hex, as the CRM dedupes on. */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}
