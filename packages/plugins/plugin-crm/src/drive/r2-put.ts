/**
 * Write a Drive file into R2 as a stream (PAR-8125), for a large read. The bytes go from Google's response straight
 * into one PUT on the producer's signed R2 link, so the worker holds only the pieces in flight, never the whole file.
 *
 * Same guard as `r2Chunks`: native fetch, https R2 hosts only, no redirects. R2 wants a Content-Length on a signed PUT,
 * so the size is sent up front and the body is counted on the way: a body longer or shorter than that fails the PUT,
 * and R2 keeps nothing of a failed PUT. The link is a secret: no error, log line or reply carries it.
 */
import { createHash } from "node:crypto";
import { isR2ObjectUrl } from "@partnersinbiz/pib-plugin-kit";
import { CHUNK_BYTES, R2StreamError, type R2Fetch } from "./r2-stream.js";

/** The whole write, for a 200 MiB file on a slow link. */
const WRITE_TIMEOUT_MS = 30 * 60 * 1000;

export interface PutToR2Options {
  mimeType?: string;
  fetchFn?: R2Fetch;
  /** Bytes written so far, about every `progressBytes` (8 MiB) and once at the end. */
  onProgress?: (bytesDone: number) => void | Promise<void>;
  progressBytes?: number;
}

/** Streams `source` (exactly `size` bytes) to the signed PUT link and returns the sha256 of what was written. */
export async function putToR2(url: string, size: number, source: ReadableStream<Uint8Array>, opts: PutToR2Options = {}): Promise<{ sha256: string }> {
  if (!isR2ObjectUrl(url)) {
    await source.cancel().catch(() => undefined);
    throw new R2StreamError("The storage link is not a Cloudflare R2 link, so nothing was written.", "not_r2");
  }
  if (!Number.isInteger(size) || size <= 0) {
    await source.cancel().catch(() => undefined);
    throw new R2StreamError("The file has no size, so it can't be copied.", "size_mismatch");
  }
  const fetchFn: R2Fetch = opts.fetchFn ?? ((u, init) => fetch(u, init));
  const step = opts.progressBytes ?? CHUNK_BYTES;
  const hash = createHash("sha256");
  let done = 0;
  let reported = 0;

  const counted = source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      async transform(piece, controller) {
        done += piece.byteLength;
        if (done > size) throw new R2StreamError(`Drive sent more than the ${size} bytes it lists for this file.`, "size_mismatch");
        hash.update(piece);
        controller.enqueue(piece);
        if (opts.onProgress && done < size && done - reported >= step) {
          reported = done;
          await Promise.resolve(opts.onProgress(done)).catch(() => undefined);
        }
      },
    }),
  );

  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "PUT",
      body: counted,
      duplex: "half",
      redirect: "error",
      headers: { "content-length": String(size), "content-type": opts.mimeType || "application/octet-stream" },
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    } as RequestInit);
  } catch {
    // The error text may echo the link: never pass it on.
    if (done !== size) throw new R2StreamError(`Copying to storage stopped after ${done} of ${size} bytes. Try again.`, done > size ? "size_mismatch" : "fetch_failed");
    throw new R2StreamError("Could not write the file to storage (network error).", "fetch_failed");
  }
  await res.body?.cancel().catch(() => undefined);
  if (res.status < 200 || res.status >= 300) {
    throw new R2StreamError(`Could not write the file to storage (HTTP ${res.status}). The link may have expired; try again.`, "fetch_failed");
  }
  if (done !== size) throw new R2StreamError(`Drive sent ${done} bytes, not the ${size} bytes it lists for this file.`, "size_mismatch");
  if (opts.onProgress) await Promise.resolve(opts.onProgress(size)).catch(() => undefined);
  return { sha256: hash.digest("hex") };
}
