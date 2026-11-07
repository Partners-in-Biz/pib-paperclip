/**
 * Drive reads for producer plugins (PAR-8107): the request/reply routes behind the kit's `driveList` and `driveRead`.
 * A read only reaches the asked-for client's own assets folders (the project resolved the same way as a save), so a
 * file id from another client's folder, or from anywhere else on the Drive, is refused with `not_in_client_folder`.
 * The company comes from the event, never from the payload.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { DRIVE_PRODUCER_PLUGINS, DRIVE_READ_EVENTS, DRIVE_THUMB_SIZES, DRIVE_THUMBS_MAX, type DriveThumbSize } from "@partnersinbiz/pib-plugin-kit";
import { registerProducerRoute } from "./producer-route.js";
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

type Folders = { folderIds: string[]; labels: Record<string, string> };

/**
 * A picker asks for a page of previews every few seconds (PAR-8124). Each asks for the client's folders, which costs a
 * secret lookup and a Drive call; they are kept for two minutes per company and client, so one preview batch costs one
 * lookup. Only a found set is kept, never a refusal.
 */
const FOLDER_TTL_MS = 120_000;
const folderCache = new Map<string, { at: number; value: Folders }>();
export function clearAssetFolderCache(): void {
  folderCache.clear();
}

async function cachedAssetFolders(ctx: PluginContext, companyId: string, client: Client): Promise<ReadOutcome<Folders>> {
  const key = `${companyId}|${client.clientKind ?? ""}|${client.clientRef ?? ""}`;
  const hit = folderCache.get(key);
  if (hit && Date.now() - hit.at < FOLDER_TTL_MS) return { status: "ok", ...hit.value };
  const res = await assetFolderIds(ctx, companyId, client);
  if (res.status === "ok" && "folderIds" in res) {
    if (folderCache.size > 500) folderCache.clear();
    folderCache.set(key, { at: Date.now(), value: { folderIds: res.folderIds, labels: res.labels } });
  }
  return res;
}

/** The folder ids a read may reach for this client: its assets sub-folders, or the folder itself when it has none. */
export async function assetFolderIds(ctx: PluginContext, companyId: string, client: Client): Promise<ReadOutcome<Folders>> {
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
  if (tree.length === 0) return { status: "ok", folderIds: [res.folder_id], labels: { [res.folder_id]: "Drive folder" } };
  const below = `${res.path}/`;
  const assets = tree.filter((e) => e.folderId && e.path?.startsWith(below) && ASSET_ROOTS.some((root) => e.path!.slice(below.length).startsWith(root)));
  if (assets.length === 0) return { status: "no_assets_folder", hint: "This client's Drive folder has no Assets sub-folders." };
  // The label is the path below the client's folder ("Assets/Images"): the picker groups by it. No ids or links.
  return { status: "ok", folderIds: assets.map((e) => e.folderId!), labels: Object.fromEntries(assets.map((e) => [e.folderId!, e.path!.slice(below.length)])) };
}

const out = (f: DriveFileInfo) => ({ id: f.id, name: f.name, mimeType: f.mimeType, size: f.size });
const listed = (f: DriveFileInfo, labels: Record<string, string>) => {
  const folder = f.parents.map((p) => labels[p]).find((l) => typeof l === "string");
  return { ...out(f), ...(folder ? { folder } : {}), ...(f.modifiedTime ? { modifiedTime: f.modifiedTime } : {}) };
};

export async function listAssetFiles(ctx: PluginContext, companyId: string, client: Client, brokerFor: BrokerFor = createBrokerForCompany): Promise<ReadOutcome<{ files: Array<ReturnType<typeof listed>> }>> {
  const b = await brokerOf(ctx, companyId, brokerFor);
  if (!("broker" in b)) return b;
  // A fresh lookup: opening the picker is when a person expects a new folder to show up.
  folderCache.delete(`${companyId}|${client.clientKind ?? ""}|${client.clientRef ?? ""}`);
  const folders = await cachedAssetFolders(ctx, companyId, client);
  if (folders.status !== "ok" || !("folderIds" in folders)) return folders;
  // The folders are listed at the same time: one after the other took 9 to 20 s on live (PAR-8124).
  const perFolder = await Promise.all(folders.folderIds.map((id) => b.broker.listFiles!(id)));
  const files = perFolder.flat().slice(0, LIST_MAX);
  return { status: "ok", files: files.map((f) => listed(f, folders.labels)) };
}

export interface ThumbOut {
  id: string;
  mimeType?: string;
  contentBase64?: string;
  reason?: string;
}

/**
 * Previews for a person's picker (PAR-8124): Drive's own thumbnails, fetched here, for files directly in this client's
 * assets folders only (the same rule as a read). A file elsewhere gets `not_in_client_folder` and nothing is fetched.
 */
