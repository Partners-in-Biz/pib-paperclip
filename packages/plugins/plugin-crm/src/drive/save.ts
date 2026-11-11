import { createHash } from "node:crypto";
import { realpath as realpathAsync } from "node:fs/promises";
import { statSync } from "node:fs";
import { relative } from "node:path";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { DRIVE_TRANSFER_MAX_BYTES, isR2ObjectUrl, isSha256Hex, normalizeUrl, safeFetchBytes } from "@partnersinbiz/pib-plugin-kit";
import type { Viewer } from "../domain.js";
import { BrokerError, DriveNotBoundError, type Broker } from "./broker.js";
import { r2Chunks, R2StreamError, type R2Fetch } from "./r2-stream.js";
import { findDriveFile, upsertDriveFile } from "./store.js";
import { createBrokerForCompany, driveFolderEnsure } from "./tools.js";
import { DRIVE_SUBFOLDERS, translateSubfolder } from "./convention.js";
import { acquireTransferSlot } from "./transfer-slots.js";
import { openRunFile, resolveRunRoots, type RunScopeRefusal } from "./run-scope.js";
import { fileChunks, hashFile, sameFile } from "./file-stream.js";
import { DriveJobFailure, TEXTS, saveJobKey, startDriveJob } from "./jobs.js";
import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";

const VALID_KINDS = ["client", "product", "book", "marketing", "company", "seo", "social", "campaigns", "ads", "ops"] as const;
const NAME_PATTERN = /^(\d{4}-\d{2}-\d{2}\s+.+\s+v\d+\.\w+|[A-Z]+-\d+-\d+\.\w+)$/;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export async function fetchPublicBytes(ctx: PluginContext, url: string): Promise<Uint8Array> {
  // Validate scheme is http or https
  const normalized = normalizeUrl(url);
  try {
    const urlObj = new URL(normalized);
    if (!["http:", "https:"].includes(urlObj.protocol)) {
      throw new Error("fetch_failed");
    }
  } catch {
    throw new Error("fetch_failed");
  }

  try {
    const result = await safeFetchBytes(ctx, url, { maxRedirects: 3, maxBytes: MAX_FILE_BYTES });
    if (result.status !== 200) {
      throw new Error("fetch_failed");
    }
    return result.bytes;
  } catch {
    throw new Error("fetch_failed");
  }
}

export interface SaveDriveFileInput {
  companyId: string;
  projectId: string;
  fileKind: string;
  name: string;
  mimeType: string;
  contentBase64?: string;
  publicUrl?: string;
  path?: string;
  sha256?: string;
  subfolder?: string | null;
  requestId?: string;
  /** A file over 5 MiB (PAR-8125): a signed R2 GET link, with `size` and `sha256`. Never logged or shown. */
  r2Url?: string;
  size?: number;
  /** Large files: called after each chunk reaches Drive. */
  onProgress?: (bytesDone: number, bytesTotal: number) => Promise<void> | void;
}

function tooLargeHint(size: number): string {
  const mb = (n: number) => Math.round(n / (1024 * 1024));
  return `This file is ${mb(size)} MB. Drive transfers take files up to ${mb(DRIVE_TRANSFER_MAX_BYTES)} MB, the largest file Studio keeps.`;
}

/** Row 1 of the path decision table (PAR-9219 A): a file over 5 MB that only the old root holds. */
export const OVER_5MB_PATH_HINT = "Over 5 MB, Drive saves by path take files from this run's workspace or $PAPERCLIP_TMPDIR, up to 200 MB.";
const STARTED_HINT = "The file is being saved in the background. Call drive_transfer_status with this jobId every 20-30 s until it is done.";
const PATH_HINT = "Path not allowed: source must be a file inside the permitted drive root";

