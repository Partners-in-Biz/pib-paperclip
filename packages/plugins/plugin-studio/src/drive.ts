/**
 * Save to Drive (PAR-8106, slice 1): copy a library file into its client's Drive `02 Assets` through the CRM's
 * save route. R2 stays the master; the Drive copy is recorded on the asset as a `drive_file` link (the Drive file id).
 * People only: agents get no Drive links or tokens. The client comes from the asset row, never from the caller, so a
 * client's file only lands in that client's folder (own work goes to the company's own project).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { driveSave as kitDriveSave, scopeOfRow, type DriveSaveOptions, type DriveSaveResult } from "@partnersinbiz/pib-plugin-kit";
import { addLink, getAssetRow } from "./assets.js";
import { StudioConfig } from "./config.js";
import { iso, num, table } from "./db.js";
import { StudioError } from "./errors.js";
import { assertOwnKey, extFor, getObject } from "./storage.js";

import { DRIVE_MAX_BYTES } from "./drive-limits.js";

// The broker's limit is checked here first, before reading from R2, for a clear message.
export { DRIVE_MAX_BYTES };
export const DRIVE_LINK_TYPE = "drive_file";
const TIMEOUT_MS = 30_000;

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
  if (result.status === "no_ack") return "CRM didn't answer within 30 seconds, so the file may not be in Drive. Check that the CRM plugin is running, then try again.";
  const hint = result.hint ? ` (${result.hint})` : "";
  switch (result.reason) {
    case "too_large":
      return `Drive saves take files up to ${mb(DRIVE_MAX_BYTES)} for now. Download the file and add it to Drive by hand.`;
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
export async function saveAssetToDrive(ctx: PluginContext, companyId: string, assetId: string, save: DriveSaveFn = kitDriveSave): Promise<DriveCopy> {
  if (!assetId) throw new StudioError("assetId is required.", "bad_request");
  const row = await getAssetRow(ctx, companyId, assetId);
  const size = num(row.bytes);
  if (size > DRIVE_MAX_BYTES) {
    throw new StudioError(`This file is ${mb(size)} and Drive saves take files up to ${mb(DRIVE_MAX_BYTES)} for now. Download it and add it to Drive by hand.`, "too_large");
  }
  assertOwnKey(companyId, row.r2_key);
  const bytes = await getObject(await new StudioConfig(ctx, companyId).bucket(), companyId, row.r2_key);
  const scope = scopeOfRow(row);
  const result = await save(ctx, {
    companyId,
    kind: "marketing",
    name: driveFileName({ id: row.id, name: row.name, createdAt: iso(row.created_at), version: num(row.current_version), mime: row.mime }),
    mimeType: row.mime,
    bytes,
    subfolder: "02 Assets",
    timeoutMs: TIMEOUT_MS,
    ...(scope ? { client: { kind: scope.kind, ref: scope.id } } : {}),
  });
  if (result.status !== "saved") throw new StudioError(refusalText(result), "drive_refused");
  const url = driveFileUrl(result.driveFileId);
  if (!url) throw new StudioError("Drive answered without a usable file id, so the save could not be recorded.", "drive_refused");
  await addLink(ctx, companyId, row.id, DRIVE_LINK_TYPE, result.driveFileId);
  return { fileId: result.driveFileId, url, savedAt: new Date().toISOString() };
}
