/**
 * Text track (PAR-8320): "Add text" puts a text clip at the playhead, and the selected text clip's content, font,
 * size, colour, position and start/duration are edited in a small form. Saving sends exactly one
 * `video-edit-apply-ops` batch through the store (one `setProps`, or `addTrack` + `addClip` for a new clip); the worker
 * validates it. Moving a text clip in time is the form's Start, or a body drag on its timeline lane. The logic lives in
 * text-track.ts (unit tested); Overlay.tsx draws the clips over the player.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import type { LayoutFont } from "../../layout.js";
import type { EditorStore } from "./editor-store.js";
import { formatTime } from "./timeline-view.js";
import { addTextOps, findTextClip, FONT_NAMES, formOf, MAX_TEXT, TEXT_FONTS, textClips, textEditOps, type TextForm } from "./text-track.js";

const field = { display: "grid", gap: 2, fontSize: 12, minWidth: 0 } as const;
const input = { padding: "4px 6px", borderRadius: 6, border: "1px solid #8886", background: "transparent", color: "inherit", minWidth: 0, width: "100%", boxSizing: "border-box" } as const;
const btn = (on: boolean) => ({ padding: "4px 10px", borderRadius: 6, border: "1px solid #8886", background: "transparent", color: "inherit", cursor: on ? "pointer" : "default", opacity: on ? 1 : 0.5, whiteSpace: "nowrap" }) as const;

export function TextTrack({ store }: { store: EditorStore }) {
  const { doc, playhead, selectedClipId, busy, revision } = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const found = findTextClip(doc, selectedClipId);
  const clip = found?.clip ?? null;
  const [form, setForm] = useState<TextForm | null>(clip ? formOf(clip) : null);
  const [error, setError] = useState<string | null>(null);
  // A new selection or a saved revision resets the form to the doc the server holds.
  useEffect(() => {
    setForm(clip ? formOf(clip) : null);
    setError(null);
  }, [clip?.id, revision]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = async () => {
    const made = addTextOps(doc, playhead);
    if ("error" in made) return setError(made.error);
    setError(null);
    if (await store.applyOps(made.ops)) store.selectClip(made.clipId);
  };
  const save = () => {
    if (!clip || !form || busy) return;
    const made = textEditOps(clip, form);
    if (made && "error" in made) return setError(made.error);
    setError(null);
    if (made) void store.applyOps(made.ops);
  };
  const set = (key: keyof TextForm) => (e: { target: { value: string } }) => setForm((f) => (f ? { ...f, [key]: e.target.value } : f));
  const count = textClips(doc).length;
  const fonts: string[] = [...TEXT_FONTS];
  if (form && !fonts.includes(form.font)) fonts.push(form.font);

  return (
    <div data-text-track style={{ display: "grid", gap: 8, padding: "8px 12px", borderBottom: "1px solid #8883", minWidth: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, minWidth: 0 }}>
        <strong>Text</strong>
        <span style={{ opacity: 0.75 }}>{count} text clip{count === 1 ? "" : "s"}{clip ? "" : " · select one on the timeline to edit it"}</span>
        <span style={{ flex: "1 1 0" }} />
        <button type="button" onClick={add} disabled={busy || !doc} title={`Add text at ${formatTime(playhead)}`} style={btn(!busy && Boolean(doc))}>Add text</button>
      </div>
      {clip && form ? (
        <form
          aria-label="Edit text clip"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
          style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))", gap: 8, minWidth: 0 }}
        >
          <label style={{ ...field, gridColumn: "1 / -1" }}>
            Text
            <textarea value={form.text} onChange={set("text")} maxLength={MAX_TEXT} rows={2} style={{ ...input, resize: "vertical" }} />
          </label>
          <label style={field}>
            Font
            <select value={form.font} onChange={set("font")} style={input}>
              {fonts.map((f) => <option key={f} value={f}>{FONT_NAMES[f as LayoutFont] ?? f}</option>)}
            </select>
          </label>
          <label style={field}>Size<input type="number" min={8} max={400} value={form.fontSize} onChange={set("fontSize")} style={input} /></label>
          <label style={field}>Colour<input type="color" value={form.color.toLowerCase()} onChange={set("color")} style={{ ...input, padding: 0, height: 28 }} /></label>
          <label style={field}>X<input type="number" step={10} value={form.x} onChange={set("x")} style={input} /></label>
          <label style={field}>Y<input type="number" step={10} value={form.y} onChange={set("y")} style={input} /></label>
          <label style={field}>Start (s)<input type="number" min={0} step={0.1} value={form.start} onChange={set("start")} style={input} /></label>
          <label style={field}>Duration (s)<input type="number" min={0.1} step={0.1} value={form.duration} onChange={set("duration")} style={input} /></label>
          <div style={{ display: "flex", alignItems: "end", gap: 8 }}>
            <button type="submit" disabled={busy} style={btn(!busy)}>Save text</button>
          </div>
        </form>
      ) : null}
      {error ? <div role="alert" style={{ color: "#e5484d", fontSize: 12, overflowWrap: "anywhere" }}>{error}</div> : null}
    </div>
  );
}
