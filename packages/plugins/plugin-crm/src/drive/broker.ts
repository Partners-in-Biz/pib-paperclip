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
}