export interface SaveDriveFileResult {
  status: "saved" | "started" | "busy" | "drive_not_bound" | "invalid_name" | "invalid_input" | "invalid_kind" | "too_large" | "sha_mismatch" | "broker_error" | "project_not_found" | "path_not_allowed" | "fetch_failed" | "invalid_subfolder";
  driveFileId?: string;
  url?: string;
  name?: string;
  sha256?: string;
  subfolder?: string | null;
  duplicate?: boolean;
  code?: string;
  retryable?: boolean;
  hint?: string;
  /** A save by path over 5 MB (PAR-9219): the background transfer to ask drive_transfer_status about. */
  jobId?: string;
  bytesTotal?: number;
  alreadyRunning?: true;
}

export async function saveDriveFile(ctx: PluginContext, viewer: Viewer, input: SaveDriveFileInput, opts?: { allowedRoots?: string[]; r2FetchFn?: R2Fetch }): Promise<SaveDriveFileResult> {
  // A run file's handle is closed here on every return, unless a job took it over (the job closes it).
  const held: { fh?: FileHandle; handedOff?: boolean } = {};
  try {
    return await saveDriveFileInner(ctx, viewer, input, held, opts);
  } finally {
    if (held.fh && !held.handedOff) await held.fh.close().catch(() => undefined);
  }
}

