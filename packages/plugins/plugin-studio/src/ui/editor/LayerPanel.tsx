/**
 * Layers panel (PAR-10168), mounted from the ClipInspector for the selected overlay clip: 12 picture-in-picture presets
 * (4 corners x S/M/L, one `setProps` of the transform), a blend-mode picker and Undo. Refusals show as a sentence here.
 */
import { useMemo, useState, useSyncExternalStore } from "react";
import type { MediaClip } from "../../video-edit/timeline.js";
import type { EditorStore } from "./editor-store.js";
import { createKeyHistory } from "./timeline-view.js";
import { BLEND_LABELS, BLEND_MODES, blendOf, currentPip, PIP_CORNERS, PIP_SCALE, resetPipOps, setBlendOps, setPipOps, type LayerEdit, type PipSize } from "./layer-panel.js";

const btn = (on: boolean, pressed = false) => ({ padding: "2px 8px", borderRadius: 6, border: pressed ? "2px solid currentColor" : "1px solid #8886", background: "transparent", color: "inherit", cursor: on ? "pointer" : "default", opacity: on ? 1 : 0.5, whiteSpace: "nowrap" }) as const;
const SIZES = Object.keys(PIP_SCALE) as PipSize[];

export function LayerPanel({ store, clip }: { store: EditorStore; clip: MediaClip }) {
  const { doc, busy } = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const history = useMemo(() => createKeyHistory(20), []);
  const undoCount = useSyncExternalStore(history.subscribe, history.size, history.size);
  const [message, setMessage] = useState<string | null>(null);
  const project = doc?.project ?? { width: 1920, height: 1080 };
  const pip = currentPip(project, clip);

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

  return (
    <div data-layer-panel style={{ borderTop: "1px solid #8883", minWidth: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "8px 12px", minWidth: 0 }}>
        <strong>Layer</strong>
        <span style={{ flex: "1 1 40px" }} />
        <button type="button" data-layer-pip-reset disabled={busy || !resetPipOps(clip)} onClick={() => void run(resetPipOps(clip))} style={btn(!busy && Boolean(resetPipOps(clip)))} title="Back to the full frame">Full frame</button>
        <button type="button" data-layer-undo disabled={busy || !undoCount} onClick={() => void undo()} style={btn(!busy && undoCount > 0)}>Undo</button>
      </div>
      {message ? <div role="alert" data-layer-message style={{ padding: "0 12px 6px", fontSize: 12, color: "#c2410c", overflowWrap: "anywhere" }}>{message}</div> : null}
      <div role="group" aria-label="Picture in picture" style={{ display: "grid", gap: 4, padding: "0 12px 8px", minWidth: 0 }}>
        {PIP_CORNERS.map(({ corner, label }) => (
          <div key={corner} data-pip-corner={corner} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, minWidth: 0 }}>
            <span style={{ flex: "0 0 96px", fontSize: 12 }}>{label}</span>
            {SIZES.map((size) => {
              const on = pip?.corner === corner && pip.size === size;
              return <button key={size} type="button" data-pip={`${corner}-${size}`} aria-pressed={on} disabled={busy} onClick={() => void run(setPipOps(project, clip, corner, size))} title={`${label}, ${size} (${Math.round(PIP_SCALE[size] * 100)}% of the frame)`} style={btn(!busy, on)}>{size}</button>;
            })}
          </div>
        ))}
      </div>
      <label data-layer-blend style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, padding: "4px 12px 8px", minWidth: 0, borderTop: "1px solid #8882" }}>
        <span style={{ flex: "0 0 96px" }}>Blend</span>
        <select aria-label="Blend mode" value={blendOf(clip)} disabled={busy} onChange={(e) => void run(setBlendOps(clip, e.target.value))} style={{ flex: "1 1 120px", minWidth: 0 }}>
          {BLEND_MODES.map((m) => <option key={m} value={m}>{BLEND_LABELS[m]}</option>)}
        </select>
      </label>
    </div>
  );
}
