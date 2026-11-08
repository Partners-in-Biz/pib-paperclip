/**
 * Caption track logic (PAR-8321), pure and React-free so it is unit tested. CaptionTrack.tsx and Overlay.tsx draw with
 * it. Captions go through ops only (`addClip`, then `setProps` with start / style / words); the worker validates them.
 * Word times are relative to the caption clip's start, as in the schema.
 */
import type { CaptionClip, CaptionStyle, CaptionWord, EditDoc } from "../../video-edit/timeline.js";
import { freeId } from "./timeline-view.js";
import { fontStack } from "../font-names.js";

/** A5a's caption styles (`timeline.ts` CAPTION_STYLES; a test keeps them equal). Copied so the UI bundle stays small. */
export const CAPTION_STYLE_IDS = ["plain", "bold", "karaoke"] as const satisfies readonly CaptionStyle[];
export const STYLE_LABELS: Record<CaptionStyle, string> = { plain: "Plain", bold: "Bold (TikTok)", karaoke: "Karaoke" };
/** Per-style look, mirroring compile-text.ts `looks()`: size is a fraction of the short side, `bottom` of the height. */
export const STYLE_LOOK: Record<CaptionStyle, { bold: boolean; size: number; bottom: number; maxChars: number; spoken: string; unspoken: string }> = {
  plain: { bold: false, size: 0.055, bottom: 0.12, maxChars: 42, spoken: "#FFFFFF", unspoken: "#FFFFFF" },
  bold: { bold: true, size: 0.075, bottom: 0.28, maxChars: 24, spoken: "#FFFFFF", unspoken: "#FFFFFF" },
  karaoke: { bold: true, size: 0.075, bottom: 0.28, maxChars: 24, spoken: "#FFE000", unspoken: "#FFFFFF" },
};
export const MAX_EDIT_SECONDS = 180;
export const MAX_WORDS = 2000;
export const MAX_WORD_CHARS = 100;
export const SECONDS_PER_WORD = 0.4;
const MIN_WORD = 0.001;
const ms = (n: number) => Math.round(n * 1000) / 1000;

type Ops = { ops: Record<string, unknown>[] };

/** The words of a pasted line: whitespace-separated, each cut to the schema's length. */
export function wordsOf(line: string): string[] {
  return line.split(/\s+/).filter(Boolean).map((w) => Array.from(w).slice(0, MAX_WORD_CHARS).join(""));
}

/** Words timed evenly over `span` seconds from 0: word i runs [i*span/n, (i+1)*span/n], rounded so they never overlap. */
export function spreadWords(texts: string[], span: number): CaptionWord[] {
  const n = texts.length;
  if (!n) return [];
  const total = Math.max(span, n * MIN_WORD);
  const cut = (i: number) => (i === n ? ms(total) : ms((i * total) / n));
  return texts.map((text, i) => ({ text, start: cut(i), end: Math.max(cut(i + 1), ms(cut(i) + MIN_WORD)) }));
}

/** Seconds a caption occupies on the timeline: the end of its last word. */
export const captionSpan = (words: CaptionWord[]) => (words.length ? words[words.length - 1].end : 0);
export const defaultSpan = (wordCount: number) => ms(Math.max(1, wordCount * SECONDS_PER_WORD));

export function captionClips(doc: EditDoc | null): { trackId: string; clip: CaptionClip }[] {
  const out: { trackId: string; clip: CaptionClip }[] = [];
  for (const t of doc?.tracks ?? []) if (t.kind === "caption") for (const clip of t.clips) out.push({ trackId: t.id, clip });
  return out.sort((a, b) => a.clip.start - b.clip.start);
}

export function findCaptionClip(doc: EditDoc | null, clipId: string | null): { trackId: string; clip: CaptionClip } | null {
  return (clipId && captionClips(doc).find((c) => c.clip.id === clipId)) || null;
}

/**
 * The batch that adds one caption clip per non-empty line, back to back from `at` (or the first free spot after the
 * captions already there) on the first caption track, creating the track when the edit has none. Each line's words are
 * spread evenly over `defaultSpan`.
 */
