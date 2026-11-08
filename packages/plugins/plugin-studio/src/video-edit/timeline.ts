/**
 * The video edit document (timeline JSON), schema version 1. Pure: no I/O, so the page, the ops, the store and the
 * ffmpeg compiler all share it. Times are seconds on the timeline, rounded to milliseconds. `normalizeEdit` keeps only
 * the fields below, fills defaults and refuses anything out of range with an `EditError` that names the field.
 * Version 1 has static transforms, crop, speed, volume, fades and a fade-in transition only; keyframes and effects come
 * with schemaVersion 2 (Phase D), which `normalizeEdit` will migrate to.
 */
import { StudioError } from "../errors.js";

export const SCHEMA_VERSION = 1;
export const SIZES = { "9:16": { width: 1080, height: 1920 }, "1:1": { width: 1080, height: 1080 }, "4:5": { width: 1080, height: 1350 }, "16:9": { width: 1920, height: 1080 } } as const;
export type SizePreset = keyof typeof SIZES;
export const FPS = [24, 25, 30, 60] as const;
export type Fps = (typeof FPS)[number];
export const TRACK_KINDS = ["video", "overlay", "text", "caption", "audio"] as const;
export type TrackKind = (typeof TRACK_KINDS)[number];
export const CAPTION_STYLES = ["plain", "bold", "karaoke"] as const;
export type CaptionStyle = (typeof CAPTION_STYLES)[number];

export const LIMITS = {
  maxDuration: 180,
  maxTracks: 20,
  maxClipsPerTrack: 200,
  maxWords: 2000,
  maxText: 500,
  speed: [0.25, 4],
  volume: [0, 2],
  scale: [0.01, 10],
  rotate: [-360, 360],
  offset: [-8000, 8000],
  fontSize: [8, 400],
  maxTransition: 5,
} as const;

export interface Crop { left: number; top: number; right: number; bottom: number }
/** x/y: offset of the clip's centre from the frame's centre in px; scale 1 = fit; rotate in degrees; crop as fractions. */
export interface Transform { x: number; y: number; scale: number; rotate: number; crop: Crop }
export interface Transition { type: "fade"; duration: number }
interface Timed { id: string; start: number; fadeIn: number; fadeOut: number }
export interface MediaClip extends Timed { assetId: string; version: number; in: number; out: number; speed: number; volume: number; transform: Transform; transitionIn: Transition | null }
export interface AudioClip extends Timed { assetId: string; version: number; in: number; out: number; speed: number; volume: number }
export interface TextClip extends Timed { text: string; duration: number; font: string | null; color: string; fontSize: number; transform: Transform; transitionIn: Transition | null }
export interface CaptionWord { text: string; start: number; end: number }
/** Word times are relative to the clip's start. */
export interface CaptionClip { id: string; start: number; style: CaptionStyle; words: CaptionWord[] }
export type Clip = MediaClip | AudioClip | TextClip | CaptionClip;
export type Track =
  | { id: string; kind: "video" | "overlay"; clips: MediaClip[] }
  | { id: string; kind: "audio"; clips: AudioClip[] }
  | { id: string; kind: "text"; clips: TextClip[] }
  | { id: string; kind: "caption"; clips: CaptionClip[] };
export interface EditProject { size: SizePreset; width: number; height: number; fps: Fps }
export interface EditDoc { schemaVersion: 1; project: EditProject; tracks: Track[] }

export type EditErrorReason = "invalid" | "out_of_range" | "too_many" | "duplicate" | "overlap" | "too_long" | "unsupported_version";

/** A refused edit document: `reason` says what kind of problem, `path` which field (e.g. `tracks[0].clips[2].speed`). */
export class EditError extends StudioError {
  constructor(message: string, readonly reason: EditErrorReason, readonly path: string) {
    super(message, "bad_edit");
    this.name = "EditError";
  }
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const ASSET_ID = /^[A-Za-z0-9-]{1,64}$/;
const COLOR = /^#[0-9A-Fa-f]{6}$/;

function fail(reason: EditErrorReason, path: string, message: string): never {
  throw new EditError(`${path}: ${message}`, reason, path);
}
function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
const ms = (n: number) => Math.round(n * 1000) / 1000;

/** A finite number in [min, max]; `fallback` when missing. Rounded to ms. */
function number(value: unknown, path: string, min: number, max: number, fallback?: number): number {
  if (value === undefined || value === null) {
    if (fallback === undefined) fail("invalid", path, "is required.");
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) fail("invalid", path, "must be a number.");
  if (value < min || value > max) fail("out_of_range", path, `must be between ${min} and ${max}.`);
  return ms(value);
}
function id(value: unknown, path: string, seen: Set<string>): string {
  if (typeof value !== "string" || !ID.test(value)) fail("invalid", path, "is missing or not a valid id.");
  if (seen.has(value)) fail("duplicate", path, `the id ${value} is used twice.`);
  seen.add(value);
  return value;
}
function list(value: unknown, path: string, max: number): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail("invalid", path, "must be a list.");
  if (value.length > max) fail("too_many", path, `holds at most ${max} items.`);
  return value;
}
function text(value: unknown, path: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) fail("invalid", path, "must be non-empty text.");
  if (value.length > max) fail("out_of_range", path, `is longer than ${max} characters.`);
  return value;
}

