/**
 * Drive save-request event route for producer plugins.
 * A producer calls `driveSave(ctx, opts)` to request a file save, optionally with a CRM subfolder and client context.
 * The CRM handles the upload and replies with `drive.file.saved` or `drive.file.failed`.
 */
import { createHash, randomUUID } from "node:crypto";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { CRM_PLUGIN_ID } from "./crm-projection.js";
import { DRIVE_INLINE_MAX_BYTES, DRIVE_TRANSFER_MAX_BYTES, isR2ObjectUrl, isSha256Hex } from "./drive-transfer.js";

export const DRIVE_EVENTS = {
  saveRequested: "drive.save-requested",
  saved: "drive.file.saved",
  failed: "drive.file.failed",
  /** A large transfer's bytes so far (PAR-8125): `{ requestId, bytesDone, bytesTotal }`. Each one restarts the wait. */
  progress: "drive.transfer.progress",
} as const;

/**
 * The plugins that may ask the CRM to write to a company's Drive (PAR-8114). The host delivers a plugin's emit as
 * `plugin.<emitterId>.<name>` and only supports a trailing wildcard, so the CRM subscribes once per producer here; a
 * plugin not on this list never reaches the Drive. Add a producer here before it calls `driveSave`.
 */
export const DRIVE_PRODUCER_PLUGINS = [
  "partnersinbiz.studio",
  "partnersinbiz.social",
  "partnersinbiz.campaigns",
  "partnersinbiz.ads",
  "partnersinbiz.billing",
  "partnersinbiz.cockpit",
  "partnersinbiz.seo",
  "partnersinbiz.crm",
] as const;

/** The name the host delivers a producer's request under: `plugin.<producerId>.<name>`. */
export function producerEventName(producerId: string, name: string): `plugin.${string}` {
  return `plugin.${producerId}.${name}`;
}

/**
 * The producer that sent `event` as `name`, from the host-set event type, or null when it is not a known producer.
 * The host builds the event type from the emitting plugin's own id, so a plugin cannot pose as another one.
 */
export function knownProducerOf(event: Pick<PluginEvent, "eventType">, name: string, producers: readonly string[] = DRIVE_PRODUCER_PLUGINS): string | null {
  const type = String(event.eventType ?? "");
  const suffix = `.${name}`;
  if (!type.startsWith("plugin.") || !type.endsWith(suffix)) return null;
  const id = type.slice("plugin.".length, type.length - suffix.length);
  return producers.includes(id) ? id : null;
}

export const DRIVE_SUBFOLDERS = ["01 Briefs", "02 Assets", "03 Deliverables", "04 Reports", "05 Evidence", "99 Archive"] as const;

export type DriveSubfolder = (typeof DRIVE_SUBFOLDERS)[number];

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
  subfolder?: DriveSubfolder;
  timeoutMs?: number;
  /** The CRM client the file belongs to: it lands in that client's linked project. */
  client?: { kind: string; ref: string };
  /**
   * The company's own work (PAR-8128): the file lands in the CRM's `drive.ownProjectId`. Must be asked for: a save with
   * no client, no `ownWork` and no `projectId` is refused, so a missing client is never filed as the company's own.
   */
  ownWork?: true;
  /**
   * The Paperclip project the work belongs to (e.g. an issue's project). The CRM files it in that project when the
   * project is linked to a client or is the own project, and refuses it otherwise. Wins over `client` and `ownWork`.
   */
  projectId?: string;
  /** Large transfers only: called on each progress reply from the CRM. */
  onProgress?: (progress: DriveTransferProgress) => void;
} & (
  | { bytes: Uint8Array | Buffer; publicUrl?: undefined; r2Url?: undefined }
  | { publicUrl: string; bytes?: undefined; r2Url?: undefined }
  /**
   * A file over 5 MiB (PAR-8125): a short-lived signed GET link to the object in R2, its exact size and sha256. The CRM
   * streams it to Drive. `timeoutMs` is then the longest wait between two progress replies, not for the whole transfer.
   * The link is a secret: never give it to an agent or log it.
   */
  | { r2Url: string; size: number; sha256: string; bytes?: undefined; publicUrl?: undefined }
);

export interface DriveTransferProgress {
  bytesDone: number;
  bytesTotal: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BYTES = DRIVE_INLINE_MAX_BYTES;
type Pending = { resolve: (r: DriveSaveResult) => void; companyId: string; progress?: (p: DriveTransferProgress) => void };
const pendingByCtx = new WeakMap<Pick<PluginContext, "events">, Map<string, Pending>>();

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

