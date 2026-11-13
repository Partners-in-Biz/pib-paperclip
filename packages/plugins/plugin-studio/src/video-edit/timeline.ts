/**
 * The video edit document (timeline JSON). Pure: no I/O, so the page, the ops, the store and the ffmpeg compiler all
 * share it. Times are seconds on the timeline, rounded to milliseconds. `normalizeEdit` keeps only the fields below,
 * fills defaults and refuses anything out of range with an `EditError` that names the field.
 * Version 1: static transforms, crop, speed, volume, fades and a fade-in transition. Version 2 (Phase D) adds the other
 * `TRANSITIONS` and per-clip `keyframes`. Version 3 (PAR-8279 slice 2) adds `adjust` and `look` on video and overlay
 * clips. Version 4 (slice 3) adds `blendMode`, `chromaKey` and `frame` on overlay clips. Rollback-safe writer: `normalizeEdit` reads every version in `SCHEMA_VERSIONS` and writes the lowest one that
 * holds the doc, from the `FEATURE_VERSION` table, so a plain edit stays readable by the previous build. Builds before
 * Studio 0.1.49 read version 1 only and do not have this guard.
 */
import { StudioError } from "../errors.js";
import { ADJUST_RANGE, NEUTRAL_ADJUST, PIB_BASIC_IDS, type Adjust, type LookRef } from "./looks.js";

/** The newest schema version this build reads; `normalizeEdit` writes the lowest version that holds the doc. */
export const SCHEMA_VERSION = 4;
export const SCHEMA_VERSIONS = [1, 2, 3, 4] as const;
export type SchemaVersion = (typeof SCHEMA_VERSIONS)[number];
/** Transitions between main-track clips (ffmpeg xfade names). Only `fade` is version 1. */
export const TRANSITIONS = [
  "fade", "fadeblack", "fadewhite", "dissolve", "wipeleft", "wiperight", "wipeup", "wipedown",
  "slideleft", "slideright", "slideup", "slidedown", "circleopen", "circleclose", "zoomin",
] as const;
export type TransitionType = (typeof TRANSITIONS)[number];
export const EASES = ["linear", "easeIn", "easeOut", "easeInOut", "hold"] as const;
export type Ease = (typeof EASES)[number];
export const KEYFRAME_PROPS = ["x", "y", "scale", "rotate", "opacity", "volume"] as const;
export type KeyframeProp = (typeof KEYFRAME_PROPS)[number];
export const SIZES = { "9:16": { width: 1080, height: 1920 }, "1:1": { width: 1080, height: 1080 }, "4:5": { width: 1080, height: 1350 }, "16:9": { width: 1920, height: 1080 } } as const;
export type SizePreset = keyof typeof SIZES;
export const FPS = [24, 25, 30, 60] as const;
export type Fps = (typeof FPS)[number];
export const TRACK_KINDS = ["video", "overlay", "text", "caption", "audio"] as const;
export type TrackKind = (typeof TRACK_KINDS)[number];
export const CAPTION_STYLES = ["plain", "bold", "karaoke"] as const;
export type CaptionStyle = (typeof CAPTION_STYLES)[number];
/** Colour adjust fields in their fixed output order (ranges and formulas in looks.ts; blur is sigma at 1080 px). */
export const ADJUST_FIELDS = ["brightness", "contrast", "saturation", "temperature", "blur", "vignette"] as const;
export const LOOK_PACKS = ["pib-basic"] as const;
/** How an overlay clip mixes with the layers under it (schema v4). `normal` is the default and is never stored. */
export const BLEND_MODES = ["normal", "multiply", "screen", "overlay", "darken", "lighten", "addition", "difference", "softlight"] as const;
export type BlendMode = (typeof BLEND_MODES)[number];

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
  maxKeyframes: 50,
  opacity: [0, 1],
  similarity: [0.01, 1],
  borderWidth: [0, 40],
  cornerRadius: [0, 50],
} as const;

