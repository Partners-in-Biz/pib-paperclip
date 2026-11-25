/**
 * Idempotent create-preview (PAR-10301): the same request made twice (an agent retrying after a gateway timeout) gets the
 * preview the first call made, not a second row, review issue and Drive copy. The key is a hash of everything that shapes
 * the preview; the in-flight and stored lookups in service/preview.ts use it.
 */
import { createHash } from "node:crypto";

/**
 * The create-preview tool's declared gateway budget: source fetch, render (starts by 12 s, ends by 15 s), reads, the insert
 * and routing. A slower site can pass it: the worker still finishes, and a retry gets the stored preview (`reused: true`).
 */
export const CREATE_PREVIEW_TOOL_TIMEOUT_MS = 45_000;
/** An identical call waits for a running one only this long; an older entry is treated as hung and dropped. */
export const IN_FLIGHT_MAX_MS = 50_000;
/** A stored preview is reused for an identical call made within this many minutes of it. */
export const REUSE_WINDOW_MINUTES = 30;
/** On a stored hit the page source is fetched again (no render) to see whether the page changed, for at most this long. */
export const REUSE_RECHECK_MS = 10_000;

/** JSON with object keys sorted at every level and undefined values dropped, so equal values always give the same text. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "null";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : sortKeys(v)));
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export interface PreviewRequest {
  companyId: string;
  sprintId: string;
  pageUrl: string;
  taskId: string | null;
  changes: unknown;
  allowReplace: boolean;
  label: string | undefined;
  client: unknown;
  rubric: unknown;
}

/** sha256 (hex) of the request's stable JSON. */
export function previewRequestKey(request: PreviewRequest): string {
  return createHash("sha256").update(stableStringify(request)).digest("hex");
}
