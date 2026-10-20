export type DriveEntityType = "project" | "crm_company" | "root" | "campaign";

export interface RegistryFolder {
  id: string;
  entity_type: string;
  entity_id: string;
  path: string;
  created_by_run?: string;
  folder_id: string;
  folder_url: string;
}

export interface EnsureBody {
  entity_type: DriveEntityType;
  entity_id: string;
  name: string;
  parent_entity_id?: string;
  parent_entity_type?: DriveEntityType;
  subfolders?: string[];
  created_by_run?: string;
}

export interface EnsureResult {
  folder: RegistryFolder;
  created: boolean;
  tree: Array<{ path: string; folderId: string; created: boolean }>;
}

export interface UploadResult {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  webViewLink: string;
  parentFolderId?: string;
  deduplicated: boolean;
}

export class BrokerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly folderId?: string,
    readonly path?: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "BrokerError";
  }
}

export class DriveNotBoundError extends Error {
  readonly code = "drive_not_bound" as const;
  constructor(message?: string) {
    super(message || "Drive not bound");
    this.name = "DriveNotBoundError";
  }
}

export interface Broker {
  resolve(type: DriveEntityType, id: string): Promise<RegistryFolder | null>;
  ensure(body: EnsureBody): Promise<EnsureResult>;
  uploadFile(input: { name: string; bytes: Uint8Array; mimeType: string; parentFolderId?: string }): Promise<UploadResult>;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

/** Upload transport: carries FormData which host stringifies bodies cannot handle.
 * UploadFetchLike is optional second arg to createBroker; defaults to global fetch.
 * Host architecture: ctx.http.fetch stringifies bodies, breaking binary multipart,
 * so plugins must provide separate transport for file uploads. A3 decides production transport. */
export type UploadFetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: FormData }) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

