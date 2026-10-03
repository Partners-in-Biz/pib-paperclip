import { createHash } from "node:crypto";

/**
 * The one-way hash an erased person's do-not-email marker keeps instead of the
 * address: SHA-256 of the kit's subject key (`email:<address>`), the same as the
 * CRM's erasure ledger keeps as `subjectHash`, so the two can be matched without
 * either holding the address.
 */
export function erasureHash(email: string): string {
  return createHash("sha256").update(`email:${email.trim().toLowerCase()}`).digest("hex");
}

/** The marker row's `email` column (a primary key part): not an address, so it can never collide with one. */
export function markerEmail(hash: string): string {
  return `erased:${hash}`;
}
