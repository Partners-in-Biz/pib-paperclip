/**
 * Read a producer's file from R2 in chunks (PAR-8125), for the Drive resumable upload. The worker holds one chunk at a
 * time, never the whole file.
 *
 * The link is a signed R2 GET from the producer. It is fetched with native fetch (the host's `ctx.http.fetch` turns a
 * binary body into a string), so the SSRF guard is here: https, R2 hosts only, no redirects. The link is a secret:
 * no error, log line or reply carries it.
 */
import { isR2ObjectUrl } from "@partnersinbiz/pib-plugin-kit";

/** 8 MiB: Google wants every chunk but the last to be a multiple of 256 KiB. */
export const CHUNK_BYTES = 8 * 1024 * 1024;
/** The whole read, for a 200 MiB file on a slow link. */
const READ_TIMEOUT_MS = 30 * 60 * 1000;

export class R2StreamError extends Error {
  constructor(message: string, readonly code: "not_r2" | "fetch_failed" | "size_mismatch") {
    super(message);
    this.name = "R2StreamError";
  }
}

export type R2Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * The file's bytes in chunks of `chunkBytes` (the last one shorter). Refuses a link that is not R2, a body that is not
 * exactly `size` bytes, and a redirect.
 */
export async function* r2Chunks(url: string, size: number, opts: { fetchFn?: R2Fetch; chunkBytes?: number } = {}): AsyncGenerator<Uint8Array> {
  if (!isR2ObjectUrl(url)) throw new R2StreamError("The storage link is not a Cloudflare R2 link, so it was not opened.", "not_r2");
  const chunkBytes = opts.chunkBytes ?? CHUNK_BYTES;
  const fetchFn: R2Fetch = opts.fetchFn ?? ((u, init) => fetch(u, init));

  let res: Response;
  try {
    res = await fetchFn(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
  } catch {
    // The error text may echo the link: never pass it on.
    throw new R2StreamError("Could not read the file from storage (network error).", "fetch_failed");
  }
  if (res.status !== 200 || !res.body) {
    await res.body?.cancel().catch(() => undefined);
    throw new R2StreamError(`Could not read the file from storage (HTTP ${res.status}). The link may have expired; try again.`, "fetch_failed");
  }
  const declared = res.headers?.get?.("content-length");
  if (declared !== null && declared !== undefined && declared !== "" && Number(declared) !== size) {
    await res.body.cancel().catch(() => undefined);
    throw new R2StreamError(`The file in storage is ${declared} bytes, not the ${size} bytes asked for.`, "size_mismatch");
  }

  const reader = res.body.getReader();
  let buf = new Uint8Array(chunkBytes);
  let fill = 0;
  let total = 0;
  try {
    for (;;) {
      let part: ReadableStreamReadResult<Uint8Array>;
      try {
        part = await reader.read();
      } catch {
        throw new R2StreamError("Reading the file from storage stopped part-way. Try again.", "fetch_failed");
      }
      if (part.done) break;
      let piece = part.value;
      total += piece.byteLength;
      if (total > size) throw new R2StreamError(`The file in storage is bigger than the ${size} bytes asked for.`, "size_mismatch");
      while (piece.byteLength > 0) {
        const take = Math.min(chunkBytes - fill, piece.byteLength);
        buf.set(piece.subarray(0, take), fill);
        fill += take;
        piece = piece.subarray(take);
        if (fill === chunkBytes) {
          yield buf;
          buf = new Uint8Array(chunkBytes);
          fill = 0;
        }
      }
    }
    if (total !== size) throw new R2StreamError(`The file in storage is ${total} bytes, not the ${size} bytes asked for.`, "size_mismatch");
    if (fill > 0) yield buf.subarray(0, fill);
  } finally {
    reader.releaseLock();
    if (total < size) await res.body.cancel().catch(() => undefined);
  }
}
