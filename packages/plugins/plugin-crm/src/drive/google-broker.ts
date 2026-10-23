/**
 * Native Drive broker: talks to the Google Drive v3 API directly with a Drive
 * service account that is a member of the company's Shared Drive. It replaces
 * the partnersinbiz-web broker behind the same `Broker` interface.
 *
 * Folder registry: there is no table. Each folder carries its Paperclip entity
 * in Drive `appProperties` (`pibEntityType`, `pibEntityId`) and its display path
 * in `description` (appProperties are capped at 124 bytes per key+value).
 * Uploads carry their sha256 in `appProperties.pibSha256` so a repeat is a no-op.
 *
 * Every call sends supportsAllDrives / includeItemsFromAllDrives, and lookups
 * are scoped with corpora=drive&driveId=<Shared Drive>.
 */
import { createHash } from "node:crypto";
import {
  BrokerError,
  DriveNotBoundError,
  type Broker,
  type DriveEntityType,
  type EnsureBody,
  type EnsureResult,
  type IdentityResult,
  type RegistryFolder,
  type UploadResult,
} from "./broker.js";
import { GoogleAuthError, serviceAccountToken, type GoogleFetch, type ServiceAccountKey } from "./google-sa.js";

const DRIVE = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const FOLDER_FIELDS = "id,name,description,webViewLink,parents,appProperties";

interface DriveFile {
  id: string;
  name: string;
  description?: string;
  mimeType?: string;
  size?: string;
  webViewLink?: string;
  parents?: string[];
  appProperties?: Record<string, string>;
}

/** Drive caps appProperties key+value at 124 bytes; very long ids are replaced by a hash. */
function idTag(id: string): string {
  return id.length <= 100 ? id : `sha256:${createHash("sha256").update(id).digest("hex").slice(0, 40)}`;
}

