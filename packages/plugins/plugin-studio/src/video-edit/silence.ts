/**
 * Auto-cut silences (PAR-8279 D5a1). ffmpeg's `silencedetect` reads the clip's own source range (`in`..`out`) through
 * the contained runner and `ametadata` writes what it finds to a file in our workdir; every number in the argv is
 * formatted here. Each silent stretch, less `padding` on every side that touches sound, becomes plain ops saved through
 * `video-edit-apply-ops`, so they validate like hand-made edits and the caller can show or undo them:
 * - the clip itself: `split` at the cut, then `trim` the right part's `in` past it with `ripple`, so the later clips of
 *   its track move up. Last cut first, so the earlier cut times stay put. Keyframes follow through split and trim.
 * - every other track follows one time map (the time removed before a point moves it up): later clips `move`; a
 *   caption over a cut keeps its words in sync (words inside a cut go); any other clip under a cut keeps playing and
 *   gets shorter by the time removed under it (from its front when it starts inside a cut, else from its end), and goes
 *   when nothing is left. Music under a talking clip so plays on without a jump.
 * Cut edges snap to the project's frames. No registry kind (plan Q3): one local implementation.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { scopeOfRow } from "@partnersinbiz/pib-plugin-kit";
import { StudioConfig } from "../config.js";
import { StudioError } from "../errors.js";
import { applyOpsAction } from "./actions.js";
import { soundClip, text, type Edit } from "./beats.js";
import { runContained, type RunOptions, type RunResult } from "./ffmpeg.js";
import { applyOps, MAX_OPS, type EditOp } from "./ops.js";
import { resolveInputs, type ResolvedInput } from "./render-pipeline.js";
import { getVideoEdit, type EditActor } from "./store.js";
import { clipDuration, editDuration, KEYFRAME_PROPS, type Clip, type EditDoc, type MediaClip } from "./timeline.js";
import { downloadObjectToWorkdir, withRenderWorkdir } from "./workdir.js";

/** Defaults and allowed ranges: threshold in dB, minSilence and padding in source seconds. */
export const SILENCE_PARAMS = {
  threshold: { default: -30, range: [-60, -10] },
  minSilence: { default: 0.5, range: [0.2, 5] },
  padding: { default: 0.1, range: [0, 1] },
} as const;
/** Inside the 30 s host RPC timeout, as beats: ffmpeg only decodes sound and writes a small text report. */
export const SILENCE_RUN: RunOptions = { timeoutSec: 20, killAfterSec: 5, asLimitBytes: 1024 ** 3, fsizeBytes: 1024 ** 2 };
const REPORT = "silence.txt";
/** A silence this close to the clip's edge counts as touching it (no padding kept there). */
const EDGE = 0.01;

const ms = (x: number) => Math.round(x * 1000) / 1000;
const same = (a: number, b: number) => Math.abs(a - b) < 0.0005;

function bad(message: string, code = "bad_edit"): never {
  throw new StudioError(message, code);
}

/** ffmpeg args: silencedetect over the source range, findings to `silence.txt` in the run's cwd (the workdir). */
export function silenceArgs(source: string, from: number, span: number, threshold: number, minSilence: number): string[] {
  const filter = `silencedetect=noise=${ms(threshold)}dB:d=${ms(minSilence)},ametadata=mode=print:file=${REPORT}`;
  return ["-y", "-ss", String(ms(from)), "-t", String(ms(span)), "-i", `file:${source}`, "-map", "0:a:0", "-vn", "-af", filter, "-f", "null", "-"];
}

/** Silent stretches `[start, end]` (seconds from the range start) from the ametadata report; one still open runs to `span`. */
export function parseSilences(report: string, span: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let open: number | null = null;
  for (const line of report.split("\n")) {
    const m = /^lavfi\.silence_(start|end)=(-?\d+(?:\.\d+)?(?:e-?\d+)?)$/.exec(line.trim());
    if (!m) continue;
    const t = ms(Math.min(span, Math.max(0, Number(m[2]))));
    if (m[1] === "start") open = t;
    else if (open !== null) {
      if (t > open) out.push([open, t]);
      open = null;
    }
  }
  if (open !== null && span > open) out.push([open, ms(span)]);
  return out;
}

type Run = (args: string[], opts: RunOptions) => { done: Promise<RunResult> };

/** Runs silencedetect on `source` (a file in `dir`) through the contained runner and returns the silences. */
export async function runSilencedetect(dir: string, source: string, clip: Pick<MediaClip, "in" | "out">, opts: { threshold: number; minSilence: number }, run: Run = runContained) {
  const span = ms(clip.out - clip.in);
  const res = await run(silenceArgs(source, clip.in, span, opts.threshold, opts.minSilence), { ...SILENCE_RUN, cwd: dir }).done;
  if (res.outcome !== "ok") bad(`Studio could not read this clip's sound (${res.outcome}). Check that the clip has sound.`, "no_audio");
  return parseSilences(await readFile(join(dir, REPORT), "utf8").catch(() => ""), span);
}

export interface Cut { from: number; to: number }