  const handleProgress = async (event: PluginEvent) => {
    const payload = event.payload as { requestId?: unknown; bytesDone?: unknown; bytesTotal?: unknown } | undefined;
    if (!payload || typeof payload.requestId !== "string") return;
    const entry = pendingByCtx.get(ctx)?.get(payload.requestId);
    if (!entry || entry.companyId !== event.companyId || !entry.progress) return;
    const bytesDone = Number(payload.bytesDone);
    const bytesTotal = Number(payload.bytesTotal);
    if (!Number.isFinite(bytesDone) || !Number.isFinite(bytesTotal)) return;
    entry.progress({ bytesDone, bytesTotal });
  };

  ctx.events.on(`plugin.${CRM_PLUGIN_ID}.${DRIVE_EVENTS.progress}`, (event) => handleProgress(event));
  ctx.events.on(`plugin.${CRM_PLUGIN_ID}.${DRIVE_EVENTS.saved}`, (event) => handleReply(event, true));
  ctx.events.on(`plugin.${CRM_PLUGIN_ID}.${DRIVE_EVENTS.failed}`, (event) => handleReply(event, false));
}

export async function driveSave(ctx: Pick<PluginContext, "events">, opts: DriveSaveOptions): Promise<DriveSaveResult> {
  try {
    const { companyId, kind, name, mimeType, timeoutMs, subfolder, client } = opts;
    const hasBytesOption = "bytes" in opts && opts.bytes !== undefined && opts.bytes !== null;
    const hasUrlOption = "publicUrl" in opts && opts.publicUrl !== undefined && opts.publicUrl !== null;
    const hasR2Option = "r2Url" in opts && opts.r2Url !== undefined && opts.r2Url !== null;
    const providedRequestId = opts.requestId;

    // Validate input: either bytes or publicUrl, not both or neither. A signed R2 link goes alone.
    if (hasR2Option && (hasBytesOption || hasUrlOption)) {
      return { status: "failed", requestId: providedRequestId ?? "unknown", reason: "invalid_input" };
    }
    if (!(hasBytesOption || hasUrlOption || hasR2Option)) {
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
    // A client's file and the company's own work are two different folders: never both.
    if (opts.ownWork !== undefined && (opts.ownWork !== true || client !== undefined)) {
      return { status: "failed", requestId, reason: "invalid_input" };
    }
    if (opts.projectId !== undefined && (typeof opts.projectId !== "string" || opts.projectId.trim().length === 0)) {
      return { status: "failed", requestId, reason: "invalid_input" };
    }

    // Register handlers and check for duplicate
    registerDriveReplies(ctx);
    const pending = pendingByCtx.get(ctx)!;
    if (pending.has(requestId)) {
      return { status: "failed", requestId, reason: "duplicate_request_id" };
    }

    // Build payload
    let payload: Record<string, unknown> = { requestId, kind, name, mimeType };

    if (opts.subfolder) {
      payload.subfolder = opts.subfolder;
    }

    if (hasBytesOption) {
      const bytes = opts.bytes as Uint8Array | Buffer;
      if (bytes.length > MAX_BYTES) {
        return { status: "failed", requestId, reason: "too_large" };
      }
      payload.sha256 = createHash("sha256").update(bytes).digest("hex");
      payload.contentBase64 = Buffer.from(bytes).toString("base64");
    } else if (hasR2Option) {
      const { r2Url, size, sha256 } = opts as { r2Url: unknown; size: unknown; sha256: unknown };
      // R2 hosts only: the CRM checks again before it fetches anything.
      if (!isR2ObjectUrl(r2Url) || !isSha256Hex(sha256) || typeof size !== "number" || !Number.isInteger(size) || size <= 0) {
        return { status: "failed", requestId, reason: "invalid_input" };
      }
      if (size > DRIVE_TRANSFER_MAX_BYTES) {
        return { status: "failed", requestId, reason: "too_large" };
      }
      payload.r2Url = r2Url;
      payload.size = size;
      payload.sha256 = sha256.toLowerCase();
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
    if (opts.ownWork === true) payload.ownWork = true;
    if (opts.projectId) payload.projectId = opts.projectId.trim();

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

      const arm = () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        timeoutHandle = setTimeout(() => {
          settle({ status: "no_ack", requestId });
        }, tm);
      };
      // A large transfer runs as long as it keeps moving: each progress reply restarts the wait.
      const progress = hasR2Option
        ? (p: DriveTransferProgress) => {
            if (settled) return;
            arm();
            try {
              opts.onProgress?.(p);
            } catch {
              // a caller's progress handler never ends the transfer
            }
          }
        : undefined;
      pending.set(requestId, { resolve: settle, companyId, ...(progress ? { progress } : {}) });

      arm();

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