export async function thumbAssetFiles(
  ctx: PluginContext,
  companyId: string,
  client: Client,
  fileIds: unknown,
  size: unknown,
  brokerFor: BrokerFor = createBrokerForCompany,
): Promise<ReadOutcome<{ thumbs: ThumbOut[] }>> {
  if (!Array.isArray(fileIds) || fileIds.length === 0 || fileIds.length > DRIVE_THUMBS_MAX || !fileIds.every((id) => typeof id === "string" && FILE_ID.test(id))) {
    return { status: "invalid_input", hint: `Ask for 1 to ${DRIVE_THUMBS_MAX} Drive file ids.` };
  }
  const spec = DRIVE_THUMB_SIZES[(size === "large" ? "large" : "small") as DriveThumbSize];
  const b = await brokerOf(ctx, companyId, brokerFor);
  if (!("broker" in b)) return b;
  if (!b.broker.thumbnail) return { status: "not_supported", hint: "This Drive connection can't show previews." };
  const folders = await cachedAssetFolders(ctx, companyId, client);
  if (folders.status !== "ok" || !("folderIds" in folders)) return folders;
  const allowed = (parents: string[]) => parents.some((p) => folders.folderIds.includes(p));
  const ids = [...new Set(fileIds as string[])];
  const thumbs: ThumbOut[] = new Array(ids.length);
  // Six at a time, so a batch stays well inside the 30 s an action gets.
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const i = next++;
      const id = ids[i]!;
      try {
        const t = await b.broker.thumbnail!(id, spec.px, spec.maxBytes, allowed);
        thumbs[i] = !t ? { id, reason: "not_found" } : t.status === "ok" ? { id, mimeType: t.mimeType, contentBase64: Buffer.from(t.bytes).toString("base64") } : { id, reason: t.status };
      } catch (e) {
        thumbs[i] = { id, reason: errorReason(e).reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, ids.length) }, worker));
  return { status: "ok", thumbs };
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
  // A read always looks the folders up fresh: it copies bytes, so a just-unlinked client must stop it at once.
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

/**
 * The two event routes, through `registerProducerRoute` like the save route (PAR-8114): only known producers are
 * heard, the company is the host-set one from the event, and replies use bare names. The client comes from the
 * payload but is resolved inside that company only, and a read is limited to that client's assets folders.
 */
export function registerDriveReadRoutes(ctx: PluginContext, brokerFor: BrokerFor = createBrokerForCompany, producers: readonly string[] = DRIVE_PRODUCER_PLUGINS): void {
  const clientOf = (p: Record<string, unknown>): Client => ({
    clientKind: typeof p.clientKind === "string" ? p.clientKind : undefined,
    clientRef: typeof p.clientRef === "string" ? p.clientRef : undefined,
  });

  registerProducerRoute(
    ctx,
    DRIVE_READ_EVENTS.listRequested,
    async ({ producer, companyId, requestId, payload, reply }) => {
      try {
        const res = await listAssetFiles(ctx, companyId, clientOf(payload), brokerFor);
        if (res.status === "ok" && "files" in res) await reply(DRIVE_READ_EVENTS.listed, { files: res.files });
        else await reply(DRIVE_READ_EVENTS.listFailed, { reason: res.status, hint: (res as { hint?: string }).hint });
      } catch (e) {
        ctx.logger.info("Drive list event handler failed", { requestId, producer, error: e instanceof Error ? e.message : String(e) });
        await reply(DRIVE_READ_EVENTS.listFailed, errorReason(e)).catch(() => undefined);
      }
    },
    producers,
  );

  registerProducerRoute(
    ctx,
    DRIVE_READ_EVENTS.readRequested,
    async ({ producer, companyId, requestId, payload, reply }) => {
      try {
        const res = await readAssetFile(ctx, companyId, clientOf(payload), String(payload.fileId ?? ""), brokerFor);
        if (res.status === "ok" && "file" in res) await reply(DRIVE_READ_EVENTS.read, { file: res.file, contentBase64: res.contentBase64 });
        else await reply(DRIVE_READ_EVENTS.readFailed, { reason: res.status, hint: (res as { hint?: string }).hint });
      } catch (e) {
        ctx.logger.info("Drive read event handler failed", { requestId, producer, error: e instanceof Error ? e.message : String(e) });
        await reply(DRIVE_READ_EVENTS.readFailed, errorReason(e)).catch(() => undefined);
      }
    },
    producers,
  );

  registerProducerRoute(
    ctx,
    DRIVE_READ_EVENTS.thumbsRequested,
    async ({ producer, companyId, requestId, payload, reply }) => {
      try {
        const res = await thumbAssetFiles(ctx, companyId, clientOf(payload), payload.fileIds, payload.size, brokerFor);
        if (res.status === "ok" && "thumbs" in res) await reply(DRIVE_READ_EVENTS.thumbs, { thumbs: res.thumbs });
        else await reply(DRIVE_READ_EVENTS.thumbsFailed, { reason: res.status, hint: (res as { hint?: string }).hint });
      } catch (e) {
        ctx.logger.info("Drive thumbs event handler failed", { requestId, producer, error: e instanceof Error ? e.message : String(e) });
        await reply(DRIVE_READ_EVENTS.thumbsFailed, errorReason(e)).catch(() => undefined);
      }
    },
    producers,
  );
}
