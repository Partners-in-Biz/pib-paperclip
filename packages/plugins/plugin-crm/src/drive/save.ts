import { createHash } from "node:crypto";
import { realpath as realpathAsync } from "node:fs/promises";
import { statSync } from "node:fs";
import { relative } from "node:path";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { normalizeUrl, safeFetchBytes } from "@partnersinbiz/pib-plugin-kit";
import type { Viewer } from "../domain.js";
import { BrokerError, DriveNotBoundError } from "./broker.js";
import { findDriveFile, upsertDriveFile } from "./store.js";
import { createBrokerForCompany, driveFolderEnsure } from "./tools.js";
import { DRIVE_SUBFOLDERS, translateSubfolder } from "./convention.js";

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
}

export interface SaveDriveFileResult {
  status: "saved" | "drive_not_bound" | "invalid_name" | "invalid_input" | "invalid_kind" | "too_large" | "sha_mismatch" | "broker_error" | "project_not_found" | "path_not_allowed" | "fetch_failed" | "invalid_subfolder";
  driveFileId?: string;
  url?: string;
  name?: string;
  sha256?: string;
  subfolder?: string | null;
  duplicate?: boolean;
  code?: string;
  retryable?: boolean;
  hint?: string;
}

export async function saveDriveFile(ctx: PluginContext, viewer: Viewer, input: SaveDriveFileInput, opts?: { allowedRoots?: string[] }): Promise<SaveDriveFileResult> {
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

  const sourceCount = [contentBase64, publicUrl, filePath].filter(Boolean).length;
  if (sourceCount !== 1) {
    return { status: "invalid_input", hint: "Provide exactly one of contentBase64, publicUrl, or path" };
  }

  let bytes: Uint8Array;
  try {
    if (contentBase64) {
      bytes = new Uint8Array(Buffer.from(contentBase64, "base64"));
    } else if (publicUrl) {
      bytes = await fetchPublicBytes(ctx, publicUrl);
    } else {
      const fileBytes = await loadFileFromPath(filePath!, opts?.allowedRoots);
      if (fileBytes === null) {
        return { status: "path_not_allowed", hint: "Path not allowed: source must be a file inside the permitted drive root" };
      }
      bytes = fileBytes;
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

  if (bytes.byteLength > MAX_FILE_BYTES) {
    return { status: "too_large" };
  }

  const computedSha256 = createHash("sha256").update(bytes).digest("hex");
  if (inputSha256 && inputSha256.toLowerCase() !== computedSha256) {
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
  const existing = await findDriveFile(ctx, companyId, { folderId: uploadFolderId, name, sha256: computedSha256 });
  if (existing) {
    return { status: "saved", driveFileId: existing.id, url: stripSignedUrl(existing.webUrl), name: existing.name, sha256: existing.sha256, subfolder: existing.subfolder, duplicate: true };
  }

  let uploadResult;
  try {
    uploadResult = await broker.uploadFile({ name, bytes, mimeType, parentFolderId: uploadFolderId });
  } catch (e) {
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
    return { status: "saved", driveFileId: inserted.id, url: stripSignedUrl(inserted.webUrl), name: inserted.name, sha256: inserted.sha256, subfolder: inserted.subfolder, duplicate: false };
  } catch (e) {
    return { status: "broker_error", code: "db_error", retryable: false, hint: "Failed to store file metadata" };
  }
}

async function loadFileFromPath(filePath: string, allowedRootsInput?: string[]): Promise<Uint8Array | null> {
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
    if (stat.size > MAX_FILE_BYTES) throw new Error("too_large");

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
