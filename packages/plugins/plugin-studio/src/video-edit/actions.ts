/**
 * The video edit actions (PAR-8276 A8a): create (optionally from library assets, probing their length), get, list,
 * apply ops, render, render status and cancel. The worker registers them as page actions; A8b exposes the same
 * functions as agent tools. Every asset a timeline names must be in the edit's company AND client: the store checks
 * that on every save, and a render checks it again, because an asset can move to another client after a save.
 * A render snapshots the saved document into `video_renders`; later saves do not change a queued render.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { sameClient, scopeOfRow, type ClientScope } from "@partnersinbiz/pib-plugin-kit";
import { StudioConfig } from "../config.js";
import { num, table } from "../db.js";
import { StudioError } from "../errors.js";
import { scopeForWork, scopeInput } from "../scope.js";
import { objectUrl } from "../storage.js";
import { applyOps } from "./ops.js";
import { probeMedia, type ProbeResult } from "./probe.js";
import { cancelRender, enqueueRender, getRender, type RenderJob } from "./render-queue.js";
import { assertAssets, createVideoEdit, editAssetIds, getVideoEdit, listVideoEdits, MAX_EDIT_TITLE, saveVideoEdit, type EditActor } from "./store.js";
import { editDuration, LIMITS, normalizeEdit } from "./timeline.js";

/** At most this many assets in one "create from assets" call. */
export const MAX_START_ASSETS = 20;
/** A still image placed on the timeline from "create from assets" shows this long. */
export const IMAGE_SECONDS = 3;
/** Queued renders one company may have waiting at once: the VPS renders one at a time. */
export const MAX_QUEUED_RENDERS = 5;
const PROBE_URL_SECONDS = 600;

/** What create-from-assets needs to know about one library asset. */
export interface StartAsset {
  id: string;
  kind: string;
  version: number;
  r2Key: string;
  clientKind: string | null;
  clientRef: string | null;
  /** The library name, used as the edit's title when the caller gives none. */
  name: string | null;
}

export interface ActionDeps {
  /** Probes one asset's current file. Tests replace it; the default probes a short-lived signed GET URL. */
  probe?: (asset: StartAsset) => Promise<ProbeResult>;
}

function bad(message: string, code = "bad_edit"): never {
  throw new StudioError(message, code);
}

function id(value: unknown): string {
  return String(value ?? "").trim();
}

function defaultProbe(ctx: PluginContext, companyId: string): (asset: StartAsset) => Promise<ProbeResult> {
  const config = new StudioConfig(ctx, companyId); // one per request: each costs a secret lookup
  return async (asset) => probeMedia(objectUrl(await config.bucket(), companyId, "GET", asset.r2Key, PROBE_URL_SECONDS));
}

function assetIdList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) bad("assetIds must be a list of Studio asset ids.");
  const ids = [...new Set(value.map(id))];
  if (ids.some((x) => !x)) bad("assetIds has an empty id.");
  if (ids.length > MAX_START_ASSETS) bad(`Start an edit from at most ${MAX_START_ASSETS} assets.`);
  return ids;
}

/** The assets in this company, in the order asked for. A missing one (or one of another company) is refused. */
async function startAssets(ctx: PluginContext, companyId: string, ids: string[]): Promise<StartAsset[]> {
  const marks = ids.map((_, i) => `$${i + 2}`).join(", ");
  const rows = await ctx.db.query<{ id: string; kind: string; current_version: unknown; r2_key: string; client_kind: string | null; client_ref: string | null; name: string | null }>(
    `SELECT a.id, a.kind, a.current_version, a.client_kind, a.client_ref, a.name, v.r2_key
     FROM ${table(ctx, "assets")} a JOIN ${table(ctx, "asset_versions")} v ON v.asset_id = a.id AND v.version = a.current_version
     WHERE a.company_id = $1 AND a.id IN (${marks})`,
    [companyId, ...ids],
  );
  const found = new Map(rows.map((r) => [r.id, r]));
  return ids.map((assetId) => {
    const r = found.get(assetId);
    if (!r) bad(`Asset ${assetId} is not in this company's Studio library.`);
    return { id: r.id, kind: r.kind, version: num(r.current_version), r2Key: r.r2_key, clientKind: r.client_kind, clientRef: r.client_ref, name: r.name };
  });
}

