/**
 * Save to Drive (PAR-8106, slice 1): copy a library file into its client's Drive `02 Assets` through the CRM's
 * save route. R2 stays the master; the Drive copy is recorded on the asset as a `drive_file` link (the Drive file id).
 * People only: agents get no Drive links or tokens. The client comes from the asset row, never from the caller, so a
 * client's file only lands in that client's folder (own work goes to the company's own project).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { DRIVE_ACK_TIMEOUT_MS, driveSave as kitDriveSave, scopeOfRow, type DriveSaveOptions, type DriveSaveResult, type DriveTransferProgress } from "@partnersinbiz/pib-plugin-kit";
import { addLink, getAssetRow } from "./assets.js";
import { StudioConfig } from "./config.js";
import { iso, num, table } from "./db.js";
import { StudioError } from "./errors.js";
import { assertOwnKey, extFor, getObject, objectUrl } from "./storage.js";
import { startTransfer, type TransferView } from "./drive-jobs.js";
import { DRIVE_INLINE_MAX_BYTES, DRIVE_MAX_BYTES } from "./drive-limits.js";

// The limit is checked here first, before reading from R2, for a clear message.
export { DRIVE_INLINE_MAX_BYTES, DRIVE_MAX_BYTES };
export const DRIVE_LINK_TYPE = "drive_file";
// Under the tool gateway's ~10 s cut (PAR-10208), so people and agents get the plain message instead of a bare 504.
export const DRIVE_TIMEOUT_MS = DRIVE_ACK_TIMEOUT_MS;
/** A large transfer: the longest wait between two progress replies (the CRM sends one per 8 MiB chunk). */
export const TRANSFER_IDLE_MS = 60_000;
/** Signed R2 links for a large transfer: long enough for 200 MB on a slow line, short enough to be worthless later. */
export const TRANSFER_LINK_SEC = 15 * 60;

export type DriveSaveFn = (ctx: Pick<PluginContext, "events">, opts: DriveSaveOptions) => Promise<DriveSaveResult>;

export interface DriveCopy {
  fileId: string;
  url: string;
  savedAt: string | null;
}

/** Drive file ids are URL-safe; anything else is not a Drive id and gets no link. */
export function driveFileUrl(fileId: string): string | null {
  return /^[A-Za-z0-9_-]{10,200}$/.test(fileId) ? `https://drive.google.com/file/d/${fileId}/view` : null;
}