async function saveDriveFileInner(ctx: PluginContext, viewer: Viewer, input: SaveDriveFileInput, held: { fh?: FileHandle; handedOff?: boolean }, opts?: { allowedRoots?: string[]; r2FetchFn?: R2Fetch }): Promise<SaveDriveFileResult> {
  const { companyId, projectId, fileKind, name, mimeType, contentBase64, publicUrl, path: filePath, sha256: inputSha256 } = input;

  if (!NAME_PATTERN.test(name)) {
    return { status: "invalid_name", hint: 'Name must be YYYY-MM-DD <what> v<n>.<ext> or ISSUE-step-ts.<ext>' };
  }

  // Validate subfolder early, before any file/broker work. The producer plugins still send the old numbered names
  // ("02 Assets", "04 Reports"): those are translated to the drive's own names first, then everything is validated against the same list.
  let subfolder: string | undefined = input.subfolder || undefined;
  if (subfolder) {
    if (typeof subfolder !== "string" || subfolder.trim() === "") {
      return { status: "invalid_subfolder", hint: `subfolder must be a non-empty string` };
    }
    subfolder = translateSubfolder(subfolder);
    if (!(DRIVE_SUBFOLDERS as readonly string[]).includes(subfolder)) {
      return { status: "invalid_subfolder", hint: `subfolder must be one of: ${DRIVE_SUBFOLDERS.join(", ")}` };
    }
  }

  const dateMatch = name.match(/^(\d{4})-(\d{2})-(\d{2})\s/);
  if (dateMatch) {
    const [, yStr, mStr, dStr] = dateMatch;
    const y = parseInt(yStr, 10), m = parseInt(mStr, 10), d = parseInt(dStr, 10);
    const testDate = new Date(Date.UTC(y, m - 1, d));
    if (testDate.getUTCFullYear() !== y || testDate.getUTCMonth() + 1 !== m || testDate.getUTCDate() !== d) {
      return { status: "invalid_name", hint: `Invalid date ${yStr}-${mStr}-${dStr}` };
    }
  }

  if (!new Set(VALID_KINDS).has(fileKind as never)) {
    return { status: "invalid_kind", hint: `fileKind must be one of: ${VALID_KINDS.join(", ")}` };
  }

  const r2Url = input.r2Url;
  const sourceCount = [contentBase64, publicUrl, filePath, r2Url].filter(Boolean).length;
  if (sourceCount !== 1) {
    return { status: "invalid_input", hint: "Provide exactly one of contentBase64, publicUrl, or path" };
  }

  // A large file (PAR-8125): never loaded whole. Its size and sha256 are the producer's; the bytes are checked on the
  // way to Drive. The link is a secret: no hint, log or reply carries it.
  let large: { url: string; size: number } | null = null;
  if (r2Url) {
    const size = input.size;
    if (!isR2ObjectUrl(r2Url)) return { status: "invalid_input", hint: "The storage link is not a Cloudflare R2 link, so it was not opened." };
    if (!isSha256Hex(inputSha256) || typeof size !== "number" || !Number.isInteger(size) || size <= 0) {
      return { status: "invalid_input", hint: "A large file needs its exact size and sha256." };
    }
    if (size > DRIVE_TRANSFER_MAX_BYTES) {
      return { status: "too_large", hint: tooLargeHint(size) };
    }
    large = { url: r2Url, size };
  }

  let bytes: Uint8Array = new Uint8Array(0);
  // A file over 5 MB in the calling run's own workspace or scratch dir (PAR-9219 A rows 2-3): its open handle goes to a job.
  let local: { fh: FileHandle; stat: Stats } | null = null;
  if (!large) try {
    if (contentBase64) {
      bytes = new Uint8Array(Buffer.from(contentBase64, "base64"));
    } else if (publicUrl) {
      bytes = await fetchPublicBytes(ctx, publicUrl);
    } else {
      const picked = await pathSource(ctx, viewer, filePath!, opts?.allowedRoots);
      if ("status" in picked) return picked;
      if ("bytes" in picked) bytes = picked.bytes;
      else held.fh = (local = picked).fh;
    }
  } catch (e) {
    if (e instanceof Error && e.message === "too_large") {
      return { status: "too_large" };
    }
    // Treat file-not-found and other path errors as path_not_allowed to avoid leaking path info
    if (e instanceof Error && (
      e.message.includes("ENOENT") || e.message.includes("No such file") ||
      e.message.includes("not found") || e.message.includes("ENOTDIR") ||
      e.message.includes("Not a regular file")
    )) {
      return { status: "path_not_allowed", hint: "Path not allowed: source must be a file inside the permitted drive root" };
    }
    if (e instanceof Error && e.message === "fetch_failed") {
      return { status: "fetch_failed", hint: "Failed to fetch file from public URL" };
    }
    return { status: "invalid_input", hint: "Failed to load file from path" };
  }

  if (!large && !local && bytes.byteLength > MAX_FILE_BYTES) {
    return { status: "too_large" };
  }

  const computedSha256 = large ? inputSha256!.toLowerCase() : local ? "" : createHash("sha256").update(bytes).digest("hex");
  if (!large && !local && inputSha256 && inputSha256.toLowerCase() !== computedSha256) {
    return { status: "sha_mismatch", hint: `Expected ${inputSha256}, got ${computedSha256}` };
  }

  let broker;
  try {
    broker = await createBrokerForCompany(ctx, companyId);
  } catch (e) {
    if (e instanceof DriveNotBoundError) {
      return { status: "drive_not_bound", hint: "Bind Drive in CRM settings (drive.sharedDriveId)." };
    }
    throw e;
  }
  if (!broker) {
    return { status: "drive_not_bound", hint: "Bind Drive in CRM settings (drive.sharedDriveId)." };
  }

  let resolvedSubfolderId: string | null = null;
  // The sub-folder the file really goes into (null: the folder itself, also when the folder has no sub-folders and the requested one is ignored)
  let savedSubfolder: string | null = null;
  // Pass include_tree when subfolder is set, so already-ensured projects return tree with subfolders
  const folderRes = await driveFolderEnsure(ctx, viewer, { entity_type: "project", entity_id: projectId, ...(subfolder ? { include_tree: true } : {}) });
  if (typeof folderRes !== "object" || !folderRes) {
    return { status: "invalid_input", hint: "Failed to ensure folder" };
  }
  const folderAny = folderRes as any;
  if (folderAny.status === "not_found") {
    return { status: "project_not_found" };
  }
  if (folderAny.status && folderAny.status !== "created" && folderAny.status !== "exists") {
    return { status: folderAny.status as any, hint: folderAny.hint };
  }

  const folderId = folderAny.folder_id;
  if (!folderId) {
    return { status: "invalid_input", hint: "No folder_id from ensure result" };
  }

  // Resolve subfolder to folderId from tree, by the exact path below the folder (a nested name such as "Assets/Social" is one path)
  if (subfolder) {
    const tree: Array<{ path?: string; folderId?: string }> = folderAny.tree ?? [];
    const folderPath: string = folderAny.path;
    if (tree.length === 0) {
      // A folder with no standard sub-folders (a book, company or marketing folder): the sub-folder is ignored and the file goes into the folder itself.
      // It is stored with no sub-folder, which is where it is.
    } else {
      const subfolderEntry = tree.find((entry) => entry.path === `${folderPath}/${subfolder}`);
      if (!subfolderEntry?.folderId) {
        const options = tree.filter((entry) => entry.path?.startsWith(`${folderPath}/`)).map((entry) => entry.path!.slice(folderPath.length + 1));
        return { status: "invalid_subfolder", hint: `This project's Drive folder has no "${subfolder}" sub-folder. Its sub-folders are: ${options.join(", ")}` };
      }
      resolvedSubfolderId = subfolderEntry.folderId;
      savedSubfolder = subfolder;
    }
  }

  const uploadFolderId = resolvedSubfolderId ?? folderId;
  if (local) {
    held.handedOff = true;
    return startLocalSave(ctx, viewer, input, local, { broker, uploadFolderId, savedSubfolder, subfolder });
  }

  const existing = await findDriveFile(ctx, companyId, { folderId: uploadFolderId, name, sha256: computedSha256 });
  if (existing) {
    return savedResult(existing, true);
  }

  let uploadResult;
  try {
    if (large) {
      if (!broker.uploadFileStream) {
        return { status: "broker_error", code: "unsupported", retryable: false, hint: "This Drive connection cannot take files over 5 MB." };
      }
      // Counted in the shared transfer slots (PAR-9219 C.4), never refused: a producer route keeps its behaviour.
      const releaseSlot = acquireTransferSlot();
      try {
        uploadResult = await broker.uploadFileStream({
          name, mimeType, parentFolderId: uploadFolderId, size: large.size, sha256: computedSha256,
          chunks: r2Chunks(large.url, large.size, opts?.r2FetchFn ? { fetchFn: opts.r2FetchFn } : {}),
          onProgress: input.onProgress ? (done) => input.onProgress!(done, large!.size) : undefined,
        });
      } finally {
        releaseSlot();
      }
    } else {
      uploadResult = await broker.uploadFile({ name, bytes, mimeType, parentFolderId: uploadFolderId });
    }
  } catch (e) {
    if (e instanceof R2StreamError) {
      return { status: "fetch_failed", code: e.code, retryable: e.code === "fetch_failed", hint: e.message };
    }
    if (e instanceof BrokerError && (e.code === "sha_mismatch" || e.code === "size_mismatch")) {
      return { status: "sha_mismatch", code: e.code, retryable: false, hint: e.message };
    }
    if (e instanceof BrokerError) {
      return { status: "broker_error", code: e.code, retryable: e.retryable, hint: e.message };
    }
    return { status: "broker_error", code: "unknown", retryable: false, hint: "File upload failed" };
  }

  try {
    const { file: inserted } = await upsertDriveFile(ctx, {
      companyId, projectId, kind: fileKind, folderId: uploadFolderId, name, sha256: computedSha256,
      driveFileId: uploadResult.fileId, webUrl: uploadResult.webViewLink, sourcePlugin: null, subfolder: savedSubfolder,
    });
    return savedResult(inserted, false);
  } catch (e) {
    return { status: "broker_error", code: "db_error", retryable: false, hint: "Failed to store file metadata" };
  }
}

