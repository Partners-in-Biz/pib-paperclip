/**
 * Effects panel (PAR-10179), mounted from the ClipInspector for the selected video or overlay clip: five effect toggles
 * (at most three on a clip) and a strength slider for each effect that is on. Each change is one `setProps { effects }`
 * batch; Undo puts the last one back. A slider saves once when released, so a drag is one undo step.
 */
import { useMemo, useState, useSyncExternalStore } from "react";
import type { Effect, MediaClip } from "../../video-edit/timeline.js";
import type { EditorStore } from "./editor-store.js";
import { atEffectLimit, clearEffectsOps, EFFECT_IDS, EFFECT_LABELS, effectAt, effectsOf, setEffectIntensityOps, toggleEffectOps } from "./effects-panel.js";
import type { LookEdit } from "./look-panel.js";
import { createKeyHistory } from "./timeline-view.js";

const btn = (on: boolean) => ({ padding: "2px 8px", borderRadius: 6, border: "1px solid #8886", background: "transparent", color: "inherit", cursor: on ? "pointer" : "default", opacity: on ? 1 : 0.5, whiteSpace: "nowrap" }) as const;
const ellipsis = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 } as const;
const release = (fn: () => Promise<void>) => ({ onPointerUp: () => void fn(), onKeyUp: () => void fn(), onBlur: () => void fn() });

export function EffectsPanel({ store, clip }: { store: EditorStore; clip: MediaClip }) {
  const { busy } = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const history = useMemo(() => createKeyHistory(20), []);
  const undoCount = useSyncExternalStore(history.subscribe, history.size, history.size);
  const [message, setMessage] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, number>>({});
  const full = atEffectLimit(clip);
  const list: Effect[] = effectsOf(clip);

  const run = async (edit: LookEdit | null) => {
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
  const commit = async (id: (typeof EFFECT_IDS)[number]) => {
    const v = drafts[id];
    if (v === undefined) return;
    await run(setEffectIntensityOps(clip, id, v));
    setDrafts(({ [id]: _gone, ...rest }) => rest);
  };

  return (
    <div data-effects-panel style={{ borderTop: "1px solid #8883", minWidth: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "8px 12px", minWidth: 0 }}>
        <strong>Effects</strong>
        <span data-effects-count style={{ fontSize: 12, opacity: 0.7 }}>{list.length} of 3</span>
        <span style={{ flex: "1 1 40px" }} />
        <button type="button" data-effects-clear disabled={busy || !list.length} onClick={() => void run(clearEffectsOps(clip))} style={btn(!busy && list.length > 0)}>Clear</button>
        <button type="button" data-effects-undo disabled={busy || !undoCount} onClick={() => void undo()} style={btn(!busy && undoCount > 0)}>Undo</button>
      </div>
      {message ? <div role="alert" data-effects-message style={{ padding: "0 12px 6px", fontSize: 12, color: "#c2410c", overflowWrap: "anywhere" }}>{message}</div> : null}
      <div role="group" aria-label="Effects" style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "0 12px 8px", minWidth: 0 }}>
        {EFFECT_IDS.map((id) => {
          const on = Boolean(effectAt(clip, id));
          const can = !busy && (on || !full);
          return (
            <button key={id} type="button" data-effect-id={id} aria-pressed={on} disabled={!can} onClick={() => void run(toggleEffectOps(clip, id))}
              title={!on && full ? "A clip holds at most 3 effects. Turn one off first." : on ? `${EFFECT_LABELS[id]} (click to remove)` : EFFECT_LABELS[id]}
              style={{ ...btn(can), border: on ? "2px solid currentColor" : "1px solid #8886" }}>{EFFECT_LABELS[id]}</button>
          );
        })}
      </div>
      {list.map((e) => {
        const v = drafts[e.id] ?? e.intensity;
        return (
          <label key={e.id} data-effect-row={e.id} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, padding: "4px 12px", minWidth: 0, borderTop: "1px solid #8882" }}>
            <span style={{ ...ellipsis, flex: "0 0 120px" }}>{EFFECT_LABELS[e.id]}</span>
            <input type="range" aria-label={`${EFFECT_LABELS[e.id]} strength`} min={0} max={1} step={0.01} value={v} disabled={busy}
              onChange={(ev) => setDrafts({ ...drafts, [e.id]: Number(ev.target.value) })} {...release(() => commit(e.id))} style={{ flex: "1 1 120px", minWidth: 0 }} />
            <span style={{ width: 44, textAlign: "right", fontSize: 12 }}>{Math.round(v * 100)}%</span>
          </label>
        );
      })}
    </div>
  );
}