export interface Crop { left: number; top: number; right: number; bottom: number }
/** x/y: offset of the clip's centre from the frame's centre in px; scale 1 = fit; rotate in degrees; crop as fractions. */
export interface Transform { x: number; y: number; scale: number; rotate: number; crop: Crop }
export interface Transition { type: TransitionType; duration: number }
/** Keys out `color` (#RRGGBB): similarity 0.01..1 (how close counts), blend 0..1 (edge softness), spill 0..1 (despill). */
export interface ChromaKey { color: string; similarity: number; blend: number; spill: number }
/** A border of `borderWidth` px (at the project size) in `borderColor`, corners rounded by `cornerRadius` % of the short side. */
export interface Frame { borderWidth: number; borderColor: string; cornerRadius: number }
/** `t`: seconds from the clip's own `start` (a transition's overlap included), 0..clip duration. */
export interface Keyframe { t: number; value: number; ease: Ease }
/** Only properties with at least one key are kept; an empty `keyframes` is dropped. */
export type Keyframes = Partial<Record<KeyframeProp, Keyframe[]>>;
interface Timed { id: string; start: number; fadeIn: number; fadeOut: number; keyframes?: Keyframes }
/** `adjust` holds only non-neutral fields (absent when all are neutral); `look` is a pack look at an intensity 0..1. */
export interface MediaClip extends Timed { assetId: string; version: number; in: number; out: number; speed: number; volume: number; transform: Transform; transitionIn: Transition | null; adjust?: Partial<Adjust>; look?: LookRef; blendMode?: Exclude<BlendMode, "normal">; chromaKey?: ChromaKey; frame?: Frame }
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
export interface EditDoc { schemaVersion: SchemaVersion; project: EditProject; tracks: Track[] }

export type EditErrorReason =
  | "invalid" | "out_of_range" | "too_many" | "duplicate" | "overlap" | "too_long" | "unsupported_version" | "not_found"
  | "unknown_transition" | "unknown_ease" | "keyframe_limit" | "keyframe_order" | "no_audio" | "unknown_look" | "unknown_blend";

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
  const type = (t.type ?? "fade") as TransitionType;
  if (!TRANSITIONS.includes(type)) fail("unknown_transition", `${path}.type`, `must be one of ${TRANSITIONS.join(", ")}.`);
  const duration = number(t.duration, `${path}.duration`, 0.001, LIMITS.maxTransition);
  if (duration > length) fail("out_of_range", `${path}.duration`, "is longer than the clip.");
  return { type, duration };
}

const KEY_RANGE: Record<KeyframeProp, readonly [number, number]> = {
  x: LIMITS.offset, y: LIMITS.offset, scale: LIMITS.scale, rotate: LIMITS.rotate, opacity: LIMITS.opacity, volume: LIMITS.volume,
};
/**
 * A clip's keyframes: `allowed` lists the properties its kind can animate; `volume` also needs sound (`silent` = the
 * clip has none). Each list is sorted by unique `t` in 0..length, at most `LIMITS.maxKeyframes`. Returns {} for none.
 */
