/**
 * Text track and overlay logic (PAR-8320), pure and React-free so it is unit tested (the plugin's tests run without
 * React); TextTrack.tsx and Overlay.tsx draw with it. Every change is an ops batch the worker validates.
 */
import type { LayoutFont } from "../../layout.js";
import type { Clip, EditDoc, TextClip } from "../../video-edit/timeline.js";
import { freeId } from "./timeline-view.js";

/** A5a's font ids (`src/video-edit/fonts.ts` FONT_IDS; a test keeps them equal). Copied, not imported: fonts.ts reads the disk. */
export const TEXT_FONTS = ["sans", "serif", "rounded"] as const satisfies readonly LayoutFont[];
/** The family each id renders with (fonts.ts FONTS[id].family). */
export const FONT_NAMES: Record<LayoutFont, string> = { sans: "Inter", serif: "Lora", rounded: "Nunito" };
export const NEW_TEXT_SECONDS = 3;
const MAX_SECONDS = 180;
export const MAX_TEXT = 500;
const COLOR = /^#[0-9A-F]{6}$/;
const ms = (n: number) => Math.round(n * 1000) / 1000;

export interface TextForm { text: string; font: string; fontSize: string; color: string; x: string; y: string; start: string; duration: string }
type Ops = { ops: Record<string, unknown>[] };

/** Every text clip with its track, in timeline order. */
export function textClips(doc: EditDoc | null): { trackId: string; clip: TextClip }[] {
  const out: { trackId: string; clip: TextClip }[] = [];
  for (const t of doc?.tracks ?? []) if (t.kind === "text") for (const clip of t.clips) out.push({ trackId: t.id, clip });
  return out.sort((a, b) => a.clip.start - b.clip.start);
}

export function findTextClip(doc: EditDoc | null, clipId: string | null): { trackId: string; clip: TextClip } | null {
  return (clipId && textClips(doc).find((c) => c.clip.id === clipId)) || null;
}

/**
 * The batch that adds a text clip at `at` (or the first free slot after it) on the first text track, creating a text
 * track when the edit has none. Shortened to fit before the next text clip; an error when there is no room.
 */
export function addTextOps(doc: EditDoc | null, at: number, text = "Your text"): (Ops & { clipId: string; start: number }) | { error: string } {
  if (!doc) return { error: "The edit isn't loaded yet." };
  const track = doc.tracks.find((t) => t.kind === "text");
  const trackId = track ? track.id : freeId(doc, "text");
  const clips = [...((track?.clips ?? []) as Clip[])].sort((a, b) => a.start - b.start) as TextClip[];
  let start = ms(Math.max(0, at));
  for (const c of clips) if (c.start <= start && start < ms(c.start + c.duration)) start = ms(c.start + c.duration);
  const next = clips.find((c) => c.start >= start);
  const room = Math.min(next ? next.start - start : Infinity, MAX_SECONDS - start);
  if (room < 0.1) return { error: "There is no room for text here. Move the playhead to a free spot on the text track." };
  const clipId = freeId(doc, "txt"); // another stem than the track's, so a new track and clip never share an id
  const clip = { id: clipId, start, duration: ms(Math.min(NEW_TEXT_SECONDS, room)), text, font: "sans", color: "#FFFFFF", fontSize: 64 };
  const ops: Record<string, unknown>[] = track ? [] : [{ op: "addTrack", track: { id: trackId, kind: "text" } }];
  ops.push({ op: "addClip", trackId, clip });
  return { ops, clipId, start };
}

export function formOf(clip: TextClip): TextForm {
  return {
    text: clip.text, font: clip.font ?? "sans", fontSize: String(clip.fontSize), color: clip.color,
    x: String(clip.transform.x), y: String(clip.transform.y), start: String(clip.start), duration: String(clip.duration),
  };
}

