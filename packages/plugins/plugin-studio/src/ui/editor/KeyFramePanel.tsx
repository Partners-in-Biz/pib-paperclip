/**
 * Chroma key and frame controls (PAR-10169, slice 3 D3e2), mounted from the ClipInspector for the selected overlay clip.
 * Key: on/off, an eyedropper that picks the colour from the preview frame (or a typed hex), similarity / blend / spill.
 * Frame: border width and colour, corner radius. Each change is one `setProps` through the store (the preview and the
 * render read the same fields); Undo takes the last one back. Refusals and a failed pick show as a sentence here.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { MediaClip } from "../../video-edit/timeline.js";
import type { EditorStore } from "./editor-store.js";
import type { LayerEdit } from "./layer-panel.js";
import { createKeyHistory } from "./timeline-view.js";
import { DEFAULT_KEY_COLOR, FRAME_FIELDS, isHex, KEY_FIELDS, setFrameOps, setKeyOps, toggleKeyOps } from "./chroma-panel.js";
import { eyedropper } from "./eyedropper.js";

const btn = (on: boolean, pressed = false) => ({ padding: "2px 8px", borderRadius: 6, border: pressed ? "2px solid currentColor" : "1px solid #8886", background: "transparent", color: "inherit", cursor: on ? "pointer" : "default", opacity: on ? 1 : 0.5, whiteSpace: "nowrap" }) as const;
const row = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, padding: "2px 12px", minWidth: 0 } as const;
const label = { flex: "0 0 96px" } as const;

export function KeyFramePanel({ store, clip }: { store: EditorStore; clip: MediaClip }) {
  const { busy } = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const picking = useSyncExternalStore(eyedropper.subscribe, eyedropper.getState, eyedropper.getState).clipId === clip.id;
  const history = useMemo(() => createKeyHistory(20), []);
  const undoCount = useSyncExternalStore(history.subscribe, history.size, history.size);
  const [message, setMessage] = useState<string | null>(null);
  const [hex, setHex] = useState("");
  const key = clip.chromaKey;
  const frame = clip.frame;
  useEffect(() => { setHex(key?.color ?? ""); }, [key?.color, clip.id]);
  useEffect(() => () => eyedropper.cancel(), [clip.id]);
  useEffect(() => {
    if (!picking) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") eyedropper.cancel(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [picking]);

  const run = async (edit: LayerEdit | null) => {
    if (!edit || busy) return;
    setMessage(null);
    if (await store.applyOps(edit.ops)) { history.push({ clipId: clip.id, ops: edit.undo }); return; }
    setMessage(store.getState().toast ?? "That change was not saved.");
    store.dismissToast();
  };
  const undo = async () => {
    const last = history.peek();
    if (!last || busy) return;
    setMessage(null);
    if (await store.applyOps(last.ops)) { history.drop(); return; }
    setMessage(store.getState().toast ?? "Undo was not saved.");
    store.dismissToast();
  };
  const pick = () => {
    if (picking) { eyedropper.cancel(); return; }
    const t = clip.transform;
    if (t.rotate !== 0 || clip.keyframes?.rotate?.length) { setMessage("Set the clip's rotation to 0 to pick a colour from the preview, or type it."); return; }
    setMessage(null);
    eyedropper.start(clip.id, (r) => { if ("error" in r) setMessage(r.error); else void run(setKeyOps(clip, { color: r.color })); });
  };
  const commitHex = () => { if (isHex(hex)) void run(setKeyOps(clip, { color: hex })); else if (hex !== (key?.color ?? "")) setMessage("A colour is # and six hex digits, like #00FF00."); };
  const num = (value: string, apply: (n: number) => LayerEdit | null) => { const n = Number(value); if (value.trim() !== "" && Number.isFinite(n)) void run(apply(n)); };

  return (
    <div data-key-frame-panel style={{ borderTop: "1px solid #8883", minWidth: 0, paddingBottom: 8 }}>
      <div style={{ ...row, padding: "8px 12px" }}>
        <strong>Chroma key</strong>
        <span style={{ flex: "1 1 40px" }} />
        <button type="button" data-key-undo disabled={busy || !undoCount} onClick={() => void undo()} style={btn(!busy && undoCount > 0)}>Undo</button>
      </div>
      {message ? <div role="alert" data-key-message style={{ padding: "0 12px 6px", fontSize: 12, color: "#c2410c", overflowWrap: "anywhere" }}>{message}</div> : null}
      {picking ? <div role="status" data-eyedropper-hint style={{ padding: "0 12px 6px", fontSize: 12 }}>Click the colour to remove in the preview. Esc cancels.</div> : null}
      <label style={row}>
        <span style={label}>Key out a colour</span>
        <input type="checkbox" data-key-toggle checked={Boolean(key)} disabled={busy} onChange={(e) => void run(toggleKeyOps(clip, e.target.checked))} />
      </label>
      {key ? (
        <>
          <div style={row}>
            <span style={label}>Colour</span>
            <span aria-hidden data-key-swatch style={{ width: 20, height: 20, borderRadius: 4, border: "1px solid #8886", background: key.color }} />
            <input aria-label="Key colour" data-key-hex value={hex} placeholder={DEFAULT_KEY_COLOR} disabled={busy} maxLength={7} onChange={(e) => setHex(e.target.value)} onBlur={commitHex} onKeyDown={(e) => { if (e.key === "Enter") commitHex(); }} style={{ width: 84, minWidth: 0 }} />
            <button type="button" data-eyedropper aria-pressed={picking} disabled={busy} onClick={pick} style={btn(!busy, picking)} title="Pick the colour from the preview">Pick</button>
          </div>
          {KEY_FIELDS.map((f) => (
            <label key={f.field} style={row}>
              <span style={label}>{f.label}</span>
              <input type="range" aria-label={f.label} data-key-field={f.field} min={f.min} max={f.max} step={f.step} value={key[f.field]} disabled={busy} onChange={(e) => num(e.target.value, (n) => setKeyOps(clip, { [f.field]: n }))} style={{ flex: "1 1 80px", minWidth: 0 }} />
              <span style={{ fontVariantNumeric: "tabular-nums", minWidth: 32 }}>{key[f.field].toFixed(2)}</span>
            </label>
          ))}
        </>
      ) : null}
      <div style={{ ...row, padding: "8px 12px 2px", borderTop: "1px solid #8882", marginTop: 6 }}><strong>Frame</strong></div>
      {FRAME_FIELDS.map((f) => (
        <label key={f.field} style={row}>
          <span style={label}>{f.label}</span>
          <input type="range" aria-label={f.label} data-frame-field={f.field} min={f.min} max={f.max} step={f.step} value={frame?.[f.field] ?? 0} disabled={busy} onChange={(e) => num(e.target.value, (n) => setFrameOps(clip, { [f.field]: n }))} style={{ flex: "1 1 80px", minWidth: 0 }} />
          <span style={{ fontVariantNumeric: "tabular-nums", minWidth: 40 }}>{frame?.[f.field] ?? 0}{f.unit}</span>
        </label>
      ))}
      <label style={row}>
        <span style={label}>Border colour</span>
        <input type="color" aria-label="Border colour" data-frame-color value={(frame?.borderColor ?? "#FFFFFF").toLowerCase()} disabled={busy} onChange={(e) => void run(setFrameOps(clip, { borderColor: e.target.value }))} />
      </label>
    </div>
  );
}
