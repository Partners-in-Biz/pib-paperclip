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
} as const;

/** The CRM broker's file limit, the same as for saves. */
export const DRIVE_READ_MAX_BYTES = 5 * 1024 * 1024;

export interface DriveListedFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

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
const pendingByCtx = new WeakMap<Pick<PluginContext, "events">, { list: Pending; read: Pending }>();

function pendingFor(ctx: Pick<PluginContext, "events">) {
  const known = pendingByCtx.get(ctx);
  if (known) return known;
  const maps = { list: new Map(), read: new Map() } as { list: Pending; read: Pending };
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
  which: "list" | "read",
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
  return { id: f.id, name: f.name, mimeType: typeof f.mimeType === "string" ? f.mimeType : "application/octet-stream", size: Number(f.size) || 0 };
}

/** The files in the client's assets folders: name, type, size and id only. */
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
