/**
 * Edit operations on a video edit document. Pure: `applyOps(edit, ops)` returns a new, normalised document or throws an
 * `OpError` that names the op (`opIndex`). All or none: the input is never changed, and when one op fails none apply.
 * The edit is run through `normalizeEdit` after every op, so an op that breaks a limit (overlap, range, length) is
 * refused at that op. Times are timeline seconds, rounded to milliseconds.
 *
 * - `trim` changes a media/audio clip's source in/out and keeps its start (use `move` to shift it). Args: `clipId`,
 *   `in?`, `out?`, `ripple?` (default false). With `ripple: true` every later clip on the same track (start >= the
 *   clip's old end) shifts by the change in the clip's length, so no gap opens (or the clips make room); other tracks
 *   never move. Without it the later clips stay put: a shorter clip leaves a gap, a longer one may overlap (refused).
 * - `split` and `trim` shorten fades and the fade-in transition to fit the new length; `split` leaves no fade at the cut.
 * - `reorder` sets the track order (first track is the bottom layer); `removeTrack` removes the track with its clips.
 */
import { clipDuration, EditError, normalizeEdit, type Clip, type EditDoc, type EditErrorReason, type Track, type TrackKind } from "./timeline.js";

export const MAX_OPS = 500;
export const OP_NAMES = ["addClip", "split", "trim", "move", "delete", "reorder", "setProps", "addTrack", "removeTrack", "setProject"] as const;
export type OpName = (typeof OP_NAMES)[number];

export type EditOp =
  | { op: "addClip"; trackId: string; clip: Record<string, unknown> }
  | { op: "split"; clipId: string; at: number; newId?: string }
  | { op: "trim"; clipId: string; in?: number; out?: number; ripple?: boolean }
  | { op: "move"; clipId: string; start?: number; trackId?: string }
  | { op: "delete"; clipId: string }
  | { op: "reorder"; trackIds: string[] }
  | { op: "setProps"; clipId: string; props: Record<string, unknown> }
  | { op: "addTrack"; track: { id: string; kind: TrackKind; clips?: unknown[] }; index?: number }
  | { op: "removeTrack"; trackId: string }
  | { op: "setProject"; size?: string; fps?: number };

/** A refused op. `opIndex` is the failing op (-1 when the op list itself is wrong); no op of the call was applied. */
export class OpError extends EditError {
  constructor(message: string, reason: EditErrorReason, path: string, readonly opIndex: number) {
    super(message, reason, path);
    this.name = "OpError";
  }
}

const SOURCE_PROPS = ["assetId", "version", "in", "out", "start", "speed", "volume", "fadeIn", "fadeOut"];
/** What `setProps` may change, per track kind. `id` never changes: delete and add instead. */
const PROPS: Record<TrackKind, readonly string[]> = {
  video: [...SOURCE_PROPS, "transform", "transitionIn"],
  overlay: [...SOURCE_PROPS, "transform", "transitionIn"],
  audio: SOURCE_PROPS,
  text: ["text", "start", "duration", "font", "color", "fontSize", "fadeIn", "fadeOut", "transform", "transitionIn"],
  caption: ["start", "style", "words"],
};

const ms = (n: number) => Math.round(n * 1000) / 1000;
type Args = Record<string, unknown>;

function fail(i: number, reason: EditErrorReason, field: string, message: string): never {
  const path = field ? `ops[${i}].${field}` : `ops[${i}]`;
  throw new OpError(`${path}: ${message}`, reason, path, i);
}
function record(value: unknown): Args | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Args) : null;
}
function idArg(o: Args, key: string, i: number): string {
  const v = o[key];
  if (typeof v !== "string" || !v) fail(i, "invalid", key, "must be an id.");
  return v;
}
function numArg(o: Args, key: string, i: number): number | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) fail(i, "invalid", key, "must be a number.");
  return ms(v);
}
function objArg(o: Args, key: string, i: number): Args {
  const v = record(o[key]);
  if (!v) fail(i, "invalid", key, "must be an object.");
  return v;
}
const clipsOf = (track: Track) => track.clips as Clip[];
const sortClips = (track: Track) => clipsOf(track).sort((a, b) => a.start - b.start);

