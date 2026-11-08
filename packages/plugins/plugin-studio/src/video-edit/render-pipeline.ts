/**
 * The render pipeline (PAR-8276 A7b): the executor the runner (A7a) calls for one claimed render.
 *
 *  1. Inputs come from `assets` + `asset_versions` rows only: same company, same client scope as the render, the exact
 *     id and version the timeline names. The R2 key is read from that row, never from the timeline, and every key
 *     passes `assertOwnKey`.
 *  2. In a fresh work folder (disk check first): download each input, probe video inputs (has it sound?), compile
 *     (A4/A5), write the graph and text files, run ffmpeg contained (A6).
 *  3. Verify the output with ffprobe: video present, duration within 0.1 s of `editDuration`, audio present iff the
 *     compiled edit has sound, size <= 200 MB. A failed check deletes the output and fails the render as
 *     `verify_failed` (deterministic): no upload, no asset row.
 *  4. Upload to `studio/<company>/<scope>/<assetId>/v1.mp4` and record it as an asset with `source = 'edit'` and
 *     `source_ref = <render id>`. The asset id is the render id, so a retry after a crash writes the same key and rows;
 *     a render whose asset is already recorded returns it without rendering again.
 *  5. Best effort (A7c): a 720p H.264 preview proxy of the verified output, stored as `.../<assetId>/preview-720p.mp4`
 *     and returned as `previewR2Key`. A proxy failure (ffmpeg, check or upload) is logged and the render still
 *     succeeds with no preview. A retry that finds the asset already recorded returns no preview key.
 */
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { sameClient, scopeOfRow, type ClientScope } from "@partnersinbiz/pib-plugin-kit";
import { recordStoredAsset } from "../assets.js";
import { StudioConfig } from "../config.js";
import { num as dbNum, table } from "../db.js";
import { StudioError } from "../errors.js";
import { assertOwnKey, assetKey, extFor, MAX_ASSET_BYTES, putObject, sha256Hex, type PrivateBucket } from "../storage.js";
import { compileVideo, inputKey, type CompileInputs } from "./compile-video.js";
import { runContained, type RunOptions } from "./ffmpeg.js";
import { probeMedia, type ProbeResult } from "./probe.js";
import { makeProxy, PREVIEW_MIME, previewKeyFor } from "./proxy.js";
import type { ClaimedRender } from "./render-queue.js";
import { failureFromRun, RenderFailure, type RenderExecutor } from "./runner.js";
import { editDuration, normalizeEdit, type EditDoc } from "./timeline.js";
import { downloadObjectToWorkdir, withRenderWorkdir } from "./workdir.js";

export const OUTPUT_FILE = "out.mp4";
export const OUTPUT_MIME = "video/mp4";
export const DURATION_TOLERANCE_SEC = 0.1;
const SAFE_FILE = /^[A-Za-z0-9_-]{1,80}\.[a-z0-9]{1,8}$/;

type StatfsFn = Parameters<typeof withRenderWorkdir>[3];

export interface PipelineOptions {
  /** The company's private bucket. Default: plugin settings (one secret lookup per render). */
  bucket?: (ctx: PluginContext, companyId: string) => Promise<PrivateBucket>;
  /** Extra options for every contained ffmpeg/ffprobe run (tests point `bins` at fakes). */
  run?: Omit<RunOptions, "tool" | "captureStdout" | "cwd">;
  fontsDir?: string;
  statfs?: StatfsFn;
}

/** One timeline input, resolved from its asset row. */
export interface ResolvedInput {
  assetId: string;
  version: number;
  key: string;
  mime: string;
  kind: "video" | "image";
  bytes: number;
}

interface InputRow {
  id: string;
  client_kind: string | null;
  client_ref: string | null;
  kind: string;
  r2_key: string;
  mime: string;
  bytes: unknown;
}

const deterministic = (message: string, code: string) => new RenderFailure(message, "deterministic", code);

/** The (asset, version) pairs the timeline uses, in first-use order. */
export function editInputs(doc: EditDoc): Array<{ assetId: string; version: number }> {
  const seen = new Map<string, { assetId: string; version: number }>();
  for (const track of doc.tracks) {
    for (const clip of track.clips as Array<{ assetId?: unknown; version?: unknown }>) {
      if (typeof clip.assetId !== "string" || typeof clip.version !== "number") continue;
      const k = inputKey(clip.assetId, clip.version);
      if (!seen.has(k)) seen.set(k, { assetId: clip.assetId, version: clip.version });
    }
  }
  return [...seen.values()];
}

