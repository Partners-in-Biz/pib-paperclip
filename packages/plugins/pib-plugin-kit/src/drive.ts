/**
 * Drive save-request event route for producer plugins.
 * A producer calls `driveSave(ctx, opts)` to request a file save, optionally with a CRM subfolder and client context.
 * The CRM handles the upload and replies with `drive.file.saved` or `drive.file.failed`.
 */
import { createHash, randomUUID } from "node:crypto";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { CRM_PLUGIN_ID } from "./crm-projection.js";

export const DRIVE_EVENTS = {
  saveRequested: "drive.save-requested",
  saved: "drive.file.saved",
  failed: "drive.file.failed",
} as const;

export type DriveSaveResult =
  | { status: "saved"; requestId: string; driveFileId: string; url: string }
  | { status: "failed"; requestId: string; reason: string; hint?: string }
  | { status: "no_ack"; requestId: string };

export type DriveSaveOptions = {
  companyId: string;
  requestId?: string;
  kind: string;
  name: string;
  mimeType: string;
  timeoutMs?: number;
  subfolder?: string;
  client?: { kind: string; ref: string };
} & ({ bytes: Uint8Array | Buffer; publicUrl?: undefined } | { publicUrl: string; bytes?: undefined });

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BYTES = 5 * 1024 * 1024;
const pendingByCtx = new WeakMap<Pick<PluginContext, "events">, Map<string, { resolve: (r: DriveSaveResult) => void; companyId: string }>>();

export function registerDriveReplies(ctx: Pick<PluginContext, "events">): void {
  if (pendingByCtx.has(ctx)) return;
  pendingByCtx.set(ctx, new Map());

  const handleReply = async (event: PluginEvent, isSuccess: boolean) => {
    const pending = pendingByCtx.get(ctx);
    if (!pending) return;

    const payload = event.payload as { requestId?: string } | undefined;
    if (!payload || typeof payload.requestId !== "string") return;

    const { requestId } = payload;
    const resolver = pending.get(requestId);
    if (!resolver || resolver.companyId !== event.companyId) return;

    pending.delete(requestId);

    if (isSuccess) {
      const saved = payload as { requestId: string; driveFileId: string; url: string };
      resolver.resolve({ status: "saved", requestId, driveFileId: saved.driveFileId, url: saved.url });
    } else {
      const failed = payload as { requestId: string; status?: string; reason?: string; hint?: string };
      resolver.resolve({
        status: "failed",
        requestId,
        reason: typeof failed.reason === "string" ? failed.reason : typeof failed.status === "string" ? failed.status : "failed",
        hint: typeof failed.hint === "string" ? failed.hint : undefined,
      });
    }
  };

  ctx.events.on(`plugin.${CRM_PLUGIN_ID}.${DRIVE_EVENTS.saved}`, (event) => handleReply(event, true));
  ctx.events.on(`plugin.${CRM_PLUGIN_ID}.${DRIVE_EVENTS.failed}`, (event) => handleReply(event, false));
}

export async function driveSave(ctx: Pick<PluginContext, "events">, opts: DriveSaveOptions): Promise<DriveSaveResult> {
  try {
    const { companyId, kind, name, mimeType, timeoutMs, subfolder, client } = opts;
    const hasBytesOption = "bytes" in opts && opts.bytes !== undefined && opts.bytes !== null;
    const hasUrlOption = "publicUrl" in opts && opts.publicUrl !== undefined && opts.publicUrl !== null;
    const providedRequestId = opts.requestId;

    // Validate input: either bytes or publicUrl, not both or neither
    if (!(hasBytesOption || hasUrlOption)) {
      return { status: "failed", requestId: providedRequestId ?? "unknown", reason: "invalid_input" };
    }

    // Generate or validate requestId
    let requestId = providedRequestId;
    if (!requestId) {
      requestId = randomUUID().replace(/-/g, "");
    } else if (!/^[a-z0-9]+$/i.test(requestId)) {
      return { status: "failed", requestId, reason: "invalid_request_id" };
    }

    // Validate optional subfolder and client fields
    if (subfolder !== undefined && (typeof subfolder !== "string" || subfolder.trim().length === 0)) {
      return { status: "failed", requestId, reason: "invalid_input" };
    }
    if (client !== undefined) {
      if (!client || typeof client !== "object" || !("kind" in client) || !("ref" in client)) {
        return { status: "failed", requestId, reason: "invalid_input" };
      }
      if (typeof client.kind !== "string" || client.kind.trim().length === 0 || typeof client.ref !== "string" || client.ref.trim().length === 0) {
        return { status: "failed", requestId, reason: "invalid_input" };
      }
    }

    // Register handlers and check for duplicate
    registerDriveReplies(ctx);
    const pending = pendingByCtx.get(ctx)!;
    if (pending.has(requestId)) {
      return { status: "failed", requestId, reason: "duplicate_request_id" };
    }

    // Build payload
    let payload: Record<string, unknown> = { requestId, kind, name, mimeType };

    if (hasBytesOption) {
      const bytes = opts.bytes as Uint8Array | Buffer;
      if (bytes.length > MAX_BYTES) {
        return { status: "failed", requestId, reason: "too_large" };
      }
      payload.sha256 = createHash("sha256").update(bytes).digest("hex");
      payload.contentBase64 = Buffer.from(bytes).toString("base64");
    } else {
      const publicUrl = (opts as any).publicUrl as string;
      if (!publicUrl.startsWith("https://")) {
        return { status: "failed", requestId, reason: "invalid_input" };
      }
      payload.publicUrl = publicUrl;
    }

    // Add optional subfolder and client to payload
    if (subfolder && subfolder.trim().length > 0) {
      payload.subfolder = subfolder;
    }
    if (client && client.kind && client.ref) {
      payload.clientKind = client.kind;
      payload.clientRef = client.ref;
    }

    // Setup promise and handlers
    const tm = timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let settled = false;

    const resultPromise = new Promise<DriveSaveResult>((resolve) => {
      const settle = (result: DriveSaveResult) => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        pending.delete(requestId);
        resolve(result);
      };

      pending.set(requestId, { resolve: settle, companyId });

      timeoutHandle = setTimeout(() => {
        settle({ status: "no_ack", requestId });
      }, tm);

      // Emit, handling both sync throws and rejections
      Promise.resolve()
        .then(() => ctx.events.emit(DRIVE_EVENTS.saveRequested, companyId, payload))
        .catch((error) => {
          settle({ status: "failed", requestId, reason: "emit_failed", hint: error instanceof Error ? error.message : String(error) });
        });
    });

    return await resultPromise;
  } catch (error) {
    const providedRequestId = (opts as any).requestId;
    return { status: "failed", requestId: providedRequestId ?? "unknown", reason: "error" };
  }
}