function findTrack(doc: EditDoc, trackId: string, i: number, field: string): { track: Track; index: number } {
  const index = doc.tracks.findIndex((t) => t.id === trackId);
  if (index < 0) fail(i, "not_found", field, `there is no track ${trackId}.`);
  return { track: doc.tracks[index], index };
}
function findClip(doc: EditDoc, clipId: string, i: number): { track: Track; index: number; clip: Clip } {
  for (const track of doc.tracks) {
    const index = clipsOf(track).findIndex((c) => c.id === clipId);
    if (index >= 0) return { track, index, clip: clipsOf(track)[index] };
  }
  fail(i, "not_found", "clipId", `there is no clip ${clipId}.`);
}
/** `<id>-2`, `<id>-3`, ...: the first clip id not in use. */
function freeId(doc: EditDoc, base: string): string {
  const used = new Set(doc.tracks.flatMap((t) => clipsOf(t).map((c) => c.id)));
  const stem = base.slice(0, 58);
  for (let n = 2; ; n++) if (!used.has(`${stem}-${n}`)) return `${stem}-${n}`;
}
/** Shortens fades and the fade-in transition so they fit a clip of `length` seconds. */
function fitFades(clip: Clip, length: number): Clip {
  const c = { ...clip } as Clip & { fadeIn?: number; fadeOut?: number; transitionIn?: { type: "fade"; duration: number } | null };
  if (c.fadeIn !== undefined && c.fadeOut !== undefined) {
    c.fadeIn = Math.min(c.fadeIn, length);
    c.fadeOut = Math.min(c.fadeOut, ms(length - c.fadeIn));
  }
  if (c.transitionIn && c.transitionIn.duration > length) c.transitionIn = { ...c.transitionIn, duration: length };
  return c;
}
/** Clips move between tracks of the same kind; video and overlay clips share a shape, so they move between those too. */
const PICTURE: readonly TrackKind[] = ["video", "overlay"];
const compatible = (from: TrackKind, to: TrackKind) => from === to || (PICTURE.includes(from) && PICTURE.includes(to));

function split(doc: EditDoc, o: Args, i: number): void {
  const clipId = idArg(o, "clipId", i);
  const at = numArg(o, "at", i);
  if (at === undefined) fail(i, "invalid", "at", "is required.");
  const { track, index, clip } = findClip(doc, clipId, i);
  const end = ms(clip.start + clipDuration(clip));
  if (at <= clip.start || at >= end) fail(i, "out_of_range", "at", `must be inside clip ${clipId} (${clip.start} to ${end} s).`);
  const newId = o.newId === undefined ? freeId(doc, clipId) : idArg(o, "newId", i);
  const offset = ms(at - clip.start);
  let left: Clip;
  let right: Clip;
  if ("words" in clip) {
    const before = clip.words.filter((w) => w.end <= offset);
    const after = clip.words.filter((w) => w.start >= offset);
    if (before.length + after.length < clip.words.length) fail(i, "out_of_range", "at", "falls inside a word; split between words.");
    if (!before.length || !after.length) fail(i, "out_of_range", "at", "leaves one part without words.");
    left = { ...clip, words: before };
    right = { ...clip, id: newId, start: at, words: after.map((w) => ({ ...w, start: ms(w.start - offset), end: ms(w.end - offset) })) };
  } else if ("duration" in clip) {
    left = fitFades({ ...clip, duration: offset, fadeOut: 0 }, offset);
    right = fitFades({ ...clip, id: newId, start: at, duration: ms(end - at), fadeIn: 0, transitionIn: null }, ms(end - at));
  } else {
    const cut = ms(clip.in + offset * clip.speed);
    if (cut <= clip.in || cut >= clip.out) fail(i, "out_of_range", "at", "is too close to the clip's edge at this speed.");
    const l = { ...clip, out: cut, fadeOut: 0 };
    left = fitFades(l, clipDuration(l));
    // The right part starts where the left part really ends, so ms rounding at odd speeds can't make them overlap.
    const r = { ...clip, id: newId, start: ms(clip.start + clipDuration(l)), in: cut, fadeIn: 0, ...("transitionIn" in clip ? { transitionIn: null } : {}) };
    right = fitFades(r, clipDuration(r));
  }
  clipsOf(track).splice(index, 1, left, right);
}