/** Every input from its row: this company, the render's client scope, the exact version. Keys are checked here. */
export async function resolveInputs(ctx: PluginContext, companyId: string, scope: ClientScope, doc: EditDoc): Promise<ResolvedInput[]> {
  const out: ResolvedInput[] = [];
  for (const { assetId, version } of editInputs(doc)) {
    const rows = await ctx.db.query<InputRow>(
      `SELECT a.id, a.client_kind, a.client_ref, a.kind, v.r2_key, v.mime, v.bytes FROM ${table(ctx, "assets")} a
       JOIN ${table(ctx, "asset_versions")} v ON v.asset_id = a.id AND v.company_id = a.company_id
       WHERE a.company_id = $1 AND a.id = $2 AND v.version = $3`,
      [companyId, assetId, version],
    );
    const row = rows[0];
    // Another client's asset reads as missing: the render must not learn it exists.
    if (!row || !sameClient(scopeOfRow(row), scope)) throw deterministic(`Asset ${assetId} version ${version} is not in this edit's library.`, "unknown_asset");
    try {
      assertOwnKey(companyId, row.r2_key);
    } catch {
      throw deterministic(`Asset ${assetId} has a storage key outside this company's Studio folder.`, "unsafe_key");
    }
    if (row.kind !== "video" && row.kind !== "image") throw deterministic(`Asset ${assetId} is not a video or picture.`, "unsupported_codec");
    out.push({ assetId, version, key: row.r2_key, mime: row.mime, kind: row.kind, bytes: dbNum(row.bytes) });
  }
  return out;
}

/** Why the output's size fails verification, or null when it passes. */
export function sizeProblem(sizeBytes: number): string | null {
  if (sizeBytes <= 0) return "The render wrote no output.";
  if (sizeBytes > MAX_ASSET_BYTES) return `The render is ${Math.ceil(sizeBytes / 1024 / 1024)} MB; Studio keeps files up to ${MAX_ASSET_BYTES / 1024 / 1024} MB.`;
  return null;
}

/** Why the probed output fails verification, or null when it passes. */
export function verifyOutput(probe: ProbeResult, expected: { duration: number; audio: boolean }): string | null {
  if (!probe.hasVideo) return "The render has no video stream.";
  const drift = Math.abs(probe.durationSec - expected.duration);
  if (!(drift <= DURATION_TOLERANCE_SEC + 1e-9)) return `The render lasts ${probe.durationSec.toFixed(3)} s; the edit lasts ${expected.duration.toFixed(3)} s.`;
  if (probe.hasAudio !== expected.audio) return expected.audio ? "The render lost its sound." : "The render has sound the edit does not.";
  return null;
}

function scopeOf(job: ClaimedRender): ClientScope {
  return scopeOfRow({ client_kind: job.client?.kind ?? null, client_ref: job.client?.id ?? null });
}

/** The asset this render already recorded (a retry after the upload), if any. */
async function existingOutput(ctx: PluginContext, job: ClaimedRender): Promise<string | null> {
  const rows = await ctx.db.query<{ id: string }>(`SELECT id FROM ${table(ctx, "assets")} WHERE company_id = $1 AND source = 'edit' AND source_ref = $2`, [job.companyId, job.id]);
  return rows[0]?.id ?? null;
}

async function editMeta(ctx: PluginContext, job: ClaimedRender): Promise<{ title: string; clientName: string | null; projectId: string | null }> {
  const rows = await ctx.db.query<{ title: string; client_name: string | null; project_id: string | null }>(
    `SELECT title, client_name, project_id FROM ${table(ctx, "video_edits")} WHERE company_id = $1 AND id = $2`,
    [job.companyId, job.editId],
  );
  const row = rows[0];
  return { title: row?.title || "Video edit", clientName: row?.client_name ?? null, projectId: row?.project_id ?? null };
}

