/**
 * Drive reads for producer plugins (PAR-8107): the request/reply routes behind the kit's `driveList` and `driveRead`.
 * A read only reaches the asked-for client's own assets folders (the project resolved the same way as a save), so a
 * file id from another client's folder, or from anywhere else on the Drive, is refused with `not_in_client_folder`.
 * The company comes from the event, never from the payload.
 */
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { DRIVE_READ_EVENTS } from "@partnersinbiz/pib-plugin-kit";
import { DriveNotBoundError, type Broker, type DriveFileInfo } from "./broker.js";
import { createBrokerForCompany, driveFolderEnsure, resolveProducerSaveProject } from "./tools.js";

export const READ_MAX_BYTES = 5 * 1024 * 1024;
const LIST_MAX = 200;
const FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;
/** Below a client folder the assets live in `Assets/...`; below a product folder in `Marketing assets/...`. */
const ASSET_ROOTS = ["Assets/", "Marketing assets/"];

export type ReadOutcome<T> = ({ status: "ok" } & T) | { status: string; hint?: string };
export type BrokerFor = (ctx: PluginContext, companyId: string) => Promise<Broker | null>;

interface Client {
  clientKind?: string;
  clientRef?: string;
}

async function brokerOf(ctx: PluginContext, companyId: string, brokerFor: BrokerFor): Promise<{ broker: Broker } | { status: string; hint?: string }> {
  try {
    const broker = await brokerFor(ctx, companyId);
    if (!broker) return { status: "drive_not_bound", hint: "Drive is not configured in the CRM settings." };
    if (!broker.listFiles || !broker.fileMeta || !broker.downloadFile) return { status: "not_supported", hint: "This Drive connection can't read files." };
    return { broker };
  } catch (e) {
    if (e instanceof DriveNotBoundError) return { status: "drive_not_bound", hint: "Bind Drive in CRM settings (drive.sharedDriveId)." };
    throw e;
  }
}

/** The folder ids a read may reach for this client: its assets sub-folders, or the folder itself when it has none. */
export async function assetFolderIds(ctx: PluginContext, companyId: string, client: Client): Promise<ReadOutcome<{ folderIds: string[] }>> {
  const projectId = await resolveProducerSaveProject(ctx, companyId, { kind: "marketing", clientKind: client.clientKind, clientRef: client.clientRef });
  if (!projectId) {
    return { status: "no_project", hint: client.clientRef ? "No project is linked to this client in the CRM." : "No project is set for the company's own Drive folder (drive.ownProjectId)." };
  }
  const viewer = { companyId, userId: null, agentId: null, role: null } as unknown as Parameters<typeof driveFolderEnsure>[1];
  let res: { status?: string; hint?: string; folder_id?: string; path?: string; tree?: Array<{ path?: string; folderId?: string }> };
  try {
    res = (await driveFolderEnsure(ctx, viewer, { entity_type: "project", entity_id: projectId, include_tree: true })) as typeof res;
  } catch (e) {
    return { status: "drive_not_bound", hint: e instanceof Error ? e.message : String(e) };
  }
  if (!res || typeof res !== "object") return { status: "invalid_input", hint: "Failed to resolve the folder" };
  if (res.status === "not_found") return { status: "project_not_found" };
  if (res.status !== "created" && res.status !== "exists") return { status: res.status ?? "invalid_input", hint: res.hint };
  if (!res.folder_id) return { status: "invalid_input", hint: "No folder_id from ensure result" };
  const tree = res.tree ?? [];
  if (tree.length === 0) return { status: "ok", folderIds: [res.folder_id] };
  const below = `${res.path}/`;
  const folderIds = tree
    .filter((e) => e.folderId && e.path?.startsWith(below) && ASSET_ROOTS.some((root) => e.path!.slice(below.length).startsWith(root)))
    .map((e) => e.folderId!);
  if (folderIds.length === 0) return { status: "no_assets_folder", hint: "This client's Drive folder has no Assets sub-folders." };
  return { status: "ok", folderIds };
}

const out = (f: DriveFileInfo) => ({ id: f.id, name: f.name, mimeType: f.mimeType, size: f.size });

export async function listAssetFiles(ctx: PluginContext, companyId: string, client: Client, brokerFor: BrokerFor = createBrokerForCompany): Promise<ReadOutcome<{ files: Array<ReturnType<typeof out>> }>> {
  const b = await brokerOf(ctx, companyId, brokerFor);
  if (!("broker" in b)) return b;
  const folders = await assetFolderIds(ctx, companyId, client);
  if (folders.status !== "ok" || !("folderIds" in folders)) return folders;
  const files: DriveFileInfo[] = [];
  for (const id of folders.folderIds) {
    if (files.length >= LIST_MAX) break;
    files.push(...(await b.broker.listFiles!(id)));
  }
  return { status: "ok", files: files.slice(0, LIST_MAX).map(out) };
}