export function createBroker(
  fetchFn: FetchLike,
  cfg: { baseUrl: string; token: string; sharedDriveId: string },
  uploadFetch?: UploadFetchLike,
): Broker {
  if (!cfg.sharedDriveId || cfg.sharedDriveId.trim() === "") {
    throw new DriveNotBoundError();
  }

  const baseUrl = cfg.baseUrl.replace(/\/$/, "");
  const params = new URLSearchParams([["shared_drive_id", cfg.sharedDriveId]]);

  // Default uploadFetch wraps global fetch if not provided
  const uploadFetchFn = uploadFetch || (async (url: string, init: { method: string; headers: Record<string, string>; body: FormData }) => {
    const res = await fetch(url, init);
    return { status: res.status, ok: res.ok, text: () => res.text() };
  });

  async function resolve(type: DriveEntityType, id: string): Promise<RegistryFolder | null> {
    const url = `${baseUrl}/api/v1/workspace-folders/registry/resolve?${new URLSearchParams([["entity_type", type], ["entity_id", id], ["shared_drive_id", cfg.sharedDriveId]])}`;
    try {
      const res = await fetchFn(url, { method: "GET", headers: { Authorization: `Bearer ${cfg.token}` } });
      if (res.status === 404) return null;
      if (!res.ok) throw parseError(res.status, await res.text());
      const body = JSON.parse(await res.text()) as { data?: { folder: RegistryFolder }; folder?: RegistryFolder };
      const folder = body.data?.folder || body.folder;
      return folder || null;
    } catch (err) {
      if (err instanceof BrokerError) throw err;
      throw new BrokerError(`Network error during resolve: ${err instanceof Error ? err.message : String(err)}`, 500, true);
    }
  }

  async function ensure(body: EnsureBody): Promise<EnsureResult> {
    const url = `${baseUrl}/api/v1/workspace-folders/registry/ensure`;
    const postBody = { ...body, shared_drive_id: cfg.sharedDriveId };
    if (!body.created_by_run) delete (postBody as any).created_by_run;
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
        body: JSON.stringify(postBody),
      });
      if (!res.ok) throw parseError(res.status, await res.text());
      const responseBody = JSON.parse(await res.text()) as { data?: EnsureResult; folder?: RegistryFolder; created?: boolean; tree?: Array<{ path: string; folderId: string; created: boolean }> };
      const result = responseBody.data || (responseBody as EnsureResult);
      return { folder: result.folder as RegistryFolder, created: result.created === true, tree: result.tree || [] };
    } catch (err) {
      if (err instanceof BrokerError) throw err;
      throw new BrokerError(`Network error during ensure: ${err instanceof Error ? err.message : String(err)}`, 500, true);
    }
  }

  async function uploadFile(input: { name: string; bytes: Uint8Array; mimeType: string; parentFolderId?: string }): Promise<UploadResult> {
    // (1) Check sharedDriveId is not empty before any HTTP call
    if (!cfg.sharedDriveId || cfg.sharedDriveId.trim() === "") {
      throw new DriveNotBoundError();
    }

    // (2) Check file size before any HTTP call
    if (input.bytes.byteLength > 5 * 1024 * 1024) {
      throw new BrokerError(`File too large (${input.bytes.byteLength} bytes exceeds 5 MiB limit)`, 413, false, undefined, undefined, "too_large");
    }

    const url = `${baseUrl}/api/v1/workspace-broker/files/upload`;
    const form = new FormData();
    // Convert Uint8Array to Buffer for Blob construction to avoid SharedArrayBuffer type issues
    const buffer = Buffer.from(input.bytes);
    form.append("file", new Blob([buffer], { type: input.mimeType }), input.name);
    form.append("sharedDriveId", cfg.sharedDriveId);
    if (input.parentFolderId) form.append("parentFolderId", input.parentFolderId);
    form.append("name", input.name);

    try {
      const res = await uploadFetchFn(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.token}` },
        body: form,
      });

      if (!res.ok) throw parseError(res.status, await res.text());

      const responseBody = JSON.parse(await res.text()) as { success?: boolean; data?: any };
      const data = responseBody.data || responseBody;

      // Minimal validation of success body
      if (typeof data.fileId !== "string" || typeof data.webViewLink !== "string") {
        throw new BrokerError(`Unexpected upload response`, 200, false);
      }

      return {
        fileId: data.fileId,
        name: data.name,
        mimeType: data.mimeType,
        size: data.size,
        sha256: data.sha256,
        webViewLink: data.webViewLink,
        parentFolderId: data.parentFolderId,
        deduplicated: data.deduplicated || false,
      };
    } catch (err) {
      if (err instanceof BrokerError) throw err;
      if (err instanceof DriveNotBoundError) throw err;
      throw new BrokerError(
        `Network error during upload: ${err instanceof Error ? err.message : String(err)}`,
        500,
        true,
      );
    }
  }

  return { resolve, ensure, uploadFile };
}

function parseError(status: number, text: string): BrokerError {
  let msg = "Unknown error";
  let code: string | undefined;
  try {
    const body = JSON.parse(text) as { error?: string; code?: string; message?: string };
    if (body.error) msg = body.error;
    if (body.code) code = body.code;
    if (body.message) msg = body.message;
  } catch {
    msg = text.slice(0, 200);
  }

  const folderId = text.match(/\(folderId:\s*([^)]+)\)/)?.[1];
  const path = text.match(/\(path:\s*([^)]+)\)/)?.[1];

  switch (status) {
    case 400:
      return new BrokerError(`Invalid request: ${msg}`, status, false, undefined, undefined, code);
    case 401:
    case 403:
      return new BrokerError(`Broker rejected the credential`, status, false);
    case 409:
      return new BrokerError(`Folder conflict: ${msg}`, status, false);
    case 413:
      return new BrokerError(`File too large`, status, false, undefined, undefined, code || "too_large");
    case 503:
      return new BrokerError(`Broker not configured (Shared Drive)`, status, false);
    case 502:
      return new BrokerError(`Broker gateway error: ${msg}`, status, true, folderId, path);
    default:
      return new BrokerError(`Broker error: ${msg}`, status, true);
  }
}