export function createRenderExecutor(options: PipelineOptions = {}): RenderExecutor {
  const bucketFor = options.bucket ?? ((ctx: PluginContext, companyId: string) => new StudioConfig(ctx, companyId).bucket());

  return async (ctx, job, control) => {
    const checkpoint = () => {
      if (control.signal.aborted) throw control.signal.reason ?? new RenderFailure("The render was stopped.", "infra", "cancelled");
    };
    const already = await existingOutput(ctx, job);
    if (already) return { assetId: already };

    const doc = normalizeEdit(job.doc);
    const scope = scopeOf(job);
    const duration = editDuration(doc);
    const inputs = await resolveInputs(ctx, job.companyId, scope, doc);
    const cfg = await bucketFor(ctx, job.companyId);
    const totalBytes = inputs.reduce((n, i) => n + i.bytes, 0);
    const runOpts = options.run ?? {};

    const output = await withRenderWorkdir(
      job.id,
      totalBytes,
      async (dir) => {
        const sources: CompileInputs = {};
        for (const [i, input] of inputs.entries()) {
          checkpoint();
          const { path } = await downloadObjectToWorkdir(cfg, job.companyId, input.key, dir, `in-${i}.${extFor(input.mime)}`);
          let hasAudio: boolean | undefined;
          if (input.kind === "video") {
            const probe = await probeMedia(path, runOpts);
            if (!probe.hasVideo) throw deterministic(`Asset ${input.assetId} has no video stream.`, "probe_failed");
            hasAudio = probe.hasAudio;
          }
          sources[inputKey(input.assetId, input.version)] = { path, kind: input.kind, hasAudio };
        }

        checkpoint();
        const compiled = compileVideo(doc, sources, OUTPUT_FILE, { fontsDir: options.fontsDir });
        const withAudio = !compiled.args.includes("-an");
        for (const file of compiled.files) {
          if (!SAFE_FILE.test(file.name)) throw deterministic(`Unsafe compile file name ${file.name}.`, "compile_error");
          await writeFile(join(dir, file.name), file.content, { mode: 0o600, flag: "wx" });
        }

        checkpoint();
        const handle = runContained(compiled.args, { ...runOpts, cwd: dir });
        const stop = () => handle.cancel();
        control.signal.addEventListener("abort", stop, { once: true });
        let result;
        try {
          if (handle.pgid > 0 && !(await control.started({ pgid: handle.pgid, workdir: dir }))) handle.cancel();
          result = await handle.done;
        } finally {
          control.signal.removeEventListener("abort", stop);
        }
        checkpoint();
        const failed = failureFromRun(result);
        if (failed) throw failed;

        const outPath = join(dir, OUTPUT_FILE);
        const size = (await stat(outPath).catch(() => null))?.size ?? 0;
        let why = sizeProblem(size);
        if (!why) {
          try {
            why = verifyOutput(await probeMedia(outPath, runOpts), { duration, audio: withAudio });
          } catch (e) {
            why = `ffprobe could not read the render: ${e instanceof StudioError ? e.message : String(e)}`;
          }
        }
        if (why) {
          await rm(outPath, { force: true });
          throw deterministic(why, "verify_failed");
        }
        checkpoint();
        let preview: Awaited<ReturnType<typeof makeProxy>> | null = null;
        try {
          preview = await makeProxy(dir, OUTPUT_FILE, control, runOpts);
        } catch (e) {
          checkpoint();
          ctx.logger.warn("Studio render preview failed", { renderId: job.id, error: e instanceof Error ? e.message : String(e) });
        }
        checkpoint();
        if (!(await control.uploading())) throw new RenderFailure("The render claim was lost.", "infra", "cancelled");
        return { bytes: new Uint8Array(await readFile(outPath)) as Uint8Array<ArrayBuffer>, size, preview };
      },
      options.statfs,
    );

    // The render id is the asset id: a retry overwrites the same key and the rows are written once.
    const assetId = job.id;
    const key = assetKey(job.companyId, scope, assetId, 1, extFor(OUTPUT_MIME));
    assertOwnKey(job.companyId, key);
    checkpoint();
    await putObject(cfg, job.companyId, key, output.bytes, OUTPUT_MIME);
    const meta = await editMeta(ctx, job);
    // Cancelled during the upload: leave no asset row (the stored object is overwritten by a retry or swept with A9's cleanup).
    checkpoint();
    await recordStoredAsset(ctx, {
      id: assetId,
      companyId: job.companyId,
      scope,
      clientName: meta.clientName,
      projectId: meta.projectId,
      issueId: null,
      name: `${meta.title} (rev ${job.editRevision})`.slice(0, 200),
      source: "edit",
      sourceRef: job.id,
      mime: OUTPUT_MIME,
      key,
      size: output.size,
      sha256: sha256Hex(output.bytes),
    });
    // The asset is recorded: from here nothing fails the render.
    let previewR2Key: string | null = null;
    if (output.preview) {
      try {
        const previewKey = previewKeyFor(job.companyId, key);
        await putObject(cfg, job.companyId, previewKey, output.preview.bytes, PREVIEW_MIME);
        previewR2Key = previewKey;
      } catch (e) {
        ctx.logger.warn("Studio render preview upload failed", { renderId: job.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { assetId, previewR2Key };
  };
}