const savedResult = (f: { id: string; webUrl: string; name: string; sha256: string; subfolder: string | null }, duplicate: boolean): SaveDriveFileResult =>
  ({ status: "saved", driveFileId: f.id, url: stripSignedUrl(f.webUrl), name: f.name, sha256: f.sha256, subfolder: f.subfolder, duplicate });

/**
 * Where a `path` file is read from (PAR-9219 A decision table). The old root is checked first, reading nothing. The
 * calling run's roots are read only when that refuses or the file is over 5 MB, and only for a call with a runId:
 * a call without one never reads the database and gets today's result.
 */
async function pathSource(ctx: PluginContext, viewer: Viewer, filePath: string, allowedRoots?: string[]): Promise<SaveDriveFileResult | { bytes: Uint8Array } | { fh: FileHandle; stat: Stats }> {
  let old: { size: number } | null = null;
  let oldError: unknown = null;
  try {
    old = await oldRootFile(filePath, allowedRoots);
  } catch (e) {
    oldError = e;
  }
  if (old && old.size <= MAX_FILE_BYTES) {
    // Rows 1-2, up to 5 MB: unchanged. Errors are the caller's to map, as today.
    const fileBytes = await loadFileFromPath(filePath, allowedRoots);
    return fileBytes === null ? { status: "path_not_allowed", hint: PATH_HINT } : { bytes: fileBytes };
  }
  const refused = (r: RunScopeRefusal): SaveDriveFileResult => (old ? { status: "too_large", hint: OVER_5MB_PATH_HINT } : { status: "path_not_allowed", hint: r.hint });
  if (!viewer.runId) {
    if (oldError) throw oldError;
    return old ? { status: "too_large", hint: OVER_5MB_PATH_HINT } : { status: "path_not_allowed", hint: PATH_HINT };
  }
  const run = await resolveRunRoots(ctx, viewer);
  if (!run.ok) return refused(run);
  const file = await openRunFile(run.roots, filePath);
  if (!file.ok) return refused(file);
  const size = file.stat.size;
  if (size > MAX_FILE_BYTES && size <= DRIVE_TRANSFER_MAX_BYTES) return { fh: file.fh, stat: file.stat };
  try {
    if (size > DRIVE_TRANSFER_MAX_BYTES) return { status: "too_large", hint: tooLargeHint(size) };
    let bytes: Uint8Array = new Uint8Array(0);
    for await (const chunk of fileChunks(file.fh, size, MAX_FILE_BYTES)) bytes = chunk;
    return { bytes };
  } catch {
    return { status: "invalid_input", hint: "Failed to load file from path" };
  } finally {
    await file.fh.close().catch(() => undefined);
  }
}

