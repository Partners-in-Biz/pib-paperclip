import { createHash } from "node:crypto";
import type { UploadFetchLike } from "../../src/drive/broker.js";

export interface FakeBrokerState {
  files: Map<string, { fileId: string; name: string; mimeType: string; size: number; sha256: string; sharedDriveId: string; parentFolderId?: string }>;
  requests: Array<{ sha256: string; sharedDriveId: string; parentFolderId?: string }>;
}

export function createFakeBroker(opts?: { failWith?: number; token?: string }) {
  const token = opts?.token || "fake-token";
  const state: FakeBrokerState = {
    files: new Map(),
    requests: [],
  };

  const uploadFetch: UploadFetchLike = async (url: string, init: { method: string; headers: Record<string, string>; body: FormData }) => {
    // Check Bearer token
    const authHeader = init.headers.Authorization || "";
    if (!authHeader.startsWith(`Bearer ${token}`)) {
      return {
        status: 401,
        ok: false,
        text: async () => JSON.stringify({ error: "Unauthorized", code: "unauthorized" }),
      };
    }

    // Parse FormData
    let fileData: Uint8Array | undefined;
    let fileName: string | undefined;
    let mimeType: string | undefined;
    let sharedDriveId: string | undefined;
    let parentFolderId: string | undefined;

    // FormData iteration is async in Node 18+
    for (const [key, value] of init.body) {
      if (key === "file") {
        // value is a File/Blob
        const blob = value as Blob;
        fileData = new Uint8Array(await blob.arrayBuffer());
        mimeType = blob.type;
        fileName = (value as any).name || "file";
      } else if (key === "sharedDriveId") {
        sharedDriveId = String(value);
      } else if (key === "parentFolderId") {
        parentFolderId = String(value);
      } else if (key === "name") {
        fileName = String(value);
      }
    }

    // Validate required fields
    if (!fileData) {
      return {
        status: 400,
        ok: false,
        text: async () => JSON.stringify({ error: "file_required", code: "file_required" }),
      };
    }

    if (!sharedDriveId) {
      return {
        status: 400,
        ok: false,
        text: async () => JSON.stringify({ error: "shared_drive_required", code: "shared_drive_required" }),
      };
    }

    // Check file size (5 MiB = 5242880 bytes)
    if (fileData.byteLength > 5 * 1024 * 1024) {
      return {
        status: 413,
        ok: false,
        text: async () => JSON.stringify({ error: "File too large", code: "too_large" }),
      };
    }

    // Force status if set
    if (opts?.failWith) {
      return {
        status: opts.failWith,
        ok: false,
        text: async () => JSON.stringify({ error: `Server error ${opts.failWith}`, code: `error_${opts.failWith}` }),
      };
    }

    // Compute SHA256
    const sha256 = createHash("sha256").update(fileData).digest("hex");

    // Track request
    state.requests.push({ sha256, sharedDriveId, parentFolderId });

    // Check for deduplication: sharedDriveId + parentFolderId + name + sha256
    const dedupKey = `${sharedDriveId}:${parentFolderId || ""}:${fileName}:${sha256}`;
    const existing = Array.from(state.files.values()).find(
      (f) => f.sharedDriveId === sharedDriveId && f.parentFolderId === parentFolderId && f.name === fileName && f.sha256 === sha256
    );

    if (existing) {
      return {
        status: 200,
        ok: true,
        text: async () =>
          JSON.stringify({
            success: true,
            data: {
              fileId: existing.fileId,
              name: existing.name,
              mimeType: existing.mimeType,
              size: existing.size,
              sha256: existing.sha256,
              webViewLink: `https://drive.google.com/file/d/${existing.fileId}/view`,
              sharedDriveId: existing.sharedDriveId,
              parentFolderId: existing.parentFolderId,
              deduplicated: true,
            },
          }),
      };
    }

    // Store new file
    const fileId = `file_${state.files.size + 1}`;
    state.files.set(dedupKey, {
      fileId,
      name: fileName || "file",
      mimeType: mimeType || "application/octet-stream",
      size: fileData.byteLength,
      sha256,
      sharedDriveId,
      parentFolderId,
    });

    return {
      status: 200,
      ok: true,
      text: async () =>
        JSON.stringify({
          success: true,
          data: {
            fileId,
            name: fileName,
            mimeType: mimeType || "application/octet-stream",
            size: fileData.byteLength,
            sha256,
            webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
            sharedDriveId,
            parentFolderId,
            deduplicated: false,
          },
        }),
    };
  };

  const fetch: (url: string, init: any) => Promise<{ status: number; ok: boolean; text(): Promise<string> }> = async (url, init) => {
    return { status: 404, ok: false, text: async () => "{}" };
  };

  return { uploadFetch, fetch, state };
}
