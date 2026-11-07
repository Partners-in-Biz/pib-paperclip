/**
 * Drive read routes for producer plugins (PAR-8107), next to `driveSave`.
 * `driveList` lists the files in a client's assets folders; `driveRead` returns the bytes of one file there.
 * The CRM answers each request once, on its own reply events. The CRM only reaches the asked-for client's own
 * folders, so a file in another client's folder is refused there, whatever the caller sends.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { CRM_PLUGIN_ID } from "./crm-projection.js";

export const DRIVE_READ_EVENTS = {
  listRequested: "drive.list-requested",
  listed: "drive.files.listed",
  listFailed: "drive.list.failed",
  readRequested: "drive.read-requested",
  read: "drive.file.read",
  readFailed: "drive.read.failed",
  /** Drive's previews of up to DRIVE_THUMBS_MAX files, for a person's picker (PAR-8124). */
  thumbsRequested: "drive.thumbs-requested",
  thumbs: "drive.thumbs.read",
  thumbsFailed: "drive.thumbs.failed",
} as const;

/** The CRM broker's file limit, the same as for saves. */
export const DRIVE_READ_MAX_BYTES = 5 * 1024 * 1024;
/** Files per thumbnail request, and the byte cap of one preview per size. */
export const DRIVE_THUMBS_MAX = 24;
export const DRIVE_THUMB_SIZES = { small: { px: 320, maxBytes: 150 * 1024 }, large: { px: 1024, maxBytes: 800 * 1024 } } as const;
export type DriveThumbSize = keyof typeof DRIVE_THUMB_SIZES;

export interface DriveListedFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  /** The folder below the client's folder, e.g. "Assets/Images", when the CRM gave one. */
  folder?: string;
  /** ISO time of the last change in Drive, when the CRM gave one. */
  modifiedTime?: string;
}

/** One file's preview: the image, or why there is none (`no_preview`, `not_in_client_folder`, `too_large`, ...). */
export type DriveThumb = { id: string; mimeType: string; bytes: Uint8Array } | { id: string; reason: string };
export type DriveThumbsResult = { status: "thumbs"; requestId: string; thumbs: DriveThumb[] } | DriveFailure;

export type DriveFailure = { status: "failed"; requestId: string; reason: string; hint?: string } | { status: "no_ack"; requestId: string };
export type DriveListResult = { status: "listed"; requestId: string; files: DriveListedFile[] } | DriveFailure;
export type DriveReadResult = { status: "read"; requestId: string; file: DriveListedFile; bytes: Uint8Array } | DriveFailure;