/** One timeline from the assets, back to back: pictures and videos on a video track, sound-only files on an audio track. */
async function timelineFrom(assets: StartAsset[], probe: (asset: StartAsset) => Promise<ProbeResult>, project: unknown) {
  const video: Record<string, unknown>[] = [];
  const audio: Record<string, unknown>[] = [];
  let videoAt = 0;
  let audioAt = 0;
  for (const [i, asset] of assets.entries()) {
    let length: number;
    let onAudio = false;
    if (asset.kind === "image") length = IMAGE_SECONDS;
    else if (asset.kind === "video") {
      const p = await probe(asset);
      if (!p.hasVideo && !p.hasAudio) bad(`Asset ${asset.id} has no picture or sound Studio can use.`);
      onAudio = !p.hasVideo;
      length = Math.floor(p.durationSec * 1000) / 1000;
      if (!(length > 0)) bad(`Asset ${asset.id} has no length.`);
    } else bad(`Asset ${asset.id} is a ${asset.kind}; a video edit takes pictures, videos and sound.`);
    const at = onAudio ? audioAt : videoAt;
    const room = Math.round((LIMITS.maxDuration - at) * 1000) / 1000;
    if (room <= 0) bad(`These assets are longer than ${LIMITS.maxDuration} s together, the most one edit can be. Start from fewer.`, "too_long");
    const out = Math.min(length, room);
    const clip = { id: `clip-${i + 1}`, assetId: asset.id, version: asset.version, in: 0, out, start: at };
    if (onAudio) {
      audio.push(clip);
      audioAt = Math.round((at + out) * 1000) / 1000;
    } else {
      video.push(clip);
      videoAt = Math.round((at + out) * 1000) / 1000;
    }
  }
  const tracks = [{ id: "video", kind: "video", clips: video }];
  if (audio.length) tracks.push({ id: "audio", kind: "audio", clips: audio });
  return normalizeEdit({ project: project ?? undefined, tracks });
}

/** `video-edit-create`: an empty edit, a given `doc`, or one built from `assetIds` (their lengths are probed). */
export async function createEditAction(ctx: PluginContext, companyId: string, params: Record<string, unknown>, actor: EditActor, deps: ActionDeps = {}) {
  const ids = assetIdList(params.assetIds);
  if (!ids.length) return createVideoEdit(ctx, companyId, params, actor);
  if (params.doc !== undefined) bad("Give either assetIds or doc, not both.");
  // Check company and client before probing anything: a foreign asset is never opened.
  const assets = await startAssets(ctx, companyId, ids);
  const projectId = typeof params.projectId === "string" && params.projectId.trim() ? params.projectId.trim() : null;
  const where = await scopeForWork(ctx, companyId, scopeInput(params), projectId);
  for (const a of assets) {
    if (!sameClient(scopeOfRow({ client_kind: a.clientKind, client_ref: a.clientRef }), where.scope)) bad(`Asset ${a.id} belongs to another client than this video edit.`);
  }
  const doc = await timelineFrom(assets, deps.probe ?? defaultProbe(ctx, companyId), params.project);
  // The Library's "Edit video" button sends no title: name the edit after its first asset.
  const title = typeof params.title === "string" && params.title.trim() ? params.title : `${(assets[0].name ?? "").trim() || "Video"} edit`.slice(0, MAX_EDIT_TITLE);
  const edit = await createVideoEdit(ctx, companyId, { ...params, title, doc, sourceAssetId: params.sourceAssetId ?? ids[0] }, actor);
  ctx.logger.info("Studio video edit created from assets", { companyId, editId: edit.id, assets: ids.length, by: actor.agentId ?? actor.userId ?? null });
  return edit;
}

export const getEditAction = (ctx: PluginContext, companyId: string, params: Record<string, unknown>) => getVideoEdit(ctx, companyId, id(params.editId));

