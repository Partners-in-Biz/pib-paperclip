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
 * - Keyframes (schema v2) follow the picture: `split` gives every keyframed property a key at the cut on both halves
 *   (same value, so nothing jumps), `trim` rebases key times, drops keys outside the clip and puts a key with the
 *   value there on each edge it moved inward. An op that would leave a property over `LIMITS.maxKeyframes` keys
 *   is refused with `keyframe_limit`.
 * - `setProps` sets `keyframes` per property (a list replaces that property's keys, `[]` or null removes them,
 *   `keyframes: null` removes all) and `transitionIn` of any `TRANSITIONS` type on video and overlay clips (overlay
 *   transitions are still refused when rendering); text clips only fade in.
 * - `setProps` on video and overlay clips also sets `adjust` (schema v3; merged per field, a neutral value removes that
 *   field, `adjust: null` removes all) and `look` (merged with the clip's look, so `{intensity}` alone changes the
 *   strength; `look: null` removes it). `split`, `trim` and `move` keep both on every part.
 * - `setProps` on overlay clips also sets `blendMode` (schema v4; "normal" removes it), `chromaKey` and `frame` (merged
 *   per field like `look`; null removes them). A clip moved to the video track drops all three (they are overlay-only).
 * - `reorder` sets the order of all tracks at once (first track is the bottom layer) and moves no clips; `moveTrack`
 *   moves one track to `toIndex` (0..tracks-1, the others keep their order). Its undo is `moveTrack` back to the old
 *   index (`moveTrackUndo`). `removeTrack` removes the track with its clips.
 */
import { clipDuration, EditError, KEYFRAME_PROPS, LIMITS, normalizeEdit, type Clip, type EditDoc, type EditErrorReason, type Keyframe, type Keyframes, type Track, type TrackKind, type Transition } from "./timeline.js";

export const MAX_OPS = 500;
export const OP_NAMES = ["addClip", "split", "trim", "move", "delete", "reorder", "moveTrack", "setProps", "addTrack", "removeTrack", "setProject"] as const;
export type OpName = (typeof OP_NAMES)[number];

export type EditOp =
  | { op: "addClip"; trackId: string; clip: Record<string, unknown> }
  | { op: "split"; clipId: string; at: number; newId?: string }
  | { op: "trim"; clipId: string; in?: number; out?: number; ripple?: boolean }
  | { op: "move"; clipId: string; start?: number; trackId?: string }
  | { op: "delete"; clipId: string }
  | { op: "reorder"; trackIds: string[] }
  | { op: "moveTrack"; trackId: string; toIndex: number }
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
  video: [...SOURCE_PROPS, "transform", "transitionIn", "keyframes", "adjust", "look"],
  overlay: [...SOURCE_PROPS, "transform", "transitionIn", "keyframes", "adjust", "look", "blendMode", "chromaKey", "frame"],
  audio: [...SOURCE_PROPS, "keyframes"],
  text: ["text", "start", "duration", "font", "color", "fontSize", "fadeIn", "fadeOut", "transform", "transitionIn", "keyframes"],
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
  const c = { ...clip } as Clip & { fadeIn?: number; fadeOut?: number; transitionIn?: Transition | null };
  if (c.fadeIn !== undefined && c.fadeOut !== undefined) {
    c.fadeIn = Math.min(c.fadeIn, length);
    c.fadeOut = Math.min(c.fadeOut, ms(length - c.fadeIn));
  }
  if (c.transitionIn && c.transitionIn.duration > length) c.transitionIn = { ...c.transitionIn, duration: length };
  return c;
}

/** How the move from one key to the next runs (the earlier key's ease), 0..1 -> 0..1; `hold` jumps at the next key. */
const EASE: Record<Keyframe["ease"], (p: number) => number> = {
  linear: (p) => p, easeIn: (p) => p * p, easeOut: (p) => p * (2 - p), easeInOut: (p) => p * p * (3 - 2 * p), hold: () => 0,
};
/** A keyed property's value at clip time `t`: the first key's value before it, the last key's after it. */
function valueAt(keys: readonly Keyframe[], t: number): number {
  if (t <= keys[0].t) return keys[0].value;
  for (let k = 1; k < keys.length; k++) {
    const a = keys[k - 1];
    const b = keys[k];
    if (t < b.t) return a.value + (b.value - a.value) * EASE[a.ease]((t - a.t) / (b.t - a.t));
  }
  return keys[keys.length - 1].value;
}
/** The ease of the move running at `t` (the last key at or before it), so a key put there keeps the curve's shape. */
const easeAt = (keys: readonly Keyframe[], t: number) => keys.filter((k) => k.t <= t).pop()?.ease ?? "linear";
/**
 * A clip's keys cut to the window `from`..`from + length` of its old clip time and rebased to start at 0. Keys outside
 * the window are dropped; each edge that cuts through the keys gets a key with the value there (`pin` puts one on that
 * edge in any case: split cuts every property). Refuses (`keyframe_limit`) a property that would end up over the cap.
 */