function transform(value: unknown, path: string): Transform {
  const t = obj(value);
  const c = obj(t.crop);
  const [o0, o1] = LIMITS.offset;
  const crop = { left: number(c.left, `${path}.crop.left`, 0, 1, 0), top: number(c.top, `${path}.crop.top`, 0, 1, 0), right: number(c.right, `${path}.crop.right`, 0, 1, 0), bottom: number(c.bottom, `${path}.crop.bottom`, 0, 1, 0) };
  if (crop.left + crop.right >= 1 || crop.top + crop.bottom >= 1) fail("out_of_range", `${path}.crop`, "leaves nothing of the picture.");
  return {
    x: number(t.x, `${path}.x`, o0, o1, 0),
    y: number(t.y, `${path}.y`, o0, o1, 0),
    scale: number(t.scale, `${path}.scale`, LIMITS.scale[0], LIMITS.scale[1], 1),
    rotate: number(t.rotate, `${path}.rotate`, LIMITS.rotate[0], LIMITS.rotate[1], 0),
    crop,
  };
}
function transition(value: unknown, path: string, length: number): Transition | null {
  if (value === undefined || value === null) return null;
  const t = obj(value);
  if (t.type !== "fade") fail("invalid", `${path}.type`, `only "fade" is supported.`);
  const duration = number(t.duration, `${path}.duration`, 0.001, LIMITS.maxTransition);
  if (duration > length) fail("out_of_range", `${path}.duration`, "is longer than the clip.");
  return { type: "fade", duration };
}
function fades(c: Record<string, unknown>, path: string, length: number) {
  const fadeIn = number(c.fadeIn, `${path}.fadeIn`, 0, length, 0);
  const fadeOut = number(c.fadeOut, `${path}.fadeOut`, 0, length, 0);
  if (fadeIn + fadeOut > length + 1e-9) fail("out_of_range", `${path}.fadeOut`, "fade in and fade out together are longer than the clip.");
  return { fadeIn, fadeOut };
}
function source(c: Record<string, unknown>, path: string) {
  if (typeof c.assetId !== "string" || !ASSET_ID.test(c.assetId)) fail("invalid", `${path}.assetId`, "is not an asset id.");
  if (typeof c.version !== "number" || !Number.isInteger(c.version) || c.version < 1) fail("invalid", `${path}.version`, "must be a whole number from 1.");
  const inPoint = number(c.in, `${path}.in`, 0, 86400, 0);
  const out = number(c.out, `${path}.out`, 0, 86400);
  if (out <= inPoint) fail("out_of_range", `${path}.out`, "must be after in.");
  const speed = number(c.speed, `${path}.speed`, LIMITS.speed[0], LIMITS.speed[1], 1);
  const volume = number(c.volume, `${path}.volume`, LIMITS.volume[0], LIMITS.volume[1], 1);
  return { assetId: c.assetId, version: c.version, in: inPoint, out, speed, volume };
}

/** How long a clip lasts on the timeline, in seconds. */
export function clipDuration(clip: Clip): number {
  if ("words" in clip) return clip.words.length ? clip.words[clip.words.length - 1].end : 0;
  if ("duration" in clip) return clip.duration;
  return ms((clip.out - clip.in) / clip.speed);
}
/** The end of the last clip on any track: the length of the rendered video. */
export function editDuration(doc: EditDoc): number {
  let end = 0;
  for (const track of doc.tracks) for (const clip of track.clips) end = Math.max(end, ms(clip.start + clipDuration(clip)));
  return end;
}