export interface DriveReadTarget {
  companyId: string;
  /** The client whose folder is read. Omit for the company's own work. */
  client?: { kind: string; ref: string };
  requestId?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
type Pending = Map<string, { resolve: (ok: boolean, payload: Record<string, unknown>) => void; companyId: string }>;
type Which = "list" | "read" | "thumbs";
const pendingByCtx = new WeakMap<Pick<PluginContext, "events">, Record<Which, Pending>>();

function pendingFor(ctx: Pick<PluginContext, "events">) {
  const known = pendingByCtx.get(ctx);
  if (known) return known;
  const maps: Record<Which, Pending> = { list: new Map(), read: new Map(), thumbs: new Map() };
  pendingByCtx.set(ctx, maps);
  const on = (event: string, pending: Pending, ok: boolean) =>
    ctx.events.on(`plugin.${CRM_PLUGIN_ID}.${event}` as never, async (e: PluginEvent) => {
      const payload = (e.payload ?? {}) as Record<string, unknown>;
      if (typeof payload.requestId !== "string") return;
      const entry = pending.get(payload.requestId);
      // A reply for another company is never taken for this one.
      if (!entry || entry.companyId !== e.companyId) return;
      pending.delete(payload.requestId);
      entry.resolve(ok, payload);
    });
  on(DRIVE_READ_EVENTS.listed, maps.list, true);
  on(DRIVE_READ_EVENTS.listFailed, maps.list, false);
  on(DRIVE_READ_EVENTS.read, maps.read, true);
  on(DRIVE_READ_EVENTS.readFailed, maps.read, false);
  on(DRIVE_READ_EVENTS.thumbs, maps.thumbs, true);
  on(DRIVE_READ_EVENTS.thumbsFailed, maps.thumbs, false);
  return maps;
}

/** Subscribe to the CRM's read replies at setup, so the first request doesn't subscribe mid-action. Idempotent. */
export function registerDriveReadReplies(ctx: Pick<PluginContext, "events">): void {
  pendingFor(ctx);
}

function validTarget(t: DriveReadTarget): string | null {
  if (!t.companyId) return "invalid_input";
  if (t.requestId !== undefined && !/^[a-z0-9]+$/i.test(t.requestId)) return "invalid_request_id";
  if (t.client !== undefined && (!t.client || typeof t.client.kind !== "string" || !t.client.kind.trim() || typeof t.client.ref !== "string" || !t.client.ref.trim())) return "invalid_input";
  return null;
}

async function request(
  ctx: Pick<PluginContext, "events">,
  which: Which,
  event: string,
  t: DriveReadTarget,
  extra: Record<string, unknown>,
): Promise<{ ok: true; requestId: string; payload: Record<string, unknown> } | DriveFailure> {
  const requestId = t.requestId ?? randomUUID().replace(/-/g, "");
  const bad = validTarget(t);
  if (bad) return { status: "failed", requestId, reason: bad };
  const pending = pendingFor(ctx)[which];
  if (pending.has(requestId)) return { status: "failed", requestId, reason: "duplicate_request_id" };
  const payload: Record<string, unknown> = { requestId, ...extra };
  if (t.client) {
    payload.clientKind = t.client.kind;
    payload.clientRef = t.client.ref;
  }
  return await new Promise((resolve) => {
    let settled = false;
    const settle = (result: { ok: true; requestId: string; payload: Record<string, unknown> } | DriveFailure) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pending.delete(requestId);
      resolve(result);
    };
    const timer = setTimeout(() => settle({ status: "no_ack", requestId }), t.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    pending.set(requestId, {
      companyId: t.companyId,
      resolve: (ok, p) =>
        settle(ok ? { ok: true, requestId, payload: p } : { status: "failed", requestId, reason: typeof p.reason === "string" ? p.reason : "failed", hint: typeof p.hint === "string" ? p.hint : undefined }),
    });
    Promise.resolve()
      .then(() => ctx.events.emit(event as never, t.companyId, payload))
      .catch((error) => settle({ status: "failed", requestId, reason: "emit_failed", hint: error instanceof Error ? error.message : String(error) }));
  });
}

function listedFile(value: unknown): DriveListedFile | null {
  const f = value as Partial<DriveListedFile> | null;
  if (!f || typeof f.id !== "string" || typeof f.name !== "string") return null;
  return {
    id: f.id,
    name: f.name,
    mimeType: typeof f.mimeType === "string" ? f.mimeType : "application/octet-stream",
    size: Number(f.size) || 0,
    ...(typeof f.folder === "string" ? { folder: f.folder } : {}),
    ...(typeof f.modifiedTime === "string" ? { modifiedTime: f.modifiedTime } : {}),
  };
}

/** The files in the client's assets folders: id, name, type, size, and the folder and last change when known. No links. */
export async function driveList(ctx: Pick<PluginContext, "events">, t: DriveReadTarget): Promise<DriveListResult> {
  const out = await request(ctx, "list", DRIVE_READ_EVENTS.listRequested, t, {});
  if (!("ok" in out)) return out;
  const files = Array.isArray(out.payload.files) ? out.payload.files.map(listedFile).filter((f): f is DriveListedFile => f !== null) : [];
  return { status: "listed", requestId: out.requestId, files };
}

/** The bytes of one file in the client's assets folders (up to 5 MiB). */
export async function driveRead(ctx: Pick<PluginContext, "events">, t: DriveReadTarget & { fileId: string }): Promise<DriveReadResult> {
  const requestId = t.requestId ?? randomUUID().replace(/-/g, "");
  if (typeof t.fileId !== "string" || !/^[A-Za-z0-9_-]{10,200}$/.test(t.fileId)) return { status: "failed", requestId, reason: "invalid_input" };
  const out = await request(ctx, "read", DRIVE_READ_EVENTS.readRequested, { ...t, requestId }, { fileId: t.fileId });
  if (!("ok" in out)) return out;
  const file = listedFile(out.payload.file);
  if (!file || typeof out.payload.contentBase64 !== "string") return { status: "failed", requestId, reason: "bad_reply" };
  const bytes = new Uint8Array(Buffer.from(out.payload.contentBase64, "base64"));
  if (bytes.byteLength > DRIVE_READ_MAX_BYTES) return { status: "failed", requestId, reason: "too_large" };
  if (file.id !== t.fileId) return { status: "failed", requestId, reason: "bad_reply" };
  return { status: "read", requestId, file: { ...file, size: bytes.byteLength }, bytes };
}

const FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;
const THUMB_MIME = /^image\/(jpeg|png|webp|gif)$/;

/**
 * Drive's own previews of up to DRIVE_THUMBS_MAX files in the client's assets folders (PAR-8124), small (320 px) or
 * large (1024 px). The CRM fetches them, so no Drive link or token reaches the caller; a file outside the client's
 * folders comes back with a reason and no image.
 */
export async function driveThumbs(ctx: Pick<PluginContext, "events">, t: DriveReadTarget & { fileIds: string[]; size?: DriveThumbSize }): Promise<DriveThumbsResult> {
  const requestId = t.requestId ?? randomUUID().replace(/-/g, "");
  const size: DriveThumbSize = t.size === "large" ? "large" : "small";
  if (!Array.isArray(t.fileIds) || t.fileIds.length === 0 || t.fileIds.length > DRIVE_THUMBS_MAX || !t.fileIds.every((id) => typeof id === "string" && FILE_ID.test(id))) {
    return { status: "failed", requestId, reason: "invalid_input" };
  }
  const asked = new Set(t.fileIds);
  const out = await request(ctx, "thumbs", DRIVE_READ_EVENTS.thumbsRequested, { ...t, requestId }, { fileIds: [...asked], size });
  if (!("ok" in out)) return out;
  const cap = DRIVE_THUMB_SIZES[size].maxBytes;
  const thumbs: DriveThumb[] = [];
  for (const raw of Array.isArray(out.payload.thumbs) ? out.payload.thumbs : []) {
    const x = raw as { id?: unknown; mimeType?: unknown; contentBase64?: unknown; reason?: unknown } | null;
    // Only files that were asked for, once each.
    if (!x || typeof x.id !== "string" || !asked.delete(x.id)) continue;
    if (typeof x.contentBase64 === "string" && typeof x.mimeType === "string" && THUMB_MIME.test(x.mimeType)) {
      const bytes = new Uint8Array(Buffer.from(x.contentBase64, "base64"));
      thumbs.push(bytes.byteLength > 0 && bytes.byteLength <= cap ? { id: x.id, mimeType: x.mimeType, bytes } : { id: x.id, reason: "too_large" });
    } else thumbs.push({ id: x.id, reason: typeof x.reason === "string" ? x.reason : "no_preview" });
  }
  for (const id of asked) thumbs.push({ id, reason: "no_reply" });
  return { status: "thumbs", requestId: out.requestId, thumbs };
}
