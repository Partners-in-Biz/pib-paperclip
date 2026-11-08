/**
 * Caption track (PAR-8321): type or paste lines and "Add captions" puts one caption clip per line at the playhead, its
 * words timed evenly over the line's span. The selected caption's style (plain / bold TikTok / karaoke), start, wording
 * and word timings are edited in a small form. Saving sends one `video-edit-apply-ops` batch through the store (one
 * `setProps`, or `addTrack` + `addClip`s); the worker validates it. Logic: caption-timing.ts (unit tested).
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import type { CaptionStyle } from "../../video-edit/timeline.js";
import type { EditorStore } from "./editor-store.js";
import { addCaptionOps, CAPTION_STYLE_IDS, captionClips, captionEditOps, captionSpan, findCaptionClip, formOf, respan, retext, STYLE_LABELS, textOfForm, type CaptionForm } from "./caption-timing.js";
import { formatTime } from "./timeline-view.js";

const field = { display: "grid", gap: 2, fontSize: 12, minWidth: 0 } as const;
const input = { padding: "4px 6px", borderRadius: 6, border: "1px solid #8886", background: "transparent", color: "inherit", minWidth: 0, width: "100%", boxSizing: "border-box" } as const;
const btn = (on: boolean) => ({ padding: "4px 10px", borderRadius: 6, border: "1px solid #8886", background: "transparent", color: "inherit", cursor: on ? "pointer" : "default", opacity: on ? 1 : 0.5, whiteSpace: "nowrap" }) as const;

export function CaptionTrack({ store }: { store: EditorStore }) {
  const { doc, playhead, selectedClipId, busy, revision } = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const clip = findCaptionClip(doc, selectedClipId)?.clip ?? null;
  const [form, setForm] = useState<CaptionForm | null>(clip ? formOf(clip) : null);
  const [draft, setDraft] = useState("");
  const [style, setStyle] = useState<CaptionStyle>("bold");
  const [error, setError] = useState<string | null>(null);
  // A new selection or a saved revision resets the form to the doc the server holds.
  useEffect(() => {
    setForm(clip ? formOf(clip) : null);
    setError(null);
  }, [clip?.id, revision]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = async () => {
    const made = addCaptionOps(doc, playhead, draft, style);
    if ("error" in made) return setError(made.error);
    setError(null);
    if (await store.applyOps(made.ops)) {
      setDraft("");
      store.selectClip(made.clipId);
    }
  };
  const save = () => {
    if (!clip || !form || busy) return;
    const made = captionEditOps(clip, form);
    if (made && "error" in made) return setError(made.error);
    setError(null);
    if (made) void store.applyOps(made.ops);
  };
  const setWord = (i: number, key: "start" | "end", value: string) =>
    setForm((f) => (f ? { ...f, words: f.words.map((w, j) => (j === i ? { ...w, [key]: value } : w)) } : f));
  const count = captionClips(doc).length;

  return (
    <div data-caption-track style={{ display: "grid", gap: 8, padding: "8px 12px", borderBottom: "1px solid #8883", minWidth: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, minWidth: 0 }}>
        <strong>Captions</strong>
        <span style={{ opacity: 0.75 }}>{count} caption{count === 1 ? "" : "s"}{clip ? "" : " · select one on the timeline to edit it"}</span>
      </div>
      <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", minWidth: 0 }}>
        <label style={{ ...field, gridColumn: "1 / -1" }}>
          New captions (one line per caption)
          <textarea aria-label="New captions" value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} placeholder="Type or paste lines" style={{ ...input, resize: "vertical" }} />
        </label>
        <label style={field}>
          Style
          <select value={style} onChange={(e) => setStyle(e.target.value as CaptionStyle)} style={input}>
            {CAPTION_STYLE_IDS.map((s) => <option key={s} value={s}>{STYLE_LABELS[s]}</option>)}
          </select>
        </label>
        <div style={{ display: "flex", alignItems: "end" }}>
          <button type="button" onClick={add} disabled={busy || !doc || !draft.trim()} title={`Add captions at ${formatTime(playhead)}`} style={btn(!busy && Boolean(doc) && Boolean(draft.trim()))}>Add captions</button>
        </div>
      </div>
      {clip && form ? (
        <form
          aria-label="Edit caption"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
          style={{ display: "grid", gap: 8, minWidth: 0 }}
        >
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8, minWidth: 0 }}>
            <label style={{ ...field, gridColumn: "1 / -1" }}>
              Words
              <textarea aria-label="Caption words" value={textOfForm(form)} onChange={(e) => setForm(retext(form, e.target.value))} rows={2} style={{ ...input, resize: "vertical" }} />
            </label>
            <label style={field}>
              Style
              <select value={form.style} onChange={(e) => setForm({ ...form, style: e.target.value as CaptionStyle })} style={input}>
                {CAPTION_STYLE_IDS.map((s) => <option key={s} value={s}>{STYLE_LABELS[s]}</option>)}
              </select>
            </label>
            <label style={field}>Start (s)<input type="number" min={0} step={0.1} value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} style={input} /></label>
            <div style={{ display: "flex", alignItems: "end", gap: 8, flexWrap: "wrap" }}>
              <button type="button" onClick={() => setForm(respan(form, captionSpan(clip.words)))} style={btn(true)} title="Time the words evenly over the caption's length again">Space evenly</button>
              <button type="submit" disabled={busy} style={btn(!busy)}>Save caption</button>
            </div>
          </div>
          <div role="group" aria-label="Word timings" style={{ display: "grid", gap: 4, maxHeight: 160, overflowY: "auto", minWidth: 0 }}>
            {form.words.map((w, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 72px 72px", gap: 6, alignItems: "center", fontSize: 12, minWidth: 0 }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={w.text}>{w.text}</span>
                <input aria-label={`Start of word ${i + 1}`} type="number" min={0} step={0.05} value={w.start} onChange={(e) => setWord(i, "start", e.target.value)} style={input} />
                <input aria-label={`End of word ${i + 1}`} type="number" min={0} step={0.05} value={w.end} onChange={(e) => setWord(i, "end", e.target.value)} style={input} />
              </div>
            ))}
          </div>
        </form>
      ) : null}
      {error ? <div role="alert" style={{ color: "#e5484d", fontSize: 12, overflowWrap: "anywhere" }}>{error}</div> : null}
    </div>
  );
}