function keyframes(value: unknown, path: string, length: number, allowed: readonly KeyframeProp[], silent: boolean): { keyframes?: Keyframes } {
  if (value === undefined || value === null || (Array.isArray(value) && !value.length)) return {};
  if (typeof value !== "object" || Array.isArray(value)) fail("invalid", path, "must be an object of property lists.");
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!(KEYFRAME_PROPS as readonly string[]).includes(key)) fail("invalid", `${path}.${key}`, `is not animatable; use ${KEYFRAME_PROPS.join(", ")}.`);
    if (!allowed.includes(key as KeyframeProp) && key !== "volume") fail("invalid", `${path}.${key}`, `this clip can only animate ${allowed.join(", ")}.`);
  }
  const out: Keyframes = {};
  for (const prop of KEYFRAME_PROPS) {
    const p = `${path}.${prop}`;
    if (raw[prop] !== undefined && raw[prop] !== null && !Array.isArray(raw[prop])) fail("invalid", p, "must be a list.");
    const items = (raw[prop] ?? []) as unknown[];
    if (!items.length) continue;
    if (prop === "volume" && (silent || !allowed.includes("volume"))) fail("no_audio", p, "this clip has no sound to change the volume of.");
    if (items.length > LIMITS.maxKeyframes) fail("keyframe_limit", p, `holds at most ${LIMITS.maxKeyframes} keyframes.`);
    const [lo, hi] = KEY_RANGE[prop];
    let last = -1;
    out[prop] = items.map((item, i): Keyframe => {
      const k = obj(item);
      const t = number(k.t, `${p}[${i}].t`, 0, length);
      if (t <= last) fail("keyframe_order", `${p}[${i}].t`, t === last ? `two keyframes at ${t} s.` : "keyframes must be in time order.");
      last = t;
      const ease = (k.ease ?? "linear") as Ease;
      if (!EASES.includes(ease)) fail("unknown_ease", `${p}[${i}].ease`, `must be one of ${EASES.join(", ")}.`);
      return { t, value: number(k.value, `${p}[${i}].value`, lo, hi), ease };
    });
  }
  return Object.keys(out).length ? { keyframes: out } : {};
}
const MEDIA_KEYS: readonly KeyframeProp[] = KEYFRAME_PROPS;
const TEXT_KEYS: readonly KeyframeProp[] = ["x", "y", "scale", "rotate", "opacity"];
const AUDIO_KEYS: readonly KeyframeProp[] = ["volume"];

/** A clip's colour adjust: known fields in range, neutral ones dropped, `{}` when nothing is left. */
function adjust(value: unknown, path: string): { adjust?: Partial<Adjust> } {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) fail("invalid", path, "must be an object.");
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!(ADJUST_FIELDS as readonly string[]).includes(key)) fail("invalid", `${path}.${key}`, `is not an adjust field; use ${ADJUST_FIELDS.join(", ")}.`);
  const out: Partial<Adjust> = {};
  for (const field of ADJUST_FIELDS) {
    const [lo, hi] = ADJUST_RANGE[field];
    const v = number(raw[field], `${path}.${field}`, lo, hi, NEUTRAL_ADJUST[field]);
    if (v !== NEUTRAL_ADJUST[field]) out[field] = v;
  }
  return Object.keys(out).length ? { adjust: out } : {};
}
/** A clip's look: a known pack (default pib-basic) and look id, intensity 0..1 (default 1). */
function look(value: unknown, path: string): { look?: LookRef } {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) fail("invalid", path, "must be an object.");
  const l = value as Record<string, unknown>;
  const pack = l.pack ?? "pib-basic";
  if (!(LOOK_PACKS as readonly unknown[]).includes(pack)) fail("unknown_look", `${path}.pack`, `must be one of ${LOOK_PACKS.join(", ")}.`);
  if (typeof l.id !== "string" || !PIB_BASIC_IDS.includes(l.id)) fail("unknown_look", `${path}.id`, `must be one of ${PIB_BASIC_IDS.join(", ")}.`);
  return { look: { pack: pack as LookRef["pack"], id: l.id, intensity: number(l.intensity, `${path}.intensity`, 0, 1, 1) } };
}

