/**
 * `drive_file_fetch` (PAR-9219 D): a project Drive file of up to 200 MiB into the calling run's scratch dir, always as
 * a job. Each job writes into a fresh `mkdtemp` dir, through the dir's own fd, with O_EXCL|O_NOFOLLOW, and checks the
 * file fd's real path before any byte: no `.part`, no rename, nothing overwritten. A size or sha256 mismatch empties
 * the file and unlinks it only while the fd still names that path. Texts are ours; Google's never reach the agent.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp as fsMkdtemp, open, readlink, rmdir, statfs as fsStatfs, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { DRIVE_TRANSFER_MAX_BYTES } from "@partnersinbiz/pib-plugin-kit";
import type { Viewer } from "../domain.js";
import { DriveNotBoundError, type Broker, type DriveFileInfo } from "./broker.js";
import { DriveJobFailure, TEXTS, fetchJobKey, jobErrorFor, startDriveJob, type DriveJobStart } from "./jobs.js";
import { resolveRunScratch } from "./run-scope.js";
import { createBrokerForCompany, driveFolderEnsure } from "./tools.js";

const MiB = 1024 * 1024;
/** Free space kept on the scratch disk after the file (R3). */
export const FETCH_DISK_MARGIN_BYTES = 512 * MiB;
const FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;
const MAX_NAME = 120;

export type FetchRefusal = { status: string; hint?: string };
export type DriveFileFetchResult = (DriveJobStart & { hint?: string }) | FetchRefusal;

export interface FetchDeps {
  brokerFor?: (ctx: PluginContext, companyId: string) => Promise<Broker | null>;
  statfs?: (path: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;
  mkdtemp?: (prefix: string) => Promise<string>;
}

const STARTED_HINT = "The file is being fetched in the background. Call drive_transfer_status with this jobId every 20-30 s until it is done; its result.path is the file in this run's scratch dir.";
const REPLACED = "The fetch folder in this run's scratch dir was changed while the file was being made, so nothing was written. Fetch it again.";

/** D.4: basename only, safe characters, no leading dot, at most 120 chars with the extension kept, never empty. */
export function safeName(raw: unknown, fileId: string): string {
  const base = String(raw ?? "").split(/[\\/]/).pop() ?? "";
  let name = base.replace(/[^A-Za-z0-9 ._()-]/g, "_").replace(/^[.\s]+/, "");
  if (name.length > MAX_NAME) {
    const ext = /\.[A-Za-z0-9]{1,16}$/.exec(name)?.[0] ?? "";
    name = name.slice(0, MAX_NAME - ext.length) + ext;
  }
  return name.length ? name : `drive-file-${fileId}`;
}

const inside = (root: string, real: string) => {
  const rel = relative(root, real);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep);
};

/** Start a fetch. Every check that needs no bytes runs here, so a refusal comes back at once. */
export async function driveFileFetch(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>, deps: FetchDeps = {}): Promise<DriveFileFetchResult> {
  const projectId = params.projectId, fileId = params.fileId;
  if (typeof projectId !== "string" || !projectId) return { status: "invalid_input", hint: "projectId is required." };
  if (typeof fileId !== "string" || !FILE_ID.test(fileId)) return { status: "invalid_input", hint: "fileId is a Google Drive file id (letters, digits, - and _)." };
  const run = await resolveRunScratch(ctx, viewer);
  if (!run.ok) return { status: run.code, hint: run.hint };
  if (!(await ctx.projects.get(projectId, viewer.companyId))) return { status: "project_not_found" };

  let broker: Broker | null;
  let meta: DriveFileInfo | null;
  try {
    broker = await (deps.brokerFor ?? createBrokerForCompany)(ctx, viewer.companyId);
    if (!broker) return { status: "drive_not_bound", hint: "Bind Drive in CRM settings (drive.sharedDriveId)." };
    const folders = await projectFolderIds(ctx, viewer, projectId);
    if (!("ids" in folders)) return folders;
    if (!broker.fileMeta || !broker.downloadStream) return { status: "not_supported", hint: "This Drive connection can't fetch files." };
    meta = await broker.fileMeta(fileId);
    if (!meta) return { status: "not_found", hint: TEXTS.notFound };
    // The access rule: the file sits in the project's folder or one of its sub-folders (as Studio's read, read.ts).
    if (!meta.parents.some((p) => folders.ids.includes(p))) return { status: "not_in_project_folder", hint: "That file is not in this project's Drive folder or its sub-folders." };
  } catch (e) {
    if (e instanceof DriveNotBoundError) return { status: "drive_not_bound", hint: "Bind Drive in CRM settings (drive.sharedDriveId)." };
    const err = jobErrorFor("fetch", e);
    return { status: err.code, hint: err.hint };
  }
  if (meta.mimeType.startsWith("application/vnd.google-apps.") || !(meta.size > 0)) return { status: "not_supported", hint: "Export Google Docs files from Drive first." };
  if (meta.size > DRIVE_TRANSFER_MAX_BYTES) return { status: "too_large", hint: TEXTS.tooLarge };
  const disk = await (deps.statfs ?? fsStatfs)(run.scratch);
  if (Number(disk.bavail) * Number(disk.bsize) < meta.size + FETCH_DISK_MARGIN_BYTES) {
    return { status: "no_space", hint: "There is not enough free disk space in this run's scratch dir for this file." };
  }

  const file = meta, dl = broker.downloadStream.bind(broker);
  const name = safeName(file.name, fileId);
  const held: { dir?: string; dirFh?: FileHandle; fh?: FileHandle } = {};
  const started = startDriveJob({ companyId: viewer.companyId, agentId: viewer.agentId, runId: viewer.runId ?? null }, {
    kind: "fetch",
    key: fetchJobKey(viewer.companyId, viewer.runId, fileId),
    bytesTotal: file.size,
    logger: ctx.logger,
    cleanup: async () => {
      await held.fh?.close().catch(() => undefined);
      await held.dirFh?.close().catch(() => undefined);
    },
    work: async (progress) => {
      const path = await createTarget(run.scratch, name, held, deps.mkdtemp ?? fsMkdtemp);
      try {
        return { path, ...(await download(held.fh!, file, () => dl(fileId), progress)), name, mimeType: file.mimeType, runId: viewer.runId };
      } catch (e) {
        await removeWritten(held.fh!, path);
        throw e;
      }
    },
  });
  return started.status === "busy" ? started : { ...started, hint: STARTED_HINT };
}

