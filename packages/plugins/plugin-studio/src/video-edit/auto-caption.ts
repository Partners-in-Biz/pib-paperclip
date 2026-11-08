/**
 * `video-edit-caption` (PAR-8360 B9): auto-captions for one clip. The clip's sound (its `in`..`out` range only) is cut
 * to 16 kHz mono WAV with the contained ffmpeg runner, sent to speech to text (stt.ts), and the timed words become
 * caption clips on a caption track (B6, PAR-8321) through the normal ops, so they validate like hand-made captions and
 * stay editable. Words are grouped into short cues at pauses. Nothing is saved when anything fails.
 *
 * Why an action and not plain ops (Q7): an agent or the page has no other way to get word timings; the ops it builds
 * are the same `addTrack`/`addClip` an agent could send itself.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { scopeOfRow } from "@partnersinbiz/pib-plugin-kit";
import { StudioConfig } from "../config.js";
import { StudioError } from "../errors.js";
import { fakeProviderOn } from "../provider.js";
import { applyOpsAction } from "./actions.js";
import { runContained } from "./ffmpeg.js";
import { resolveInputs, type ResolvedInput } from "./render-pipeline.js";
import { getVideoEdit, type EditActor } from "./store.js";
import { fakeSpeechToText, xaiSpeechToText, type SpeechToText, type SttWord } from "./stt.js";
import { CAPTION_STYLES, LIMITS, type CaptionClip, type CaptionStyle, type CaptionWord, type EditDoc, type MediaClip } from "./timeline.js";
import { downloadObjectToWorkdir, withRenderWorkdir } from "./workdir.js";

/** A pause longer than this starts a new caption. */
export const CUE_GAP_SEC = 0.8;
export const CUE_MAX_WORDS = 10;
export const CUE_MAX_SEC = 4;
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;

const ms = (x: number) => Math.round(x * 1000) / 1000;

function bad(message: string, code = "bad_edit"): never {
  throw new StudioError(message, code);
}

export interface ClipTiming {
  start: number;
  in: number;
  out: number;
  speed: number;
}

/** STT words (seconds from the start of the extracted audio = source `in`) as timeline seconds, inside the clip. */
export function timelineWords(words: readonly SttWord[], clip: ClipTiming): CaptionWord[] {
  const span = clip.out - clip.in;
  const end = ms(clip.start + span / clip.speed);
  const out: CaptionWord[] = [];
  let last = clip.start;
  for (const w of words) {
    const text = w.text.trim().slice(0, 100);
    const s = Math.max(0, w.start);
    const e = Math.min(span, w.end);
    if (!text || !(e > s)) continue;
    const start = ms(Math.max(last, clip.start + s / clip.speed));
    const stop = ms(Math.min(end, clip.start + e / clip.speed));
    if (!(stop > start)) continue;
    out.push({ text, start, end: stop });
    last = stop;
  }
  return out;
}

/** Timeline words grouped into captions at pauses, each at most CUE_MAX_WORDS words and CUE_MAX_SEC long. Word times relative to the cue. */
export function groupCues(words: readonly CaptionWord[]): Array<{ start: number; words: CaptionWord[] }> {
  const cues: Array<{ start: number; words: CaptionWord[] }> = [];
  let cur: CaptionWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    const start = cur[0].start;
    cues.push({ start, words: cur.map((w) => ({ text: w.text, start: ms(w.start - start), end: ms(w.end - start) })) });
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && (w.start - prev.end > CUE_GAP_SEC || cur.length >= CUE_MAX_WORDS || w.end - cur[0].start > CUE_MAX_SEC)) flush();
    cur.push(w);
  }
  flush();
  return cues;
}