function fitKeys(keyframes: Keyframes | undefined, from: number, length: number, pin: { start?: boolean; end?: boolean }, i: number): { keyframes?: Keyframes } {
  if (!keyframes) return {};
  const to = ms(from + length);
  const out: Keyframes = {};
  for (const prop of KEYFRAME_PROPS) {
    const keys = keyframes[prop];
    if (!keys?.length) continue;
    const kept: Keyframe[] = [];
    for (const k of keys) {
      const t = Math.min(ms(k.t - from), length);
      if (k.t >= from && k.t <= to && !(kept.length && t <= kept[kept.length - 1].t)) kept.push({ ...k, t });
    }
    const edge = (t: number): Keyframe => ({ t: ms(t - from), value: ms(valueAt(keys, t)), ease: easeAt(keys, t) });
    if ((pin.start || keys[0].t < from) && kept[0]?.t !== 0) kept.unshift({ ...edge(from), t: 0 });
    if ((pin.end || keys[keys.length - 1].t > to) && kept[kept.length - 1]?.t !== length) kept.push({ ...edge(to), t: length });
    if (kept.length > LIMITS.maxKeyframes) fail(i, "keyframe_limit", `keyframes.${prop}`, `would leave ${kept.length} ${prop} keyframes on one clip; the most is ${LIMITS.maxKeyframes}.`);
    out[prop] = kept;
  }
  return { keyframes: out };
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
    const rest = ms(end - at);
    left = fitFades({ ...clip, duration: offset, fadeOut: 0, ...fitKeys(clip.keyframes, 0, offset, { end: true }, i) }, offset);
    right = fitFades({ ...clip, id: newId, start: at, duration: rest, fadeIn: 0, transitionIn: null, ...fitKeys(clip.keyframes, offset, rest, { start: true }, i) }, rest);
  } else {
    const cut = ms(clip.in + offset * clip.speed);
    if (cut <= clip.in || cut >= clip.out) fail(i, "out_of_range", "at", "is too close to the clip's edge at this speed.");
    const l = { ...clip, out: cut, fadeOut: 0 };
    const leftLength = clipDuration(l);
    left = fitFades({ ...l, ...fitKeys(clip.keyframes, 0, leftLength, { end: true }, i) }, leftLength);
    // The right part starts where the left part really ends, so ms rounding at odd speeds can't make them overlap.
    const r = { ...clip, id: newId, start: ms(clip.start + leftLength), in: cut, fadeIn: 0, ...("transitionIn" in clip ? { transitionIn: null } : {}) };
    right = fitFades({ ...r, ...fitKeys(clip.keyframes, leftLength, clipDuration(r), { start: true }, i) }, clipDuration(r));
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
      // Keys stay on the same source frames: a later in moves them earlier on the clip; each edge cut inward gets a key.
      const from = ms((next.in - clip.in) / clip.speed);
      const keys = fitKeys(clip.keyframes, from, length, { start: from > 0, end: ms(from + length) < clipDuration(clip) }, i);
      clipsOf(track)[index] = fitFades({ ...next, ...keys }, length);
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
    case "moveTrack": {
      const { track, index } = findTrack(doc, idArg(o, "trackId", i), i, "trackId");
      const to = o.toIndex;
      if (typeof to !== "number" || !Number.isInteger(to) || to < 0 || to >= doc.tracks.length) fail(i, "out_of_range", "toIndex", `must be a whole number from 0 to ${doc.tracks.length - 1}.`);
      doc.tracks.splice(index, 1);
      doc.tracks.splice(to, 0, track);
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
      const transitionIn = record(props.transitionIn);
      if (transitionIn) {
        // Transitions other than a fade join main-track clips; text only fades in (overlay ones are refused at render).
        if (track.kind === "text" && (transitionIn.type ?? "fade") !== "fade") fail(i, "unknown_transition", "props.transitionIn.type", "a text clip can only fade in.");
        if ("transitionIn" in clip && clip.transitionIn) (next as { transitionIn: unknown }).transitionIn = { ...clip.transitionIn, ...transitionIn };
      }
      if (props.keyframes !== undefined) {
        // Per property: a list replaces that property's keys, [] or null removes them; null removes every key.
        const keys = props.keyframes === null ? null : record(props.keyframes);
        if (props.keyframes !== null && !keys) fail(i, "invalid", "props.keyframes", "must be an object of property lists, or null.");
        (next as { keyframes?: unknown }).keyframes = keys ? { ...("keyframes" in clip ? clip.keyframes : {}), ...keys } : undefined;
      }
      // adjust and look merge into what the clip has; null removes them (normalizeEdit checks the result).
      if ("assetId" in clip && "transform" in clip) {
        const media = next as typeof clip;
        if (record(props.adjust) && clip.adjust) media.adjust = { ...clip.adjust, ...record(props.adjust) };
        if (record(props.look) && clip.look) media.look = { ...clip.look, ...record(props.look) } as typeof clip.look;
        if (record(props.chromaKey) && clip.chromaKey) media.chromaKey = { ...clip.chromaKey, ...record(props.chromaKey) } as typeof clip.chromaKey;
        if (record(props.frame) && clip.frame) media.frame = { ...clip.frame, ...record(props.frame) } as typeof clip.frame;
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

/** The op that undoes `moveTrack { trackId, toIndex }` on `before` (the doc it applies to): the track back to its index. */
export function moveTrackUndo(before: EditDoc, trackId: string): EditOp & { op: "moveTrack" } {
  const toIndex = before.tracks.findIndex((t) => t.id === trackId);
  if (toIndex < 0) throw new OpError(`there is no track ${trackId}.`, "not_found", "trackId", -1);
  return { op: "moveTrack", trackId, toIndex };
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