function cleanPart(part: string): string {
  return part.replace(/[\/\\]/g, "-").replace(/[\x00-\x1f\x7f]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
}

/**
 * The CRM's file-name convention `YYYY-MM-DD <name> vN.ext`. The date is the asset's, not today's, so saving the same
 * version twice gives the same name and the CRM dedupes it instead of making a second file.
 */
export function driveFileName(a: { id: string; name: string; createdAt: string | null; version: number; mime: string }): string {
  const day = (a.createdAt ?? new Date().toISOString()).slice(0, 10);
  return `${day} ${cleanPart(a.name) || "asset"} ${a.id.replace(/-/g, "").slice(0, 8)} v${a.version}.${extFor(a.mime)}`;
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Plain words for a refusal from the kit, the CRM or Google. */
export function refusalText(result: Exclude<DriveSaveResult, { status: "saved" }>): string {
  if (result.status === "no_ack") return `CRM didn't answer within ${DRIVE_TIMEOUT_MS / 1000} seconds, so the file may not be in Drive. Check that the CRM plugin is running, then try again. A retry does not make a second copy.`;
  // A hint can echo a thrown message; a signed link (or any URL) must never reach a page or an agent (PAR-9264).
  const hint = result.hint ? ` (${result.hint.replace(/https?:\/\/\S+/gi, "[link removed]")})` : "";
  switch (result.reason) {
    case "too_large":
      return `Drive transfers take files up to ${mb(DRIVE_MAX_BYTES)}, the largest file Studio keeps. Download the file and add it to Drive by hand.`;
    case "sha256_mismatch":
      return "The file changed while it was being copied, so Drive kept nothing. Try again.";
    case "no_project":
      return `This client has no Drive project in CRM yet, so there is no folder to save to. Set up the client's Drive folder in CRM first.${hint}`;
    case "drive_not_bound":
    case "not_bound":
      return `This company has no Shared Drive bound in CRM, so nothing can be saved to Drive.${hint}`;
    case "broker_error":
      return `Google Drive refused the save${hint}.`;
    default:
      return `Drive refused the save: ${result.reason}${hint}.`;
  }
}

export async function driveCopies(ctx: PluginContext, companyId: string, assetId: string): Promise<DriveCopy[]> {
  const rows = await ctx.db.query<{ target_id: string; created_at: unknown }>(
    `SELECT target_id, created_at FROM ${table(ctx, "asset_links")} WHERE company_id = $1 AND asset_id = $2 AND target_type = $3 ORDER BY created_at DESC`,
    [companyId, assetId, DRIVE_LINK_TYPE],
  );
  return rows.flatMap((r) => {
    const url = driveFileUrl(r.target_id);
    return url ? [{ fileId: r.target_id, url, savedAt: iso(r.created_at) }] : [];
  });
}

/**
 * Two people saving at once both reach the CRM; it and the broker dedupe on folder + name + sha256, so both get the
 * same file id and the link insert is idempotent.
 */
export async function saveAssetToDrive(ctx: PluginContext, companyId: string, assetId: string, save: DriveSaveFn = kitDriveSave): Promise<DriveCopy | TransferView> {
  if (!assetId) throw new StudioError("assetId is required.", "bad_request");
  const row = await getAssetRow(ctx, companyId, assetId);
  const size = num(row.bytes);
  if (size > DRIVE_MAX_BYTES) {
    throw new StudioError(`This file is ${mb(size)}. Drive transfers take files up to ${mb(DRIVE_MAX_BYTES)}, the largest file Studio keeps. Download it and add it to Drive by hand.`, "too_large");
  }
  assertOwnKey(companyId, row.r2_key);
  const bucket = await new StudioConfig(ctx, companyId).bucket();
  const scope = scopeOfRow(row);
  const base = {
    companyId,
    kind: "marketing",
    name: driveFileName({ id: row.id, name: row.name, createdAt: iso(row.created_at), version: num(row.current_version), mime: row.mime }),
    mimeType: row.mime,
    subfolder: "02 Assets" as const,
    // An asset with no client is the company's own; the CRM files it in the own folder only when told so (PAR-8128).
    ...(scope ? { client: { kind: scope.kind, ref: scope.id } } : { ownWork: true as const }),
  };
  const record = async (result: DriveSaveResult): Promise<DriveCopy> => {
    if (result.status !== "saved") throw new StudioError(refusalText(result), "drive_refused");
    const url = driveFileUrl(result.driveFileId);
    if (!url) throw new StudioError("Drive answered without a usable file id, so the save could not be recorded.", "drive_refused");
    await addLink(ctx, companyId, row.id, DRIVE_LINK_TYPE, result.driveFileId);
    return { fileId: result.driveFileId, url, savedAt: new Date().toISOString() };
  };

  // Up to 5 MiB: the same event path as before, answered within this action.
  if (size <= DRIVE_INLINE_MAX_BYTES) {
    const bytes = await getObject(bucket, companyId, row.r2_key);
    return record(await save(ctx, { ...base, bytes, timeoutMs: DRIVE_TIMEOUT_MS }));
  }

  // Bigger (PAR-8125): a background transfer. The CRM streams the object from a signed R2 GET link to Google, checking
  // it against the stored sha256. The link goes only into the CRM event: never into the result, an error or a log.
  const versions = await ctx.db.query<{ sha256: string | null }>(
    `SELECT sha256 FROM ${table(ctx, "asset_versions")} WHERE company_id = $1 AND asset_id = $2 AND r2_key = $3`,
    [companyId, row.id, row.r2_key],
  );
  const sha256 = versions[0]?.sha256;
  if (!sha256) throw new StudioError("Studio has no checksum for this file, so it can't check the Drive copy. Download it and add it to Drive by hand.", "drive_refused");
  return startTransfer(companyId, "save", `save:${row.id}:${row.r2_key}`, size, async (progress) => {
    const r2Url = objectUrl(bucket, companyId, "GET", row.r2_key, TRANSFER_LINK_SEC);
    const result = await save(ctx, { ...base, r2Url, size, sha256, timeoutMs: TRANSFER_IDLE_MS, onProgress: (p: DriveTransferProgress) => progress(p.bytesDone, p.bytesTotal) });
    return record(result);
  });
}
