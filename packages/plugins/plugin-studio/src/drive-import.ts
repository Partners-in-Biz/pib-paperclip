/**
 * From Drive (PAR-8107, slice 2 of PAR-8106): list a client's Drive assets and copy one into Studio as a normal asset.
 * The client comes from the scope the person picked and is checked here (it must be a known CRM client); the CRM then
 * only reads that client's own assets folders, so a file id from another client's folder is refused there.
 * People only: the Drive id is kept as the asset's source ref (`drive:<scope>:<fileId>`), which agents never see.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  driveList as kitDriveList,
  driveRead as kitDriveRead,
  driveThumbs as kitDriveThumbs,
  DRIVE_THUMBS_MAX,
  formatClientParam,
  type ClientScope,
  type DriveFailure,
  type DriveListResult,
  type DriveReadResult,
  type DriveReadTarget,
  type DriveThumbSize,
  type DriveThumbsResult,
} from "@partnersinbiz/pib-plugin-kit";
import { assetOut, getAssetRow, storeAsset } from "./assets.js";
import { StudioConfig } from "./config.js";
import { table } from "./db.js";
import { DRIVE_MAX_BYTES } from "./drive-limits.js";
import { StudioError } from "./errors.js";
import { MAX_ASSET_BYTES, sniffMime } from "./storage.js";
import { resolveScope, scopeInput } from "./scope.js";

/** Under the host's 30 s action limit, so a silent CRM gives the plain message below rather than a bare 502 (PAR-8114). */
export const TIMEOUT_MS = 20_000;
const STUDIO_TYPES = /^(image\/(jpeg|png|gif|webp)|video\/(mp4|quicktime))$/;

export interface DriveReaders {
  list: (ctx: Pick<PluginContext, "events">, t: DriveReadTarget) => Promise<DriveListResult>;
  read: (ctx: Pick<PluginContext, "events">, t: DriveReadTarget & { fileId: string }) => Promise<DriveReadResult>;
  thumbs?: (ctx: Pick<PluginContext, "events">, t: DriveReadTarget & { fileIds: string[]; size?: DriveThumbSize }) => Promise<DriveThumbsResult>;
}
const KIT: DriveReaders = { list: kitDriveList, read: kitDriveRead, thumbs: kitDriveThumbs };
const FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Plain words for a refusal from the kit, the CRM or Google. */
export function readRefusal(result: DriveFailure): string {
  if (result.status === "no_ack") return `CRM didn't answer within ${TIMEOUT_MS / 1000} seconds. Check that the CRM plugin is running, then try again.`;
  switch (result.reason) {
    case "not_in_client_folder":
      return "That file isn't in this client's Drive assets folders, so Studio can't take it.";
    case "not_found":
      return "That file is no longer in Drive.";
    case "too_large":
      return `Studio takes Drive files up to ${mb(DRIVE_MAX_BYTES)} for now.`;
    case "no_project":
      return "This client has no Drive project in CRM yet, so there is no folder to read from.";
    case "no_assets_folder":
      return "This client's Drive folder has no Assets folders yet.";
    case "drive_not_bound":
    case "not_supported":
      return "This company has no Shared Drive bound in CRM, so nothing can be read from Drive.";
    default:
      return `Drive refused: ${result.reason}${result.hint ? ` (${result.hint})` : ""}.`;
  }
}

/** The person's picked client: "company:<id>", "contact:<id>" or "own"/empty for own work. Checked against the CRM. */
async function pickedScope(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const requested = scopeInput({ client: params.client === undefined ? null : params.client });
  return resolveScope(ctx, companyId, requested ?? null);
}

function target(companyId: string, scope: ClientScope): DriveReadTarget {
  return { companyId, timeoutMs: TIMEOUT_MS, ...(scope ? { client: { kind: scope.kind, ref: scope.id } } : {}) };
}

export function driveSourceRef(scope: ClientScope, fileId: string): string {
  return `drive:${scope ? formatClientParam(scope) : "own"}:${fileId}`;
}

/**
 * The Drive files Studio could take for this client: images and videos, newest first, with their folder
 * ("Assets/Images"), flagged when too big, and with the library asset when this client already has it (PAR-8124).
 */
export async function listDriveFiles(ctx: PluginContext, companyId: string, params: Record<string, unknown>, readers: DriveReaders = KIT) {
  const { scope } = await pickedScope(ctx, companyId, params);
  const result = await readers.list(ctx, target(companyId, scope));
  if (result.status !== "listed") throw new StudioError(readRefusal(result), "drive_refused");
  const prefix = driveSourceRef(scope, "");
  // One query for every file already copied for this client: the same source ref the import dedupes on.
  const rows = await ctx.db.query<{ id: string; source_ref: string }>(
    `SELECT id, source_ref FROM ${table(ctx, "assets")} WHERE company_id = $1 AND source = 'drive' AND source_ref LIKE $2`,
    [companyId, `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`],
  );
  const added = new Map(rows.filter((r) => r.source_ref?.startsWith(prefix)).map((r) => [r.source_ref.slice(prefix.length), r.id]));
  const files = result.files
    .filter((f) => STUDIO_TYPES.test(f.mimeType))
    .map((f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      size: f.size,
      folder: f.folder ?? null,
      modifiedTime: f.modifiedTime ?? null,
      tooLarge: f.size > DRIVE_MAX_BYTES,
      assetId: added.get(f.id) ?? null,
    }));
  files.sort((a, b) => (b.modifiedTime ?? "").localeCompare(a.modifiedTime ?? "") || a.name.localeCompare(b.name));
  return { files, maxBytes: DRIVE_MAX_BYTES };
}