export const listEditsAction = (ctx: PluginContext, companyId: string, params: Record<string, unknown>) => listVideoEdits(ctx, companyId, params).then((edits) => ({ edits }));

function conflict(revision: number): never {
  throw new StudioError(`Someone saved this video edit since you opened it (now revision ${revision}). Reload to see their changes.`, "edit_conflict");
}

function baseRevision(value: unknown): number {
  const base = Number(value);
  if (!Number.isInteger(base) || base < 1) bad("baseRevision is required: the revision these changes start from.");
  return base;
}

/** `video-edit-apply-ops`: applies `ops` (ops.ts) to the saved edit at `baseRevision`, all or nothing, and saves. */
export async function applyOpsAction(ctx: PluginContext, companyId: string, params: Record<string, unknown>, actor: EditActor) {
  const base = baseRevision(params.baseRevision);
  const edit = await getVideoEdit(ctx, companyId, id(params.editId));
  if (edit.revision !== base) conflict(edit.revision);
  const doc = applyOps(edit.doc, Array.isArray(params.ops) ? params.ops : (params.ops as unknown[]));
  // saveVideoEdit checks every asset against the edit's company and client, and refuses a save that lost a race.
  const saved = await saveVideoEdit(ctx, companyId, { editId: edit.id, baseRevision: base, doc }, actor);
  return { ...saved, duration: editDuration(doc), doc };
}

/** The render as people and agents see it: without the document copy and the process details. */
function renderOut(r: RenderJob) {
  return {
    id: r.id,
    editId: r.editId,
    editRevision: r.editRevision,
    preset: r.preset,
    status: r.status,
    attempts: r.attempts,
    assetId: r.assetId,
    hasPreview: Boolean(r.previewR2Key),
    error: r.error,
    errorKind: r.errorKind,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    createdAt: r.createdAt,
  };
}

/** `video-edit-render`: queues a render of the edit as saved now. With `baseRevision`, only if nobody saved since. */
export async function renderAction(ctx: PluginContext, companyId: string, params: Record<string, unknown>, actor: EditActor) {
  const edit = await getVideoEdit(ctx, companyId, id(params.editId));
  if (params.baseRevision !== undefined && baseRevision(params.baseRevision) !== edit.revision) conflict(edit.revision);
  if (editDuration(edit.doc) <= 0) bad("This video edit has nothing on its timeline yet.");
  const client = edit.client ? { kind: String(edit.client.kind), id: edit.client.id } : null;
  await assertAssets(ctx, companyId, client as ClientScope, editAssetIds(edit.doc));
  const [waiting] = await ctx.db.query<{ n: number | string }>(`SELECT count(*) AS n FROM ${table(ctx, "video_renders")} WHERE company_id = $1 AND status = 'queued'`, [companyId]);
  if (num(waiting?.n) >= MAX_QUEUED_RENDERS) bad(`${MAX_QUEUED_RENDERS} renders are already waiting. Wait for them, or cancel one.`, "render_busy");
  const render = await enqueueRender(ctx, { companyId, client, editId: edit.id, editRevision: edit.revision, doc: edit.doc, preset: edit.doc.project.size });
  ctx.logger.info("Studio video render queued", { companyId, editId: edit.id, renderId: render.id, revision: edit.revision, by: actor.agentId ?? actor.userId ?? null });
  return renderOut(render);
}

/** `video-edit-render-status`. */
export async function renderStatusAction(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  return renderOut(await getRender(ctx, companyId, id(params.renderId)));
}

/** `video-edit-cancel-render`: a queued render is dropped; a running one is stopped by the runner on its next heartbeat. */
export async function cancelRenderAction(ctx: PluginContext, companyId: string, params: Record<string, unknown>, actor: EditActor) {
  const result = await cancelRender(ctx, companyId, id(params.renderId));
  if (result.cancelled) ctx.logger.info("Studio video render cancelled", { companyId, renderId: result.render.id, wasRunning: Boolean(result.running), by: actor.agentId ?? actor.userId ?? null });
  return { render: renderOut(result.render), cancelled: result.cancelled };
}