function run(doc: EditDoc, raw: unknown, i: number): void {
  const o = record(raw);
  if (!o) fail(i, "invalid", "", "must be an object with an op.");
  switch (o.op as OpName) {
    case "addClip": {
      const { track } = findTrack(doc, idArg(o, "trackId", i), i, "trackId");
      clipsOf(track).push({ ...objArg(o, "clip", i) } as unknown as Clip);
      sortClips(track);
      return;
    }
    case "split":
      return split(doc, o, i);
    case "trim": {
      const { track, index, clip } = findClip(doc, idArg(o, "clipId", i), i);
      if (!("assetId" in clip)) fail(i, "invalid", "clipId", `clip ${clip.id} has no source to trim; change its duration or words with setProps.`);
      const inPoint = numArg(o, "in", i);
      const out = numArg(o, "out", i);
      if (inPoint === undefined && out === undefined) fail(i, "invalid", "", "give in, out or both.");
      const next = { ...clip, in: inPoint ?? clip.in, out: out ?? clip.out };
      if (next.in < 0) fail(i, "out_of_range", "in", "can't be before the start of the source.");
      if (next.out <= next.in) fail(i, "out_of_range", out === undefined ? "in" : "out", "out must be after in.");
      if (o.ripple !== undefined && typeof o.ripple !== "boolean") fail(i, "invalid", "ripple", "must be true or false.");
      const length = ms((next.out - next.in) / next.speed);
      const oldEnd = ms(clip.start + clipDuration(clip));
      const shift = o.ripple ? ms(clip.start + length - oldEnd) : 0;
      if (shift) {
        // Later clips move as one block, so their gaps keep their size; normalizeEdit still checks range and length.
        clipsOf(track).forEach((c, j) => {
          if (j !== index && c.start >= oldEnd) clipsOf(track)[j] = { ...c, start: ms(c.start + shift) };
        });
      }
      clipsOf(track)[index] = fitFades(next, length);
      return;
    }
    case "move": {
      const found = findClip(doc, idArg(o, "clipId", i), i);
      const start = numArg(o, "start", i);
      const trackId = o.trackId === undefined ? undefined : idArg(o, "trackId", i);
      if (start === undefined && trackId === undefined) fail(i, "invalid", "", "give start, trackId or both.");
      if (start !== undefined && start < 0) fail(i, "out_of_range", "start", "can't be before 0.");
      const moved = { ...found.clip, start: start ?? found.clip.start };
      let target = found.track;
      if (trackId !== undefined && trackId !== found.track.id) {
        target = findTrack(doc, trackId, i, "trackId").track;
        if (!compatible(found.track.kind, target.kind)) fail(i, "invalid", "trackId", `a ${found.track.kind} clip can't go on a ${target.kind} track.`);
      }
      clipsOf(found.track).splice(found.index, 1);
      clipsOf(target).push(moved);
      sortClips(target);
      return;
    }
    case "delete": {
      const { track, index } = findClip(doc, idArg(o, "clipId", i), i);
      clipsOf(track).splice(index, 1);
      return;
    }
    case "reorder": {
      const ids = o.trackIds;
      if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string")) fail(i, "invalid", "trackIds", "must be a list of track ids.");
      const have = doc.tracks.map((t) => t.id);
      if (ids.length !== have.length || new Set(ids).size !== ids.length || !ids.every((x) => have.includes(x))) {
        fail(i, "invalid", "trackIds", `must list every track once: ${have.join(", ")}.`);
      }
      doc.tracks = (ids as string[]).map((x) => doc.tracks[have.indexOf(x)]);
      return;
    }
    case "setProps": {
      const { track, index, clip } = findClip(doc, idArg(o, "clipId", i), i);
      const props = objArg(o, "props", i);
      const keys = Object.keys(props);
      if (!keys.length) fail(i, "invalid", "props", "is empty.");
      for (const key of keys) {
        if (key === "id") fail(i, "invalid", "props.id", "a clip's id can't change; delete it and add a new clip.");
        if (!PROPS[track.kind].includes(key)) fail(i, "invalid", `props.${key}`, `is not a property of a ${track.kind} clip (one of ${PROPS[track.kind].join(", ")}).`);
      }
      const next = { ...clip, ...props } as Clip;
      if ("transform" in clip && props.transform !== undefined) {
        const t = record(props.transform) ?? {};
        (next as { transform: unknown }).transform = { ...clip.transform, ...t, crop: { ...clip.transform.crop, ...(record(t.crop) ?? {}) } };
      }
      clipsOf(track)[index] = next;
      sortClips(track);
      return;
    }
    case "addTrack": {
      const track = objArg(o, "track", i);
      const index = o.index === undefined ? doc.tracks.length : o.index;
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > doc.tracks.length) fail(i, "out_of_range", "index", `must be a whole number from 0 to ${doc.tracks.length}.`);
      doc.tracks.splice(index, 0, { ...track, clips: track.clips ?? [] } as unknown as Track);
      return;
    }
    case "removeTrack": {
      const { index } = findTrack(doc, idArg(o, "trackId", i), i, "trackId");
      doc.tracks.splice(index, 1);
      return;
    }
    case "setProject": {
      if (o.size === undefined && o.fps === undefined) fail(i, "invalid", "", "give size, fps or both.");
      doc.project = { ...doc.project, ...(o.size !== undefined ? { size: o.size } : {}), ...(o.fps !== undefined ? { fps: o.fps } : {}) } as EditDoc["project"];
      return;
    }
    default:
      fail(i, "invalid", "op", `must be one of ${OP_NAMES.join(", ")}.`);
  }
}

/** Applies `ops` in order to a copy of `edit` and returns the normalised result. Throws `OpError` and applies nothing on any failure. */
export function applyOps(edit: unknown, ops: readonly unknown[]): EditDoc {
  let doc = normalizeEdit(edit); // a fresh copy: nothing below can touch the caller's objects
  if (!Array.isArray(ops)) throw new OpError("ops: must be a list.", "invalid", "ops", -1);
  if (ops.length > MAX_OPS) throw new OpError(`ops: at most ${MAX_OPS} ops per call.`, "too_many", "ops", -1);
  ops.forEach((raw, i) => {
    run(doc, raw, i);
    try {
      doc = normalizeEdit(doc);
    } catch (error) {
      if (!(error instanceof EditError)) throw error;
      throw new OpError(`ops[${i}] (${String(record(raw)?.op)}) makes the edit invalid: ${error.message}`, error.reason, error.path, i);
    }
  });
  return doc;
}