function mediaClip(doc: EditDoc, clipId: string): MediaClip {
  for (const t of doc.tracks) {
    for (const c of t.clips) {
      if (c.id !== clipId) continue;
      if (t.kind === "video" || t.kind === "overlay" || t.kind === "audio") return c as MediaClip;
      bad(`Clip ${clipId} is on a ${t.kind} track; pick a video or sound clip to caption.`);
    }
  }
  bad(`Clip ${clipId} is not in this video edit.`, "not_found");
}

const safeId = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "clip";

export interface CaptionPlan {
  ops: unknown[];
  trackId: string;
  cues: number;
  words: number;
}

/**
 * The ops that put `words` (timeline seconds) on a caption track: the given one, else the first caption track, else a
 * new one. Refused when that track already has captions over the clip, so a second run never stacks captions.
 */
export function captionTarget(doc: EditDoc, clipId: string, trackId?: string): { trackId: string; existing: CaptionClip[]; addTrack: boolean } {
  const clip = mediaClip(doc, clipId);
  const from = clip.start;
  const to = ms(clip.start + (clip.out - clip.in) / clip.speed);
  const track = trackId ? doc.tracks.find((t) => t.id === trackId) : doc.tracks.find((t) => t.kind === "caption");
  if (trackId && !track) bad(`Track ${trackId} is not in this video edit.`, "not_found");
  if (!track) {
    const taken = new Set(doc.tracks.map((t) => t.id));
    let id = "captions";
    for (let n = 2; taken.has(id); n += 1) id = `captions-${n}`;
    return { trackId: id, existing: [], addTrack: true };
  }
  if (track.kind !== "caption") bad(`Track ${track.id} is a ${track.kind} track, not a caption track.`);
  const clash = track.clips.find((c) => c.start < to && c.start + (c.words[c.words.length - 1]?.end ?? 0) > from);
  if (clash) bad(`Caption ${clash.id} already covers part of this clip. Delete those captions first, or pick another caption track.`, "overlap");
  return { trackId: track.id, existing: track.clips, addTrack: false };
}

export function captionOps(doc: EditDoc, clipId: string, words: readonly CaptionWord[], opts: { trackId?: string; style?: CaptionStyle } = {}): CaptionPlan {
  const { trackId, existing, addTrack } = captionTarget(doc, clipId, opts.trackId);
  const ops: unknown[] = addTrack ? [{ op: "addTrack", track: { id: trackId, kind: "caption", clips: [] } }] : [];
  const cues = groupCues(words);
  if (!cues.length) bad("No speech was found in this clip.", "no_speech");
  if (existing.length + cues.length > LIMITS.maxClipsPerTrack) bad(`That makes ${existing.length + cues.length} captions on one track; a track holds ${LIMITS.maxClipsPerTrack}.`, "too_many");
  const ids = new Set(doc.tracks.flatMap((t) => t.clips.map((c) => c.id)));
  const prefix = `cap-${safeId(clipId)}`;
  let n = 0;
  const nextId = () => {
    let id: string;
    do id = `${prefix}-${++n}`;
    while (ids.has(id));
    ids.add(id);
    return id;
  };
  const style = opts.style ?? "plain";
  for (const cue of cues) ops.push({ op: "addClip", trackId, clip: { id: nextId(), start: cue.start, style, words: cue.words } });
  return { ops, trackId, cues: cues.length, words: words.length };
}