/** Timeline cuts for the silences of `clip`: padded where they touch sound, snapped to frames, at least a frame long. */
export function silenceCuts(clip: Pick<MediaClip, "start" | "in" | "out" | "speed">, silences: ReadonlyArray<readonly [number, number]>, padding: number, fps: number): Cut[] {
  const span = clip.out - clip.in;
  const end = ms(clip.start + span / clip.speed);
  const snap = (t: number) => ms(Math.round(t * fps) / fps);
  const cuts: Cut[] = [];
  for (const [s, e] of silences) {
    const from = s <= EDGE ? clip.start : Math.max(clip.start, snap(clip.start + (s + padding) / clip.speed));
    const to = e >= span - EDGE ? end : Math.min(end, snap(clip.start + (e - padding) / clip.speed));
    if (to - from < 1 / fps - 0.0005) continue;
    const last = cuts[cuts.length - 1];
    // A sliver of sound under a frame between two cuts goes with them.
    if (last && from - last.to < 1 / fps) last.to = to;
    else cuts.push({ from, to });
  }
  return cuts;
}

/** Timeline time `t` after the cuts: the time they remove before it (a point inside a cut lands on its start). */
export const timeMap = (cuts: readonly Cut[]) => (t: number) => ms(t - cuts.reduce((r, c) => r + Math.max(0, Math.min(t, c.to) - c.from), 0));

/** The ops that move or shorten one clip of another track by the time map; none when it is untouched. */
function followOps(c: Clip, cuts: readonly Cut[], at: (t: number) => number): EditOp[] {
  const s = c.start, e = ms(c.start + clipDuration(c));
  const [s2, e2] = [at(s), at(e)];
  const len = ms(e2 - s2);
  if (same(s2, s) && same(e2, e)) return [];
  if ("words" in c) {
    const words = c.words.map((w) => ({ ...w, start: ms(at(s + w.start) - s2), end: ms(at(s + w.end) - s2) })).filter((w) => w.end > w.start);
    return [words.length ? { op: "setProps", clipId: c.id, props: { start: s2, words } } : { op: "delete", clipId: c.id }];
  }
  if (len < 0.001) return [{ op: "delete", clipId: c.id }];
  if (same(len, e - s)) return [{ op: "move", clipId: c.id, start: s2 }];
  // Starting inside a cut, the part under it goes from the front; else the clip plays on and ends earlier.
  const front = ms(Math.max(0, (cuts.find((k) => s > k.from && s < k.to)?.to ?? s) - s));
  if ("duration" in c) {
    const fadeIn = Math.min(c.fadeIn, len);
    const props: Record<string, unknown> = { start: s2, duration: len, fadeIn, fadeOut: Math.min(c.fadeOut, ms(len - fadeIn)) };
    if (c.transitionIn && c.transitionIn.duration > len) props.transitionIn = { duration: len };
    if (c.animation && (c.animation.inDuration ?? 0) + (c.animation.outDuration ?? 0) > len) props.animation = null;
    if (c.keyframes) {
      props.keyframes = Object.fromEntries(KEYFRAME_PROPS.filter((p) => c.keyframes?.[p]).map((p) => [p, c.keyframes![p]!.map((k) => ({ ...k, t: ms(k.t - front) })).filter((k) => k.t >= 0 && k.t <= len)]));
    }
    return [{ op: "setProps", clipId: c.id, props }];
  }
  const media = c as MediaClip;
  const inPoint = ms(media.in + front * media.speed);
  const ops: EditOp[] = [{ op: "trim", clipId: c.id, in: inPoint, out: ms(inPoint + len * media.speed) }];
  if (!same(s2, s)) ops.push({ op: "move", clipId: c.id, start: s2 });
  return ops;
}

/** All the ops of cutting `cuts` (timeline, ascending, inside the clip) out of clip `clipId` and every track with it. */
export function silenceOps(doc: EditDoc, clipId: string, cuts: readonly Cut[]): EditOp[] {
  const track = doc.tracks.find((t) => t.clips.some((c) => c.id === clipId));
  if (!track) bad(`Clip ${clipId} is not in this video edit.`, "not_found");
  const clip = track.clips.find((c) => c.id === clipId) as MediaClip;
  const end = ms(clip.start + clipDuration(clip));
  const source = (t: number) => ms(clip.in + (t - clip.start) * clip.speed);
  const ids = new Set(doc.tracks.flatMap((t) => t.clips.map((c) => c.id)));
  let n = 0;
  const fresh = () => {
    let id: string;
    do id = `${clipId.slice(0, 56)}-s${++n}`;
    while (ids.has(id));
    ids.add(id);
    return id;
  };
  const ops: EditOp[] = [];
  for (const cut of [...cuts].reverse()) {
    if (cut.from <= clip.start + 0.0005) ops.push({ op: "trim", clipId, in: source(cut.to), ripple: true });
    else if (cut.to >= end - 0.0005) ops.push({ op: "trim", clipId, out: source(cut.from), ripple: true });
    else {
      const right = fresh();
      ops.push({ op: "split", clipId, at: cut.from, newId: right }, { op: "trim", clipId: right, in: source(cut.to), ripple: true });
    }
  }
  const at = timeMap(cuts);
  for (const t of doc.tracks) {
    if (t.id === track.id) continue;
    for (const c of [...(t.clips as Clip[])].sort((a, b) => a.start - b.start)) ops.push(...followOps(c, cuts, at));
  }
  return ops;
}