function hex(value: unknown, path: string, fallback?: string): string {
  if ((value === undefined || value === null) && fallback !== undefined) return fallback;
  if (typeof value !== "string" || !COLOR.test(value)) fail("invalid", path, "must be a colour like #00FF00.");
  return value.toUpperCase();
}
function optionalObj(value: unknown, path: string): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) fail("invalid", path, "must be an object.");
  return value as Record<string, unknown>;
}
function only(raw: Record<string, unknown>, path: string, keys: readonly string[]): void {
  for (const key of Object.keys(raw)) if (!keys.includes(key)) fail("invalid", `${path}.${key}`, `is not a field here; use ${keys.join(", ")}.`);
}
/** Overlay layering (schema v4): blend mode (`normal` dropped), chroma key, frame (dropped when it draws nothing). */
function layer(c: Record<string, unknown>, path: string): { blendMode?: Exclude<BlendMode, "normal">; chromaKey?: ChromaKey; frame?: Frame } {
  const out: { blendMode?: Exclude<BlendMode, "normal">; chromaKey?: ChromaKey; frame?: Frame } = {};
  const mode = c.blendMode ?? "normal";
  if (typeof mode !== "string" || !(BLEND_MODES as readonly string[]).includes(mode)) fail("unknown_blend", `${path}.blendMode`, `must be one of ${BLEND_MODES.join(", ")}.`);
  if (mode !== "normal") out.blendMode = mode as Exclude<BlendMode, "normal">;
  const k = optionalObj(c.chromaKey, `${path}.chromaKey`);
  if (k) {
    const p = `${path}.chromaKey`;
    only(k, p, ["color", "similarity", "blend", "spill"]);
    out.chromaKey = { color: hex(k.color, `${p}.color`), similarity: number(k.similarity, `${p}.similarity`, LIMITS.similarity[0], LIMITS.similarity[1], 0.1), blend: number(k.blend, `${p}.blend`, 0, 1, 0), spill: number(k.spill, `${p}.spill`, 0, 1, 0) };
  }
  const f = optionalObj(c.frame, `${path}.frame`);
  if (f) {
    const p = `${path}.frame`;
    only(f, p, ["borderWidth", "borderColor", "cornerRadius"]);
    const frame = { borderWidth: number(f.borderWidth, `${p}.borderWidth`, LIMITS.borderWidth[0], LIMITS.borderWidth[1], 0), borderColor: hex(f.borderColor, `${p}.borderColor`, "#FFFFFF"), cornerRadius: number(f.cornerRadius, `${p}.cornerRadius`, LIMITS.cornerRadius[0], LIMITS.cornerRadius[1], 0) };
    if (frame.borderWidth || frame.cornerRadius) out.frame = frame;
  }
  return out;
}

/** Optional facts `normalizeEdit` can't see in the doc. `hasAudio` false = that asset version has no sound. */
export interface NormalizeOptions { hasAudio?: (assetId: string, version: number) => boolean | undefined }
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

function clip(kind: TrackKind, raw: unknown, path: string, ids: Set<string>, options: NormalizeOptions): Clip {
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
      ...keyframes(c.keyframes, `${path}.keyframes`, duration, TEXT_KEYS, true),
    };
  }
  const src = source(c, path);
  const length = ms((src.out - src.in) / src.speed);
  const silent = options.hasAudio?.(src.assetId, src.version) === false;
  if (kind === "audio") return { ...base, ...src, ...fades(c, path, length), ...keyframes(c.keyframes, `${path}.keyframes`, length, AUDIO_KEYS, silent) };
  return {
    ...base, ...src, ...fades(c, path, length), transform: transform(c.transform, `${path}.transform`), transitionIn: transition(c.transitionIn, `${path}.transitionIn`, length),
    ...keyframes(c.keyframes, `${path}.keyframes`, length, MEDIA_KEYS, silent), ...adjust(c.adjust, `${path}.adjust`), ...look(c.look, `${path}.look`),
    ...(kind === "overlay" ? layer(c, path) : {}),
  };
}

/** The schema version a field needs; a record maps the field's values (an enum) to the version each needs. */
export type Since = SchemaVersion | Readonly<Record<string, SchemaVersion>>;
const each = (paths: readonly string[], v: SchemaVersion) => Object.fromEntries(paths.map((p) => [p, v])) as Record<string, SchemaVersion>;
/**
 * Every leaf a normalised doc can hold (path as `featurePaths` writes it: lists as `[]`, any track's clip as `clip`),
 * with the schema version that introduced it. The writer stamps the highest version of the leaves present, so a new
 * field MUST get a row here: `requiredVersion` throws on a leaf it does not know rather than write too low a version.
 */