/**
 * Rows 2-3 over 5 MB: a background job on the open handle. Pass 1 hashes it, pass 2 streams it to a Google resumable
 * upload. fstat is compared before pass 1, after pass 1 and after pass 2's last read (before its last chunk is sent),
 * and the broker hashes pass 2 again, so a file that changes fails as `file_changed` and no Drive file is made.
 * Synchronous up to `startDriveJob`, which owns the handle from then on.
 */
function startLocalSave(
  ctx: PluginContext, viewer: Viewer, input: SaveDriveFileInput, local: { fh: FileHandle; stat: Stats },
  target: { broker: { uploadFileStream?: Broker["uploadFileStream"] }; uploadFolderId: string; savedSubfolder: string | null; subfolder: string | undefined },
): SaveDriveFileResult {
  const { fh, stat } = local;
  const { size } = stat;
  const { companyId, projectId, fileKind, name, mimeType } = input;
  const check = async () => {
    if (!sameFile(stat, await fh.stat())) throw new DriveJobFailure("file_changed", TEXTS.fileChanged);
  };
  async function* chunks(): AsyncGenerator<Uint8Array> {
    let read = 0;
    for await (const chunk of fileChunks(fh, size)) {
      read += chunk.byteLength;
      if (read === size) await check();
      yield chunk;
    }
  }
  const started = startDriveJob({ companyId, agentId: viewer.agentId, runId: viewer.runId ?? null }, {
    kind: "save",
    key: saveJobKey(companyId, projectId, target.subfolder, name),
    bytesTotal: size,
    logger: ctx.logger,
    cleanup: () => fh.close(),
    work: async (progress) => {
      await check();
      const sha256 = await hashFile(fh, size);
      await check();
      if (input.sha256 && input.sha256.toLowerCase() !== sha256) throw new DriveJobFailure("sha_mismatch", "The file's sha256 is not the one you gave.");
      const existing = await findDriveFile(ctx, companyId, { folderId: target.uploadFolderId, name, sha256 });
      if (existing) return savedResult(existing, true);
      if (!target.broker.uploadFileStream) throw new DriveJobFailure("unsupported", "This Drive connection cannot take files over 5 MB.");
      const uploaded = await target.broker.uploadFileStream({ name, mimeType, parentFolderId: target.uploadFolderId, size, sha256, chunks: chunks(), onProgress: progress });
      const { file } = await upsertDriveFile(ctx, {
        companyId, projectId, kind: fileKind, folderId: target.uploadFolderId, name, sha256,
        driveFileId: uploaded.fileId, webUrl: uploaded.webViewLink, sourcePlugin: null, subfolder: target.savedSubfolder,
      });
      return savedResult(file, false);
    },
  });
  return started.status === "busy" ? started : { ...started, hint: STARTED_HINT };
}

