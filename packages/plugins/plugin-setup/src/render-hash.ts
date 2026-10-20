import { createHash } from "node:crypto";

/**
 * Computes a stable hash of rendered template text (pack v2 determinism).
 * @param rendered the AGENTS.md text
 * @returns the first 16 hex chars of the sha256 hash
 */
export function renderHash(rendered: string): string {
  return createHash("sha256").update(rendered, "utf8").digest("hex").substring(0, 16);
}