export async function readAssetFile(
  ctx: PluginContext,
  companyId: string,
  client: Client,
  fileId: string,
  brokerFor: BrokerFor = createBrokerForCompany,
): Promise<ReadOutcome<{ file: ReturnType<typeof out>; contentBase64: string }>> {
  if (typeof fileId !== "string" || !FILE_ID.test(fileId)) return { status: "invalid_input", hint: "fileId is not a Drive file id" };
  const b = await brokerOf(ctx, companyId, brokerFor);
  if (!("broker" in b)) return b;
  const folders = await assetFolderIds(ctx, companyId, client);
  if (folders.status !== "ok" || !("folderIds" in folders)) return folders;
  const meta = await b.broker.fileMeta!(fileId);
  if (!meta) return { status: "not_found" };
  // The parent check is the whole access rule: only files directly in this client's assets folders.
  if (!meta.parents.some((p) => folders.folderIds.includes(p))) return { status: "not_in_client_folder", hint: "That file is not in this client's Drive assets folders." };
  if (meta.size > READ_MAX_BYTES) return { status: "too_large" };
  const bytes = await b.broker.downloadFile!(fileId, READ_MAX_BYTES);
  return { status: "ok", file: { ...out(meta), size: bytes.byteLength }, contentBase64: Buffer.from(bytes).toString("base64") };
}

function errorReason(e: unknown): { reason: string; hint: string } {
  const code = (e as { code?: unknown })?.code;
  return { reason: code === "too_large" ? "too_large" : "broker_error", hint: e instanceof Error ? e.message : String(e) };
}

/** The two event routes. Replies go out as `plugin.partnersinbiz.crm.<event>`, like the save route's. */
export function registerDriveReadRoutes(ctx: PluginContext, brokerFor: BrokerFor = createBrokerForCompany): void {
  const reply = (event: string, companyId: string, payload: Record<string, unknown>) => ctx.events.emit(`plugin.partnersinbiz.crm.${event}` as never, companyId, payload);
  const clientOf = (p: Record<string, unknown>): Client => ({
    clientKind: typeof p.clientKind === "string" ? p.clientKind : undefined,
    clientRef: typeof p.clientRef === "string" ? p.clientRef : undefined,
  });

  ctx.events.on(DRIVE_READ_EVENTS.listRequested as never, async (event: PluginEvent) => {
    const p = (event.payload as Record<string, unknown> | undefined) ?? {};
    const requestId = p.requestId;
    if (typeof requestId !== "string" || !requestId) return;
    try {
      const res = await listAssetFiles(ctx, event.companyId, clientOf(p), brokerFor);
      if (res.status === "ok" && "files" in res) await reply(DRIVE_READ_EVENTS.listed, event.companyId, { requestId, files: res.files });
      else await reply(DRIVE_READ_EVENTS.listFailed, event.companyId, { requestId, reason: res.status, hint: (res as { hint?: string }).hint });
    } catch (e) {
      ctx.logger.info("Drive list event handler failed", { requestId, error: e instanceof Error ? e.message : String(e) });
      await reply(DRIVE_READ_EVENTS.listFailed, event.companyId, { requestId, ...errorReason(e) }).catch(() => undefined);
    }
  });

  ctx.events.on(DRIVE_READ_EVENTS.readRequested as never, async (event: PluginEvent) => {
    const p = (event.payload as Record<string, unknown> | undefined) ?? {};
    const requestId = p.requestId;
    if (typeof requestId !== "string" || !requestId) return;
    try {
      const res = await readAssetFile(ctx, event.companyId, clientOf(p), String(p.fileId ?? ""), brokerFor);
      if (res.status === "ok" && "file" in res) await reply(DRIVE_READ_EVENTS.read, event.companyId, { requestId, file: res.file, contentBase64: res.contentBase64 });
      else await reply(DRIVE_READ_EVENTS.readFailed, event.companyId, { requestId, reason: res.status, hint: (res as { hint?: string }).hint });
    } catch (e) {
      ctx.logger.info("Drive read event handler failed", { requestId, error: e instanceof Error ? e.message : String(e) });
      await reply(DRIVE_READ_EVENTS.readFailed, event.companyId, { requestId, ...errorReason(e) }).catch(() => undefined);
    }
  });
}