/** Today's old-root check, reading nothing: the file's real path and size, or null when it is outside every root. */
async function oldRootFile(filePath: string, allowedRootsInput?: string[]): Promise<{ resolved: string; size: number } | null> {
  let allowedRoots = allowedRootsInput;
  if (!allowedRoots) {
    const envRoots = process.env.PIB_DRIVE_ALLOWED_ROOTS || "/home/paperclip/.paperclip/instances/default/companies";
    allowedRoots = envRoots.split(",").map((r) => r.trim()).filter(Boolean);
  }

  if (!allowedRoots.length) {
    throw new Error("No allowed roots configured");
  }

  try {
    const resolved = await realpathAsync(filePath);
    const resolvedRoots = await Promise.all(allowedRoots.map((r) => realpathAsync(r).catch(() => null)));

    let isAllowed = false;
    for (const root of resolvedRoots) {
      if (root) {
        const rel = relative(root, resolved);
        if (!rel.startsWith("..") && !rel.startsWith("/")) {
          isAllowed = true;
          break;
        }
      }
    }

    if (!isAllowed) return null;

    const stat = statSync(resolved);
    if (!stat.isFile()) throw new Error("Not a regular file");
    return { resolved, size: stat.size };
  } catch (e) {
    throw e;
  }
}

async function loadFileFromPath(filePath: string, allowedRootsInput?: string[]): Promise<Uint8Array | null> {
  try {
    const found = await oldRootFile(filePath, allowedRootsInput);
    if (!found) return null;
    const { resolved } = found;
    if (found.size > MAX_FILE_BYTES) throw new Error("too_large");

    const { readFile } = await import("node:fs/promises");
    const buffer = await readFile(resolved);
    return new Uint8Array(buffer);
  } catch (e) {
    if (e instanceof Error && e.message === "too_large") throw e;
    throw e;
  }
}

function stripSignedUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    const params = new URLSearchParams(urlObj.search);
    const keysToRemove = Array.from(params.keys()).filter(
      (key) => key.startsWith("X-Amz-") || key === "Signature" || key === "token" || key === "access_token"
    );
    keysToRemove.forEach((key) => params.delete(key));
    if (keysToRemove.length > 0) urlObj.search = params.toString();
    return urlObj.toString();
  } catch {
    return url;
  }
}