export const FEATURE_VERSION: Readonly<Record<string, Since>> = {
  ...each(["project.size", "project.width", "project.height", "project.fps", "tracks[].id", "tracks[].kind"], 1),
  ...each(["id", "start", "fadeIn", "fadeOut", "assetId", "version", "in", "out", "speed", "volume", "text", "duration", "font", "color", "fontSize", "style", "words[].text", "words[].start", "words[].end"].map((k) => `clip.${k}`), 1),
  ...each([...["x", "y", "scale", "rotate"].map((k) => `transform.${k}`), ...["left", "top", "right", "bottom"].map((k) => `transform.crop.${k}`)].map((k) => `clip.${k}`), 1),
  "clip.transitionIn": 1, // null: no transition
  "clip.transitionIn.duration": 1,
  "clip.transitionIn.type": Object.fromEntries(TRANSITIONS.map((t) => [t, t === "fade" ? 1 : 2])),
  ...each(KEYFRAME_PROPS.flatMap((p) => ["t", "value", "ease"].map((k) => `clip.keyframes.${p}[].${k}`)), 2),
  ...each(ADJUST_FIELDS.map((f) => `clip.adjust.${f}`), 3),
  ...each(["pack", "id", "intensity"].map((k) => `clip.look.${k}`), 3),
  "clip.blendMode": Object.fromEntries(BLEND_MODES.filter((m) => m !== "normal").map((m) => [m, 4])),
  ...each([...["color", "similarity", "blend", "spill"].map((k) => `clip.chromaKey.${k}`), ...["borderWidth", "borderColor", "cornerRadius"].map((k) => `clip.frame.${k}`)], 4),
};

/** Each leaf of a doc (without `schemaVersion`) as [FEATURE_VERSION path, value]. */
export function featurePaths(doc: Pick<EditDoc, "project" | "tracks">): [string, unknown][] {
  const out: [string, unknown][] = [];
  const walk = (value: unknown, path: string) => {
    if (Array.isArray(value)) value.forEach((v) => walk(v, `${path}[]`));
    else if (value !== null && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
    else out.push([path, value]);
  };
  walk(doc.project, "project");
  for (const track of doc.tracks) {
    for (const [k, v] of Object.entries(track)) if (k !== "clips") walk(v, `tracks[].${k}`);
    for (const c of track.clips) for (const [k, v] of Object.entries(c)) walk(v, `clip.${k}`);
  }
  return out;
}

/** The lowest schema version that holds the doc. Throws (a bug, not a bad doc) on a leaf `FEATURE_VERSION` lacks. */
export function requiredVersion(doc: Pick<EditDoc, "project" | "tracks">): SchemaVersion {
  let version: SchemaVersion = 1;
  for (const [path, value] of featurePaths(doc)) {
    const since = Object.hasOwn(FEATURE_VERSION, path) ? FEATURE_VERSION[path] : undefined;
    const v = typeof since === "object" ? (Object.hasOwn(since, String(value)) ? since[String(value)] : undefined) : since;
    if (v === undefined) throw new Error(`timeline: ${path} = ${String(value)} has no FEATURE_VERSION row`);
    if (v > version) version = v;
  }
  return version;
}

/**
 * Validates and trims an edit document from the page or an agent. Throws `EditError` with a message a person can act on.
 * Reads every version in `SCHEMA_VERSIONS`; the result has the lowest version that holds it (`requiredVersion`).
 */
export function normalizeEdit(input: unknown, options: NormalizeOptions = {}): EditDoc {
  const raw = obj(input);
  if (raw.schemaVersion !== undefined && !(SCHEMA_VERSIONS as readonly unknown[]).includes(raw.schemaVersion)) {
    fail("unsupported_version", "schemaVersion", `version ${String(raw.schemaVersion)} is not supported (this build reads ${SCHEMA_VERSIONS.join(", ")}).`);
  }
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
    const clips = list(tr.clips, `${path}.clips`, LIMITS.maxClipsPerTrack).map((c, i) => clip(kind, c, `${path}.clips[${i}]`, clipIds, options));
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

  const doc: EditDoc = { schemaVersion: requiredVersion({ project, tracks }), project, tracks };
  const total = editDuration(doc);
  if (total > LIMITS.maxDuration) fail("too_long", "tracks", `the edit is ${total} s long; the most is ${LIMITS.maxDuration} s.`);
  return doc;
}