/** The one `setProps` op that turns `clip` into `form`; null when nothing changed, or an error a person can act on. */
export function textEditOps(clip: TextClip, form: TextForm): Ops | { error: string } | null {
  const num = (v: string, label: string, min: number, max: number): number | string => {
    const n = Number(v.trim());
    return v.trim() !== "" && Number.isFinite(n) && n >= min && n <= max ? ms(n) : `${label} must be a number from ${min} to ${max}.`;
  };
  if (!form.text.trim()) return { error: "The text can't be empty." };
  if (form.text.length > MAX_TEXT) return { error: `The text is longer than ${MAX_TEXT} characters.` };
  const color = form.color.trim().toUpperCase();
  if (!COLOR.test(color)) return { error: "The colour must look like #FFFFFF." };
  const fontSize = num(form.fontSize, "Size", 8, 400);
  const x = num(form.x, "X", -8000, 8000);
  const y = num(form.y, "Y", -8000, 8000);
  const start = num(form.start, "Start", 0, MAX_SECONDS);
  const duration = num(form.duration, "Duration", 0.001, MAX_SECONDS);
  for (const v of [fontSize, x, y, start, duration]) if (typeof v === "string") return { error: v };
  const props: Record<string, unknown> = {};
  if (form.text !== clip.text) props.text = form.text;
  if (form.font !== (clip.font ?? "sans")) props.font = form.font;
  if (color !== clip.color) props.color = color;
  if (fontSize !== clip.fontSize) props.fontSize = fontSize;
  if (start !== clip.start) props.start = start;
  if (duration !== clip.duration) {
    props.duration = duration;
    // Fades must fit the new length or the worker refuses the op.
    if (clip.fadeIn + clip.fadeOut > (duration as number)) Object.assign(props, { fadeIn: 0, fadeOut: 0 });
    if (clip.transitionIn && clip.transitionIn.duration > (duration as number)) props.transitionIn = null;
  }
  if (x !== clip.transform.x || y !== clip.transform.y) props.transform = { x, y };
  if (!Object.keys(props).length) return null;
  return { ops: [{ op: "setProps", clipId: clip.id, props }] };
}

export const PREVIEW_NOTE = "preview; the render uses the exact font";
/** Generic stacks per font id: no FontFace, no font download. */
export const PREVIEW_FONT: Record<LayoutFont, string> = { sans: "system-ui, sans-serif", serif: "Georgia, serif", rounded: "ui-rounded, system-ui, sans-serif" };

/** The text clips showing at `t`, bottom track first, with the opacity their fades give them there. */
export function visibleText(doc: EditDoc | null, t: number): { clip: TextClip; opacity: number }[] {
  const out: { clip: TextClip; opacity: number }[] = [];
  for (const { clip } of textClips(doc)) {
    const end = clip.start + clip.duration;
    if (t < clip.start || t >= end) continue;
    const fadeIn = Math.max(clip.fadeIn, clip.transitionIn?.duration ?? 0);
    let opacity = 1;
    if (fadeIn > 0) opacity = Math.min(opacity, (t - clip.start) / fadeIn);
    if (clip.fadeOut > 0) opacity = Math.min(opacity, (end - t) / clip.fadeOut);
    out.push({ clip, opacity: Math.max(0, Math.min(1, opacity)) });
  }
  return out;
}

/** Where and how the render draws `clip`: drawtext centres the text, then offsets it by transform x/y output pixels. */
export function overlayStyle(clip: TextClip, project: { width: number; height: number }, opacity: number) {
  return {
    position: "absolute",
    left: `${ms(50 + (clip.transform.x / project.width) * 100)}%`,
    top: `${ms(50 + (clip.transform.y / project.height) * 100)}%`,
    transform: `translate(-50%, -50%) rotate(${clip.transform.rotate}deg)`,
    fontFamily: PREVIEW_FONT[(clip.font ?? "sans") as LayoutFont] ?? PREVIEW_FONT.sans,
    // Size against the frame height, like fontsize= against the output height.
    fontSize: `${ms(((clip.fontSize * clip.transform.scale) / project.height) * 100)}cqh`,
    // The render draws the bold face with a thin dark border.
    fontWeight: 700,
    textShadow: "0 0 2px #0009",
    lineHeight: 1.2,
    color: clip.color,
    opacity,
    whiteSpace: "pre",
    textAlign: "center",
  } as const;
}