export interface SilenceDeps {
  /** The silences of the clip's source range (seconds from `in`). Tests replace it; the default runs ffmpeg. */
  detect?: (ctx: PluginContext, companyId: string, input: ResolvedInput, clip: MediaClip, opts: { threshold: number; minSilence: number }) => Promise<Array<[number, number]>>;
}

async function detectSilences(ctx: PluginContext, companyId: string, input: ResolvedInput, clip: MediaClip, opts: { threshold: number; minSilence: number }) {
  const bucket = await new StudioConfig(ctx, companyId).bucket();
  return withRenderWorkdir(`silence-${randomUUID().slice(0, 8)}`, input.bytes, async (dir) => {
    const src = await downloadObjectToWorkdir(bucket, companyId, input.key, dir, "source.bin");
    return runSilencedetect(dir, src.path, clip, opts);
  });
}

function param(params: Record<string, unknown>, name: keyof typeof SILENCE_PARAMS): number {
  const { default: fallback, range } = SILENCE_PARAMS[name];
  const v = params[name] ?? fallback;
  if (typeof v !== "number" || !Number.isFinite(v) || v < range[0] || v > range[1]) bad(`${name} must be a number from ${range[0]} to ${range[1]}.`);
  return ms(v);
}

async function inputFor(ctx: PluginContext, companyId: string, edit: Edit, clip: MediaClip): Promise<ResolvedInput> {
  const scope = scopeOfRow({ client_kind: edit.client ? String(edit.client.kind) : null, client_ref: edit.client?.id ?? null });
  let input: ResolvedInput | undefined;
  try {
    // Checks the asset belongs to this edit's company and client before anything is read.
    [input] = await resolveInputs(ctx, companyId, scope, { ...edit.doc, tracks: [{ id: "src", kind: "video", clips: [clip] }] });
  } catch (e) {
    bad(e instanceof Error ? e.message : String(e), "unknown_asset");
  }
  if (!input) bad(`Clip ${clip.id} has no library asset to read sound from; pick a video or sound clip.`, "unknown_asset");
  if (input.kind === "image") bad("A picture has no sound; pick a video or sound clip.");
  return input;
}

/**
 * `video-edit-cut-silences`: cuts the silent parts out of clip `clipId` (and every track with it) at `baseRevision`,
 * through `video-edit-apply-ops`. `dryRun` returns the ops, the number of cuts and the seconds saved, unsaved.
 */
export async function cutSilencesAction(ctx: PluginContext, companyId: string, params: Record<string, unknown>, actor: EditActor, deps: SilenceDeps = {}) {
  const base = Number(params.baseRevision);
  if (!Number.isInteger(base) || base < 1) bad("baseRevision is required: the revision these changes start from.");
  const clipId = text(params.clipId);
  if (!clipId) bad("clipId is required: the video or sound clip to cut the silences out of.");
  const opts = { threshold: param(params, "threshold"), minSilence: param(params, "minSilence") };
  const padding = param(params, "padding");
  const edit = await getVideoEdit(ctx, companyId, text(params.editId));
  if (edit.revision !== base) throw new StudioError(`Someone saved this video edit since you opened it (now revision ${edit.revision}). Reload to see their changes.`, "edit_conflict");
  const clip = soundClip(edit.doc, clipId);
  const silences = await (deps.detect ?? detectSilences)(ctx, companyId, await inputFor(ctx, companyId, edit, clip), clip, opts);
  const cuts = silenceCuts(clip, silences, padding, edit.doc.project.fps);
  const end = ms(clip.start + clipDuration(clip));
  if (cuts.length === 1 && cuts[0]!.from <= clip.start && cuts[0]!.to >= end) bad("This clip is silent throughout at this threshold; lower the threshold or delete the clip.", "all_silent");
  const ops = silenceOps(edit.doc, clipId, cuts);
  if (ops.length > MAX_OPS) bad(`Cutting these silences takes ${ops.length} changes; one save takes ${MAX_OPS}. Raise minSilence or cut a shorter clip.`, "too_many");
  // The same check apply-ops makes, so a dry run never promises cuts that would be refused.
  const after = applyOps(edit.doc, ops);
  const summary = { clipId, cuts: cuts.length, secondsSaved: ms(cuts.reduce((s, c) => s + c.to - c.from, 0)), ...opts, padding };
  if (params.dryRun === true || !ops.length) return { editId: edit.id, revision: edit.revision, ops, duration: editDuration(after), silences: summary };
  const saved = await applyOpsAction(ctx, companyId, { editId: edit.id, baseRevision: base, ops }, actor);
  ctx.logger.info("Studio silences cut", { companyId, editId: edit.id, ...summary, by: actor.agentId ?? actor.userId ?? null });
  return { ...saved, ops, silences: summary };
}