/** ffmpeg args: the source range as 16 kHz mono 16-bit WAV. Fails (nonzero) when the file has no sound stream. */
export function audioExtractArgs(source: string, from: number, span: number, output: string): string[] {
  return ["-y", "-ss", String(ms(from)), "-t", String(ms(span)), "-i", `file:${source}`, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", `file:${output}`];
}

async function extractClipAudio(ctx: PluginContext, companyId: string, input: ResolvedInput, from: number, span: number): Promise<Uint8Array> {
  const bucket = await new StudioConfig(ctx, companyId).bucket();
  return withRenderWorkdir(`cap-${randomUUID().slice(0, 8)}`, input.bytes, async (dir) => {
    const src = await downloadObjectToWorkdir(bucket, companyId, input.key, dir, "source.bin");
    const out = join(dir, "audio.wav");
    const res = await runContained(audioExtractArgs(src.path, from, span, out), { cwd: dir, timeoutSec: 300, killAfterSec: 10 }).done;
    if (res.outcome !== "ok") bad(`Studio could not read this clip's sound (${res.outcome}). Check that the video has sound.`, "no_audio");
    return new Uint8Array(await readFile(out));
  });
}

export interface CaptionDeps {
  stt?: (ctx: PluginContext, companyId: string) => Promise<SpeechToText>;
  extract?: (ctx: PluginContext, companyId: string, input: ResolvedInput, from: number, span: number) => Promise<Uint8Array>;
}

async function defaultStt(ctx: PluginContext, companyId: string): Promise<SpeechToText> {
  return fakeProviderOn() ? fakeSpeechToText() : xaiSpeechToText(await new StudioConfig(ctx, companyId).xaiKey());
}

/** `video-edit-caption`: speech in clip `clipId` becomes captions on a caption track, saved at `baseRevision`. */
export async function captionClipAction(ctx: PluginContext, companyId: string, params: Record<string, unknown>, actor: EditActor, deps: CaptionDeps = {}) {
  const base = Number(params.baseRevision);
  if (!Number.isInteger(base) || base < 1) bad("baseRevision is required: the revision these changes start from.");
  const clipId = String(params.clipId ?? "").trim();
  if (!clipId) bad("clipId is required: the video or sound clip to caption.");
  const style = (params.style ?? "plain") as CaptionStyle;
  if (!CAPTION_STYLES.includes(style)) bad(`style must be one of ${CAPTION_STYLES.join(", ")}.`);
  const language = typeof params.language === "string" && params.language.trim() ? params.language.trim() : undefined;
  if (language && !LANGUAGE.test(language)) bad("language must be a code like en or af.");
  const trackId = typeof params.trackId === "string" && params.trackId.trim() ? params.trackId.trim() : undefined;

  const edit = await getVideoEdit(ctx, companyId, String(params.editId ?? "").trim());
  if (edit.revision !== base) throw new StudioError(`Someone saved this video edit since you opened it (now revision ${edit.revision}). Reload to see their changes.`, "edit_conflict");
  const clip = mediaClip(edit.doc, clipId);
  // Checks the track and overlap before paying for speech to text.
  captionTarget(edit.doc, clipId, trackId);

  const scope = scopeOfRow({ client_kind: edit.client ? String(edit.client.kind) : null, client_ref: edit.client?.id ?? null });
  const one: EditDoc = { ...edit.doc, tracks: [{ id: "src", kind: "video", clips: [clip] }] };
  let input: ResolvedInput;
  try {
    [input] = await resolveInputs(ctx, companyId, scope, one);
  } catch (e) {
    bad(e instanceof Error ? e.message : String(e), "unknown_asset");
  }
  if (input.kind !== "video") bad("A picture has no sound to caption; pick a video or sound clip.");
  const span = ms(clip.out - clip.in);
  const audio = await (deps.extract ?? extractClipAudio)(ctx, companyId, input, clip.in, span);
  const stt = await (deps.stt ?? defaultStt)(ctx, companyId);
  const heard = await stt.transcribe({ audio, mimeType: "audio/wav", language });
  const words = timelineWords(heard.words, clip);
  const plan = captionOps(edit.doc, clipId, words, { trackId, style });
  const saved = await applyOpsAction(ctx, companyId, { editId: edit.id, baseRevision: base, ops: plan.ops }, actor);
  ctx.logger.info("Studio auto-captions added", { companyId, editId: edit.id, clipId, cues: plan.cues, words: plan.words, provider: stt.key, by: actor.agentId ?? actor.userId ?? null });
  return { ...saved, captions: { trackId: plan.trackId, cues: plan.cues, words: plan.words } };
}
