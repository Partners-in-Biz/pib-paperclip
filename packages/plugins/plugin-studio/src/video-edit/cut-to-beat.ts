/**
 * Cut-to-beat (PAR-8279 D4e): the beats of a music clip (beats.ts) cut the clips of a video or overlay track. The
 * result is plain `trim` ops saved through `video-edit-apply-ops`, so they validate like hand-made edits and the
 * caller can show or undo them.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { StudioError } from "../errors.js";
import { applyOpsAction } from "./actions.js";
import { analysedWarning, gridFor, soundClip, text, timelineBeats, type BeatDeps } from "./beats.js";
import { applyOps, type EditOp } from "./ops.js";
import { getVideoEdit, type EditActor } from "./store.js";
import { clipDuration, type EditDoc, type MediaClip } from "./timeline.js";

/** Cuts are never closer to a clip's start than this. */
export const MIN_CUT_SEC = 0.1;
export const EVERY = [1, 2, 4] as const;

const ms = (x: number) => Math.round(x * 1000) / 1000;

function bad(message: string, code = "bad_edit"): never {
  throw new StudioError(message, code);
}

/**
 * `trim` ops (with ripple) that end every clip of `trackId` on the latest beat at or before its end, in order, so each
 * cut lands on a beat. A clip is left alone when no beat falls in its last beat interval (`gap`) or within
 * `MIN_CUT_SEC` of its start. Only ever shortens, so the source always covers the new length.
 */
export function cutToBeatOps(doc: EditDoc, trackId: string, beats: readonly number[], gap: number): EditOp[] {
  const track = doc.tracks.find((t) => t.id === trackId);
  if (!track) bad(`Track ${trackId} is not in this video edit.`, "not_found");
  if (track.kind !== "video" && track.kind !== "overlay") bad(`Track ${trackId} is a ${track.kind} track; cut a video or overlay track.`);
  const ops: EditOp[] = [];
  let work = doc;
  for (const id of track.clips.map((c) => c.id)) {
    const clip = work.tracks.find((t) => t.id === trackId)!.clips.find((c) => c.id === id) as MediaClip;
    const end = ms(clip.start + clipDuration(clip));
    const beat = beats.filter((b) => b <= end + 0.0005 && b >= clip.start + MIN_CUT_SEC).pop();
    if (beat === undefined || end - beat < 0.001 || end - beat > gap) continue;
    const op: EditOp = { op: "trim", clipId: id, out: ms(clip.in + (beat - clip.start) * clip.speed), ripple: true };
    work = applyOps(work, [op]);
    ops.push(op);
  }
  return ops;
}

/**
 * `video-edit-cut-to-beat`: the beats of `musicClipId` cut the clips of `trackId` (default the first video track),
 * on every `every`-th beat, through `video-edit-apply-ops` at `baseRevision`. `dryRun` returns the ops unsaved.
 */
export async function cutToBeatAction(ctx: PluginContext, companyId: string, params: Record<string, unknown>, actor: EditActor, deps: BeatDeps = {}) {
  const base = Number(params.baseRevision);
  if (!Number.isInteger(base) || base < 1) bad("baseRevision is required: the revision these changes start from.");
  const musicClipId = text(params.musicClipId);
  if (!musicClipId) bad("musicClipId is required: the sound clip whose beats set the cuts.");
  const every = params.every === undefined ? 1 : params.every;
  if (typeof every !== "number" || !(EVERY as readonly number[]).includes(every)) bad(`every must be one of ${EVERY.join(", ")}.`);
  const edit = await getVideoEdit(ctx, companyId, text(params.editId));
  if (edit.revision !== base) throw new StudioError(`Someone saved this video edit since you opened it (now revision ${edit.revision}). Reload to see their changes.`, "edit_conflict");
  const trackId = text(params.trackId) || edit.doc.tracks.find((t) => t.kind === "video")?.id;
  if (!trackId) bad("This video edit has no video track to cut.");
  const music = soundClip(edit.doc, musicClipId);
  if (edit.doc.tracks.find((t) => t.id === trackId)?.clips.some((c) => c.id === musicClipId)) bad("The music clip is on the track being cut; pick another track.");
  const { grid } = await gridFor(ctx, companyId, edit, music, deps);
  if (grid.tempo <= 0) bad("No steady beat was found in this clip's sound.", "no_beats");
  const inRange = timelineBeats(grid.beats, music);
  if (!inRange.length) bad(`No beats in the music clip's range (source ${music.in}..${music.out} s). ${analysedWarning(music) ?? ""}`.trim(), "no_beats");
  const beats = inRange.filter((_, i) => i % every === 0);
  // On the timeline a beat lasts 60 / tempo / speed of the music clip.
  const ops = cutToBeatOps(edit.doc, trackId, beats, (every * 60) / (grid.tempo * music.speed) + 0.001);
  const summary = { trackId, cuts: ops.length, tempo: grid.tempo, every };
  if (params.dryRun === true || !ops.length) return { editId: edit.id, revision: edit.revision, ops, cutToBeat: summary };
  const saved = await applyOpsAction(ctx, companyId, { editId: edit.id, baseRevision: base, ops }, actor);
  ctx.logger.info("Studio cut to beat", { companyId, editId: edit.id, ...summary, by: actor.agentId ?? actor.userId ?? null });
  return { ...saved, ops, cutToBeat: summary };
}