function clip(kind: TrackKind, raw: unknown, path: string, ids: Set<string>): Clip {
  const c = obj(raw);
  const base = { id: id(c.id, `${path}.id`, ids), start: number(c.start, `${path}.start`, 0, LIMITS.maxDuration, 0) };
  if (kind === "caption") {
    const style = (c.style ?? "plain") as CaptionStyle;
    if (!CAPTION_STYLES.includes(style)) fail("invalid", `${path}.style`, `must be one of ${CAPTION_STYLES.join(", ")}.`);
    let last = 0;
    const words = list(c.words, `${path}.words`, LIMITS.maxWords).map((w, i): CaptionWord => {
      const word = obj(w);
      const p = `${path}.words[${i}]`;
      const start = number(word.start, `${p}.start`, 0, LIMITS.maxDuration);
      const end = number(word.end, `${p}.end`, 0, LIMITS.maxDuration);
      if (end <= start) fail("out_of_range", `${p}.end`, "must be after start.");
      if (start < last) fail("overlap", `${p}.start`, "starts before the word before it ends.");
      last = end;
      return { text: text(word.text, `${p}.text`, 100), start, end };
    });
    if (!words.length) fail("invalid", `${path}.words`, "a caption needs at least one word.");
    return { ...base, style, words };
  }
  if (kind === "text") {
    const duration = number(c.duration, `${path}.duration`, 0.001, LIMITS.maxDuration);
    const color = c.color ?? "#FFFFFF";
    if (typeof color !== "string" || !COLOR.test(color)) fail("invalid", `${path}.color`, "must be a colour like #FFFFFF.");
    const font = c.font === undefined || c.font === null ? null : text(c.font, `${path}.font`, 64);
    return {
      ...base, ...fades(c, path, duration), text: text(c.text, `${path}.text`, LIMITS.maxText), duration, font, color: color.toUpperCase(),
      fontSize: number(c.fontSize, `${path}.fontSize`, LIMITS.fontSize[0], LIMITS.fontSize[1], 64),
      transform: transform(c.transform, `${path}.transform`), transitionIn: transition(c.transitionIn, `${path}.transitionIn`, duration),
    };
  }
  const src = source(c, path);
  const length = ms((src.out - src.in) / src.speed);
  if (kind === "audio") return { ...base, ...src, ...fades(c, path, length) };
  return { ...base, ...src, ...fades(c, path, length), transform: transform(c.transform, `${path}.transform`), transitionIn: transition(c.transitionIn, `${path}.transitionIn`, length) };
}

/** Validates and trims an edit document from the page or an agent. Throws `EditError` with a message a person can act on. */
export function normalizeEdit(input: unknown): EditDoc {
  const raw = obj(input);
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== SCHEMA_VERSION) fail("unsupported_version", "schemaVersion", `version ${String(raw.schemaVersion)} is not supported (this build reads ${SCHEMA_VERSION}).`);
  const p = obj(raw.project);
  const size = (p.size ?? "9:16") as SizePreset;
  if (!Object.hasOwn(SIZES, size)) fail("invalid", "project.size", `must be one of ${Object.keys(SIZES).join(", ")}.`);
  const fps = (p.fps ?? 30) as Fps;
  if (!FPS.includes(fps)) fail("invalid", "project.fps", `must be one of ${FPS.join(", ")}.`);
  const project: EditProject = { size, ...SIZES[size], fps };

  const trackIds = new Set<string>();
  const clipIds = new Set<string>();
  const tracks = list(raw.tracks, "tracks", LIMITS.maxTracks).map((item, t): Track => {
    const tr = obj(item);
    const path = `tracks[${t}]`;
    const trackId = id(tr.id, `${path}.id`, trackIds);
    const kind = tr.kind as TrackKind;
    if (!TRACK_KINDS.includes(kind)) fail("invalid", `${path}.kind`, `must be one of ${TRACK_KINDS.join(", ")}.`);
    const clips = list(tr.clips, `${path}.clips`, LIMITS.maxClipsPerTrack).map((c, i) => clip(kind, c, `${path}.clips[${i}]`, clipIds));
    // Clips on one track can't overlap, except by the later clip's fade-in transition (rendered as a cross-fade).
    const order = clips.map((c, i) => ({ c, i })).sort((a, b) => a.c.start - b.c.start);
    for (let k = 1; k < order.length; k++) {
      const prev = order[k - 1].c;
      const cur = order[k].c;
      const allowed = "transitionIn" in cur && cur.transitionIn ? cur.transitionIn.duration : 0;
      if (cur.start + allowed + 1e-9 < prev.start + clipDuration(prev)) fail("overlap", `${path}.clips[${order[k].i}].start`, `overlaps clip ${prev.id} on the same track.`);
    }
    return { id: trackId, kind, clips } as Track;
  });

  const doc: EditDoc = { schemaVersion: SCHEMA_VERSION, project, tracks };
  const total = editDuration(doc);
  if (total > LIMITS.maxDuration) fail("too_long", "tracks", `the edit is ${total} s long; the most is ${LIMITS.maxDuration} s.`);
  return doc;
}