export function addCaptionOps(doc: EditDoc | null, at: number, pasted: string, style: CaptionStyle = "bold"): (Ops & { clipId: string; start: number }) | { error: string } {
  if (!doc) return { error: "The edit isn't loaded yet." };
  const lines = pasted.split(/\r?\n/).map(wordsOf).filter((w) => w.length);
  if (!lines.length) return { error: "Type or paste a line of captions first." };
  if (lines.reduce((n, w) => n + w.length, 0) > MAX_WORDS) return { error: `That is more than ${MAX_WORDS} words. Add them in smaller parts.` };
  const track = doc.tracks.find((t) => t.kind === "caption");
  const trackId = track ? track.id : freeId(doc, "captions");
  const existing = (track?.clips ?? []) as CaptionClip[];
  let start = ms(Math.max(0, at));
  for (const c of [...existing].sort((a, b) => a.start - b.start)) {
    if (c.start <= start && start < ms(c.start + captionSpan(c.words))) start = ms(c.start + captionSpan(c.words));
  }
  const first = start;
  const next = existing.filter((c) => c.start >= start).sort((a, b) => a.start - b.start)[0];
  const ops: Record<string, unknown>[] = track ? [] : [{ op: "addTrack", track: { id: trackId, kind: "caption" } }];
  const stem = freeId(doc, "cap");
  let firstId = stem;
  let cursor = start;
  const taken = new Set<string>();
  lines.forEach((words, i) => {
    const id = i === 0 ? stem : freeId(doc, `${stem}-${i + 1}`);
    if (taken.has(id)) return;
    taken.add(id);
    if (i === 0) firstId = id;
    const span = defaultSpan(words.length);
    ops.push({ op: "addClip", trackId, clip: { id, start: cursor, style, words: spreadWords(words, span) } });
    cursor = ms(cursor + span);
  });
  if (cursor > MAX_EDIT_SECONDS) return { error: `The captions would run past ${MAX_EDIT_SECONDS} s. Move the playhead earlier or paste fewer lines.` };
  if (next && cursor > next.start) return { error: "There is no room for these captions here. Move the playhead to a free spot on the caption track." };
  return { ops, clipId: firstId, start: first };
}

export interface CaptionForm { style: CaptionStyle; start: string; words: { text: string; start: string; end: string }[] }

export function formOf(clip: CaptionClip): CaptionForm {
  return { style: clip.style, start: String(clip.start), words: clip.words.map((w) => ({ text: w.text, start: String(w.start), end: String(w.end) })) };
}

/** The form's text as one line, for the textarea. */
export const textOfForm = (form: CaptionForm) => form.words.map((w) => w.text).join(" ");

/** New wording: the words are spread evenly again over the span the caption has now (or its default when empty). */
export function retext(form: CaptionForm, line: string): CaptionForm {
  const texts = wordsOf(line).slice(0, MAX_WORDS);
  const ends = form.words.map((w) => Number(w.end)).filter(Number.isFinite);
  const span = ends.length ? Math.max(...ends) : defaultSpan(texts.length);
  return { ...form, words: spreadWords(texts, span).map((w) => ({ text: w.text, start: String(w.start), end: String(w.end) })) };
}

/** Spread the current words evenly over `span` seconds (the "Space evenly" button). */
export function respan(form: CaptionForm, span: number): CaptionForm {
  return retext({ ...form, words: form.words.map((w, i) => (i === form.words.length - 1 ? { ...w, end: String(span) } : w)) }, textOfForm(form));
}

