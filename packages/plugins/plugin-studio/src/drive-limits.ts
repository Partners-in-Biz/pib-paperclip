/**
 * Shared by the worker and the page (no Node imports here). Files up to DRIVE_INLINE_MAX_BYTES ride in the Drive event as
 * before (kit `drive.ts`); bigger ones stream through a short-lived signed R2 link as a background transfer (PAR-8125).
 */
export const DRIVE_INLINE_MAX_BYTES = 5 * 1024 * 1024;
/**
 * The largest Drive save or import: Studio's own MAX_ASSET_BYTES (`storage.ts`) and the kit's DRIVE_TRANSFER_MAX_BYTES.
 * Studio keeps nothing bigger, so a smaller cap would only refuse files Studio already holds.
 */
export const DRIVE_MAX_BYTES = 200 * 1024 * 1024;
