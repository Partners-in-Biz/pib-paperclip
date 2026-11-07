export type DriveEntityType = "project" | "crm_company" | "root" | "campaign";

export interface RegistryFolder {
  id: string;
  entity_type: string;
  entity_id: string;
  path: string;
  created_by_run?: string;
  /** False when the folder exists but its standard sub-folders were not all created (an interrupted ensure). Always set by the native broker; a missing value (a test double) is read as complete. */
  complete?: boolean;
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

export interface IdentityResult {
  serviceAccountEmail: string;
  isMember?: boolean;
}

/** What the CRM needs from Drive. The implementation is `google-broker.ts` (Google Drive v3, service account). */
export interface Broker {
  resolve(type: DriveEntityType, id: string): Promise<RegistryFolder | null>;
  ensure(body: EnsureBody): Promise<EnsureResult>;
  identity(sharedDriveId?: string): Promise<IdentityResult>;
  uploadFile(input: { name: string; bytes: Uint8Array; mimeType: string; parentFolderId?: string }): Promise<UploadResult>;
  /** Reads for producer plugins (PAR-8107). Optional: brokers without them refuse the read routes. */
  listFiles?(parentFolderId: string): Promise<DriveFileInfo[]>;
  /** null when the file is missing, trashed, or not on this company's Shared Drive. */
  fileMeta?(fileId: string): Promise<DriveFileInfo | null>;
  downloadFile?(fileId: string, maxBytes: number): Promise<Uint8Array>;
  /**
   * Drive's own preview of a file at about `px` wide (PAR-8124), fetched with the service account so no link leaves
   * the CRM. `allowed` sees the file's parents first; when it says no, nothing is fetched. null: no such file, or no preview.
   */
  thumbnail?(fileId: string, px: number, maxBytes: number, allowed: (parents: string[]) => boolean): Promise<DriveThumbnail | null>;
}

/** A Drive file as the read routes see it: no link, no owner. */
export interface DriveFileInfo {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  parents: string[];
  /** ISO time, when Drive gave one. */
  modifiedTime?: string;
}

export type DriveThumbnail = { status: "ok"; mimeType: string; bytes: Uint8Array } | { status: "not_in_client_folder" | "no_preview" | "too_large" };