function q(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function googleMessage(text: string): string {
  try {
    const body = JSON.parse(text) as { error?: { message?: string } | string };
    if (typeof body.error === "string") return body.error;
    if (body.error?.message) return body.error.message;
  } catch {
    // not JSON
  }
  return text.slice(0, 200) || "no detail";
}

function toBrokerError(status: number, text: string): BrokerError {
  const msg = googleMessage(text);
  if (status === 401) return new BrokerError(`Google refused the Drive service account (${msg})`, status, false, undefined, undefined, "bad_credential");
  if (status === 403 && /has not been used|is disabled|SERVICE_DISABLED|accessNotConfigured/i.test(msg)) {
    return new BrokerError(`The Drive API is not enabled for the service account's Google Cloud project (${msg})`, status, false, undefined, undefined, "api_disabled");
  }
  if (status === 403 || status === 404) {
    return new BrokerError(`The Drive service account cannot reach this Shared Drive or folder (${msg}). Add the service account to the Shared Drive as Content manager.`, status, false, undefined, undefined, "not_member");
  }
  if (status === 400) return new BrokerError(`Invalid request: ${msg}`, status, false);
  if (status === 429 || status >= 500) return new BrokerError(`Google Drive error: ${msg}`, status, true);
  return new BrokerError(`Google Drive error: ${msg}`, status, false);
}

export function createGoogleDriveBroker(
  fetchFn: GoogleFetch,
  key: ServiceAccountKey,
  sharedDriveId: string,
  opts: { now?: () => number } = {},
): Broker {
  if (!sharedDriveId || sharedDriveId.trim() === "") throw new DriveNotBoundError();
  const now = opts.now ?? Date.now;

  async function request(method: string, url: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}): Promise<{ status: number; text: string }> {
    let token: string;
    try {
      token = await serviceAccountToken(fetchFn, key, undefined, now());
    } catch (err) {
      if (err instanceof GoogleAuthError) throw new BrokerError(err.message, err.status === 400 ? 401 : err.status, err.status >= 500, undefined, undefined, "bad_credential");
      throw new BrokerError(`Network error getting a Google token: ${err instanceof Error ? err.message : String(err)}`, 500, true);
    }
    try {
      const res = await fetchFn(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(init.headers ?? {}) },
        body: init.body,
        signal: AbortSignal.timeout(30_000),
      });
      return { status: res.status, text: await res.text() };
    } catch (err) {
      throw new BrokerError(`Network error talking to Google Drive: ${err instanceof Error ? err.message : String(err)}`, 500, true);
    }
  }

  async function json<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await request(method, url, body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
    if (res.status < 200 || res.status >= 300) throw toBrokerError(res.status, res.text);
    return (res.text ? JSON.parse(res.text) : {}) as T;
  }

  const shared = "supportsAllDrives=true";
  const scoped = `${shared}&includeItemsFromAllDrives=true&corpora=drive&driveId=${encodeURIComponent(sharedDriveId)}`;

  async function list(query: string, fields: string, pageSize = 10): Promise<DriveFile[]> {
    const params = `q=${encodeURIComponent(query)}&fields=${encodeURIComponent(`files(${fields})`)}&pageSize=${pageSize}&orderBy=createdTime`;
    const body = await json<{ files?: DriveFile[] }>("GET", `${DRIVE}/files?${params}&${scoped}`);
    return body.files ?? [];
  }

  const toRegistry = (type: string, id: string, file: DriveFile): RegistryFolder => ({
    id: file.id,
    entity_type: type,
    entity_id: id,
    path: file.description || file.name,
    folder_id: file.id,
    folder_url: file.webViewLink ?? `https://drive.google.com/drive/folders/${file.id}`,
    complete: file.appProperties?.pibComplete === "1",
    ...(file.appProperties?.pibRun ? { created_by_run: file.appProperties.pibRun } : {}),
  });

  async function findRegistered(type: DriveEntityType, id: string): Promise<DriveFile | null> {
    const files = await list(
      `mimeType = '${FOLDER_MIME}' and trashed = false and appProperties has { key='pibEntityType' and value=${q(type)} } and appProperties has { key='pibEntityId' and value=${q(idTag(id))} }`,
      FOLDER_FIELDS,
    );
    return files[0] ?? null;
  }

  async function resolve(type: DriveEntityType, id: string): Promise<RegistryFolder | null> {
    // The marketing branch registers a project's leaf folder as a "campaign" (same id), so a project lookup finds that too.
    const file = (await findRegistered(type, id)) ?? (type === "project" ? await findRegistered("campaign", id) : null);
    return file ? toRegistry(type, id, file) : null;
  }

  async function createFolder(name: string, parentId: string, path: string, props: Record<string, string>): Promise<DriveFile> {
    return json<DriveFile>("POST", `${DRIVE}/files?${shared}&fields=${encodeURIComponent(FOLDER_FIELDS)}`, {
      name,
      mimeType: FOLDER_MIME,
      parents: [parentId],
      description: path,
      appProperties: props,
    });
  }

  /** A same-named, untagged folder under the parent (one the old broker made) is adopted, not duplicated. */
  async function findChildFolder(parentId: string, name: string): Promise<DriveFile | null> {
    const files = await list(`${q(parentId)} in parents and name = ${q(name)} and mimeType = '${FOLDER_MIME}' and trashed = false`, FOLDER_FIELDS);
    return files[0] ?? null;
  }

  async function ensure(body: EnsureBody): Promise<EnsureResult> {
    const { entity_type: type, entity_id: id, name } = body;
    let parentId = sharedDriveId;
    let parentPath = "";
    if (body.parent_entity_id) {
      const parent = await resolve(body.parent_entity_type ?? "crm_company", body.parent_entity_id);
      if (!parent) {
        throw new BrokerError(`Parent folder is not registered yet: ${body.parent_entity_type ?? "crm_company"} ${body.parent_entity_id}. Ensure the parent first.`, 409, false, undefined, undefined, "parent_missing");
      }
      parentId = parent.folder_id;
      parentPath = parent.path;
    }
    const path = parentPath ? `${parentPath}/${name}` : name;
    const wantsSubfolders = (body.subfolders ?? []).length > 0;
    // pibComplete marks a folder whose numbered sub-folders all exist; a folder that wants some gets it only after the last one.
    const tag: Record<string, string> = { pibEntityType: type, pibEntityId: idTag(body.entity_id), ...(wantsSubfolders ? {} : { pibComplete: "1" }), ...(body.created_by_run ? { pibRun: body.created_by_run.slice(0, 100) } : {}) };

    let folder = await findRegistered(type, id);
    let created = false;
    if (!folder) {
      const sameName = await findChildFolder(parentId, name);
      if (sameName && sameName.appProperties?.pibEntityType && sameName.appProperties.pibEntityType !== "subfolder") {
        throw new BrokerError(`Folder conflict: "${name}" under ${parentPath || "the Shared Drive root"} already belongs to ${sameName.appProperties.pibEntityType} ${sameName.appProperties.pibEntityId ?? ""}`, 409, false, sameName.id, path);
      }
      if (sameName) {
        folder = await json<DriveFile>("PATCH", `${DRIVE}/files/${sameName.id}?${shared}&fields=${encodeURIComponent(FOLDER_FIELDS)}`, { description: path, appProperties: tag });
      } else {
        folder = await createFolder(name, parentId, path, tag);
        created = true;
      }
    }

    let registered = toRegistry(type, id, folder);
    const tree: EnsureResult["tree"] = [];
    for (const sub of body.subfolders ?? []) {
      let child = await findChildFolder(folder.id, sub);
      let subCreated = false;
      if (!child) {
        child = await createFolder(sub, folder.id, `${registered.path}/${sub}`, { pibEntityType: "subfolder", pibEntityId: idTag(`${id}/${sub}`) });
        subCreated = true;
      }
      tree.push({ path: `${registered.path}/${sub}`, folderId: child.id, created: subCreated });
    }
    if (!wantsSubfolders && !registered.complete) {
      // A folder made before the tag existed (no sub-folders to wait for) is complete: say so once.
      const done = await json<DriveFile>("PATCH", `${DRIVE}/files/${folder.id}?${shared}&fields=${encodeURIComponent(FOLDER_FIELDS)}`, { appProperties: { pibComplete: "1" } });
      registered = toRegistry(type, id, { ...folder, ...done, appProperties: { ...folder.appProperties, ...done.appProperties } });
    }
    if (wantsSubfolders && !registered.complete) {
      const done = await json<DriveFile>("PATCH", `${DRIVE}/files/${folder.id}?${shared}&fields=${encodeURIComponent(FOLDER_FIELDS)}`, { appProperties: { pibComplete: "1" } });
      registered = toRegistry(type, id, { ...folder, ...done, appProperties: { ...folder.appProperties, ...done.appProperties } });
    }
    return { folder: registered, created, tree };
  }

  async function identity(overrideSharedDriveId?: string): Promise<IdentityResult> {
    const id = overrideSharedDriveId || sharedDriveId;
    const res = await request("GET", `${DRIVE}/drives/${encodeURIComponent(id)}?${shared}&fields=id,name,capabilities(canAddChildren,canEdit)`);
    if (res.status === 401) throw toBrokerError(res.status, res.text);
    if (res.status === 403 && /has not been used|is disabled|SERVICE_DISABLED|accessNotConfigured/i.test(googleMessage(res.text))) throw toBrokerError(res.status, res.text);
    if (res.status >= 500 || res.status === 429) throw toBrokerError(res.status, res.text);
    let isMember = false;
    if (res.status === 200) {
      const caps = (JSON.parse(res.text) as { capabilities?: { canAddChildren?: boolean } }).capabilities;
      isMember = caps?.canAddChildren === true;
    }
    return { serviceAccountEmail: key.clientEmail, isMember };
  }

  async function uploadFile(input: { name: string; bytes: Uint8Array; mimeType: string; parentFolderId?: string }): Promise<UploadResult> {
    if (input.bytes.byteLength > MAX_UPLOAD_BYTES) {
      throw new BrokerError(`File too large (${input.bytes.byteLength} bytes exceeds 5 MiB limit)`, 413, false, undefined, undefined, "too_large");
    }
    const parentId = input.parentFolderId || sharedDriveId;
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");

    const same = await list(`${q(parentId)} in parents and name = ${q(input.name)} and trashed = false`, "id,name,mimeType,size,webViewLink,parents,appProperties");
    const dup = same.find((f) => f.appProperties?.pibSha256 === sha256);
    if (dup) {
      return { fileId: dup.id, name: dup.name, mimeType: dup.mimeType ?? input.mimeType, size: Number(dup.size ?? input.bytes.byteLength), sha256, webViewLink: dup.webViewLink ?? `https://drive.google.com/file/d/${dup.id}/view`, parentFolderId: parentId, deduplicated: true };
    }

    const boundary = `pib-${createHash("sha256").update(`${sha256}${now()}`).digest("hex").slice(0, 24)}`;
    const metadata = JSON.stringify({ name: input.name, parents: [parentId], appProperties: { pibSha256: sha256 } });
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${input.mimeType}\r\n\r\n`),
      Buffer.from(input.bytes),
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const res = await request("POST", `${DRIVE_UPLOAD}/files?uploadType=multipart&${shared}&fields=${encodeURIComponent("id,name,mimeType,size,webViewLink,parents")}`, {
      body,
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    });
    if (res.status < 200 || res.status >= 300) throw toBrokerError(res.status, res.text);
    const file = JSON.parse(res.text) as DriveFile;
    if (typeof file.id !== "string") throw new BrokerError("Unexpected upload response", 200, false);
    return {
      fileId: file.id,
      name: file.name,
      mimeType: file.mimeType ?? input.mimeType,
      size: Number(file.size ?? input.bytes.byteLength),
      sha256,
      webViewLink: file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view`,
      parentFolderId: parentId,
      deduplicated: false,
    };
  }

  return { resolve, ensure, identity, uploadFile };
}