/** The one `setProps` op that turns `clip` into `form`; null when nothing changed, or an error a person can act on. */
export function captionEditOps(clip: CaptionClip, form: CaptionForm): Ops | { error: string } | null {
  if (!CAPTION_STYLE_IDS.includes(form.style)) return { error: "Pick one of the caption styles." };
  const start = Number(form.start.trim());
  if (form.start.trim() === "" || !Number.isFinite(start) || start < 0 || start > MAX_EDIT_SECONDS) return { error: `Start must be a number from 0 to ${MAX_EDIT_SECONDS}.` };
  if (!form.words.length) return { error: "A caption needs at least one word." };
  const words: CaptionWord[] = [];
  let last = 0;
  for (let i = 0; i < form.words.length; i++) {
    const w = form.words[i];
    const text = w.text.trim();
    const s = Number(w.start.trim());
    const e = Number(w.end.trim());
    const label = `Word ${i + 1} (${text || "empty"})`;
    if (!text) return { error: `${label} has no text.` };
    if (/\s/.test(text)) return { error: `${label} has a space in it. Edit the text above to split words.` };
    if (text.length > MAX_WORD_CHARS) return { error: `${label} is longer than ${MAX_WORD_CHARS} characters.` };
    if (w.start.trim() === "" || w.end.trim() === "" || !Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e > MAX_EDIT_SECONDS) return { error: `${label}: times must be numbers from 0 to ${MAX_EDIT_SECONDS}.` };
    if (e <= s) return { error: `${label} must end after it starts.` };
    if (s < last) return { error: `${label} starts before the word before it ends.` };
    last = e;
    words.push({ text, start: ms(s), end: ms(e) });
  }
  if (ms(start + last) > MAX_EDIT_SECONDS) return { error: `The caption would run past ${MAX_EDIT_SECONDS} s.` };
  const props: Record<string, unknown> = {};
  if (form.style !== clip.style) props.style = form.style;
  if (ms(start) !== clip.start) props.start = ms(start);
  if (JSON.stringify(words) !== JSON.stringify(clip.words)) props.words = words;
  if (!Object.keys(props).length) return null;
  return { ops: [{ op: "setProps", clipId: clip.id, props }] };
}

/** Words on one caption line, as the render breaks them (compile-text.ts `captionLines`: width or a pause over 0.7 s). */
export function lineOf(words: CaptionWord[], at: number, maxChars: number): CaptionWord[] {
  const lines: CaptionWord[][] = [];
  let line: CaptionWord[] = [];
  let length = 0;
  for (const word of words) {
    const prev = line[line.length - 1];
    if (prev && (length + 1 + word.text.length > maxChars || word.start - prev.end > 0.7)) {
      lines.push(line);
      line = [];
      length = 0;
    }
    length += (line.length ? 1 : 0) + word.text.length;
    line.push(word);
  }
  if (line.length) lines.push(line);
  return lines.find((l) => at >= l[0].start && at < l[l.length - 1].end) ?? [];
}

export interface ShownCaption { clip: CaptionClip; words: { text: string; spoken: boolean; active: boolean }[] }

/** The captions showing at timeline time `t`: the line being spoken, each word flagged spoken (already started) / active. */
export function visibleCaptions(doc: EditDoc | null, t: number): ShownCaption[] {
  const out: ShownCaption[] = [];
  for (const { clip } of captionClips(doc)) {
    const rel = t - clip.start;
    const line = lineOf(clip.words, rel, STYLE_LOOK[clip.style].maxChars);
    if (!line.length) continue;
    out.push({ clip, words: line.map((w) => ({ text: w.text, spoken: rel >= w.start, active: rel >= w.start && rel < w.end })) });
  }
  return out;
}

/** Where and how the render draws a caption line: bottom-centred, sized against the short side. */
export function captionStyle(style: CaptionStyle, project: { width: number; height: number }) {
  const look = STYLE_LOOK[style];
  return {
    position: "absolute",
    left: "50%",
    bottom: `${ms(look.bottom * 100)}%`,
    transform: "translateX(-50%)",
    width: "90%",
    textAlign: "center",
    fontFamily: fontStack("sans"), // the render draws captions in Inter (compile-text.ts)
    fontWeight: look.bold ? 800 : 400,
    fontSize: `${ms(((Math.min(project.width, project.height) * look.size) / project.height) * 100)}cqh`,
    lineHeight: 1.2,
    textShadow: look.bold ? "0 0 3px #000, 0 0 3px #000" : "0 0 2px #000a",
  } as const;
}