/** The project folder and its sub-folders, looked up fresh (a fetch copies bytes). */
async function projectFolderIds(ctx: PluginContext, viewer: Viewer, projectId: string): Promise<{ ids: string[] } | FetchRefusal> {
  const res = (await driveFolderEnsure(ctx, viewer, { entity_type: "project", entity_id: projectId, include_tree: true })) as {
    status?: string; hint?: string; folder_id?: string; path?: string; tree?: Array<{ path?: string; folderId?: string }>;
  };
  if (res?.status === "not_found") return { status: "project_not_found" };
  if (res?.status !== "created" && res?.status !== "exists") return { status: res?.status ?? "transfer_failed", hint: res?.hint ?? TEXTS.failed };
  if (!res.folder_id) return { status: "transfer_failed", hint: TEXTS.failed };
  const below = `${res.path}/`;
  return { ids: [res.folder_id, ...(res.tree ?? []).filter((e) => e.folderId && e.path?.startsWith(below)).map((e) => e.folderId!)] };
}

/**
 * D.4: `mkdtemp`, then the dir opened with O_NOFOLLOW and the file created through that dir fd (`/proc/self/fd/<n>/`),
 * so a dir swapped for a symlink after `mkdtemp` is never followed. O_EXCL|O_NOFOLLOW refuses anything at the name.
 * The file fd's real path is checked against the scratch root before any byte is written.
 */
async function createTarget(scratch: string, name: string, held: { dir?: string; dirFh?: FileHandle; fh?: FileHandle }, mkdtemp: (p: string) => Promise<string>): Promise<string> {
  held.dir = await mkdtemp(join(scratch, "drive-fetch-"));
  try {
    held.dirFh = await open(held.dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    throw new DriveJobFailure("path_not_allowed", REPLACED);
  }
  const dirReal = await readlink(`/proc/self/fd/${held.dirFh.fd}`);
  if (!inside(scratch, dirReal)) throw new DriveJobFailure("path_not_allowed", REPLACED);
  try {
    held.fh = await open(`/proc/self/fd/${held.dirFh.fd}/${name}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch {
    throw new DriveJobFailure("path_not_allowed", REPLACED);
  }
  const path = join(dirReal, name);
  const real = await readlink(`/proc/self/fd/${held.fh.fd}`);
  if (real !== path || !inside(scratch, real) || dirname(real) !== dirReal) throw new DriveJobFailure("path_not_allowed", REPLACED);
  return path;
}

/** Drive's body into the fd, hashed as it is written; the byte count and any stored sha256 must match. */
async function download(fh: FileHandle, file: DriveFileInfo, get: () => ReturnType<NonNullable<Broker["downloadStream"]>>, progress: (n: number) => void): Promise<{ size: number; sha256: string }> {
  const mismatch = () => new DriveJobFailure("size_mismatch", TEXTS.sizeMismatch);
  const res = await get();
  if (res.size !== null && res.size !== file.size) {
    await res.body.cancel().catch(() => undefined);
    throw mismatch();
  }
  const hash = createHash("sha256");
  const reader = res.body.getReader();
  let written = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (written + value.byteLength > file.size) throw mismatch();
      for (let at = 0; at < value.byteLength; ) {
        const { bytesWritten } = await fh.write(value, at, value.byteLength - at, written + at);
        at += bytesWritten;
      }
      hash.update(value);
      written += value.byteLength;
      progress(written);
    }
  } catch (e) {
    await reader.cancel().catch(() => undefined);
    throw e;
  }
  if (written !== file.size) throw mismatch();
  const sha256 = hash.digest("hex");
  if (file.sha256 && file.sha256 !== sha256) throw new DriveJobFailure("sha_mismatch", TEXTS.sizeMismatch);
  return { size: written, sha256 };
}

/** D.4 on failure: empty the file, then unlink it and its dir only while the fd still names that path. */
async function removeWritten(fh: FileHandle, path: string): Promise<void> {
  await fh.truncate(0).catch(() => undefined);
  const real = await readlink(`/proc/self/fd/${fh.fd}`).catch(() => null);
  if (real !== path) return;
  await unlink(path).catch(() => undefined);
  await rmdir(dirname(path)).catch(() => undefined);
}