/**
 * Previews for the picker (PAR-8124): Drive's own small images, fetched by the CRM inside this client's assets folders
 * and handed back as data: URLs, so no Drive link or token reaches the browser. A file without one gets a reason.
 */
export async function driveThumbs(ctx: PluginContext, companyId: string, params: Record<string, unknown>, readers: DriveReaders = KIT) {
  const raw = Array.isArray(params.fileIds) ? params.fileIds : [];
  const fileIds = [...new Set(raw.filter((id): id is string => typeof id === "string" && FILE_ID.test(id)))];
  if (fileIds.length === 0 || fileIds.length > DRIVE_THUMBS_MAX || fileIds.length !== raw.length) throw new StudioError(`Ask for 1 to ${DRIVE_THUMBS_MAX} Drive files.`, "bad_request");
  if (!readers.thumbs) throw new StudioError("Previews from Drive aren't available.", "drive_refused");
  const { scope } = await pickedScope(ctx, companyId, params);
  const size: DriveThumbSize = params.size === "large" ? "large" : "small";
  const result = await readers.thumbs(ctx, { ...target(companyId, scope), fileIds, size });
  if (result.status !== "thumbs") throw new StudioError(readRefusal(result), "drive_refused");
  return {
    thumbs: result.thumbs.map((t) => ("bytes" in t ? { id: t.id, url: `data:${t.mimeType};base64,${Buffer.from(t.bytes).toString("base64")}` } : { id: t.id, reason: t.reason })),
  };
}

/**
 * Copy one Drive file into Studio. Importing the same file for the same client twice returns the first copy (the
 * source ref is unique per company), so a double click or two people at once end with one asset.
 */
export async function importFromDrive(ctx: PluginContext, companyId: string, params: Record<string, unknown>, actor: { userId: string | null }, readers: DriveReaders = KIT) {
  const fileId = String(params.fileId ?? "").trim();
  if (!FILE_ID.test(fileId)) throw new StudioError("Pick a Drive file first.", "bad_request");
  const resolved = await pickedScope(ctx, companyId, params);
  const sourceRef = driveSourceRef(resolved.scope, fileId);
  const existing = await ctx.db.query<{ id: string }>(`SELECT id FROM ${table(ctx, "assets")} WHERE company_id = $1 AND source_ref = $2`, [companyId, sourceRef]);
  if (existing[0]) return { ...assetOut(await getAssetRow(ctx, companyId, existing[0].id)), reused: true };

  const result = await readers.read(ctx, { ...target(companyId, resolved.scope), fileId });
  if (result.status !== "read") throw new StudioError(readRefusal(result), "drive_refused");
  if (result.bytes.byteLength > Math.min(DRIVE_MAX_BYTES, MAX_ASSET_BYTES)) throw new StudioError(readRefusal({ status: "failed", requestId: result.requestId, reason: "too_large" }), "too_large");
  const bytes = new Uint8Array(result.bytes) as Uint8Array<ArrayBuffer>;
  const mime = sniffMime(bytes);
  if (!mime) throw new StudioError("Studio stores JPEG, PNG, GIF and WebP images and MP4 and MOV videos, and this file is none of those.", "unsupported_type");
  const name = (typeof params.name === "string" && params.name.trim()) || result.file.name.replace(/\.[A-Za-z0-9]{1,5}$/, "") || "Drive file";
  const id = await storeAsset(ctx, new StudioConfig(ctx, companyId), {
    companyId,
    scope: resolved.scope,
    clientName: resolved.client?.name ?? null,
    projectId: null,
    issueId: null,
    name: name.slice(0, 200),
    source: "drive",
    sourceRef,
    userId: actor.userId,
    bytes,
    mime,
  });
  return { ...assetOut(await getAssetRow(ctx, companyId, id)), reused: false };
}

/** People's page only: where a Drive import came from. */
export async function driveProvenance(ctx: PluginContext, companyId: string, assetId: string): Promise<{ source: "drive"; driveFileId: string } | null> {
  const rows = await ctx.db.query<{ source: string; source_ref: string | null }>(`SELECT source, source_ref FROM ${table(ctx, "assets")} WHERE company_id = $1 AND id = $2`, [companyId, assetId]);
  const ref = rows[0]?.source === "drive" ? rows[0].source_ref : null;
  const fileId = ref?.split(":").pop();
  return fileId ? { source: "drive", driveFileId: fileId } : null;
}
