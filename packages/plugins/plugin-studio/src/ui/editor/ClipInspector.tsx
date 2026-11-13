/**
 * Clip inspector (PAR-8451): the selected clip's keyframes at the playhead. Per property (x, y, scale, rotate, opacity,
 * volume, as the clip's kind allows) it shows the value at the playhead, an ease picker and Add / Update / Remove key.
 * Each change is one `setProps { keyframes }` batch through the store; "Undo key change" (or Ctrl/Cmd+Z here) puts the
 * last one back, including a marker drag on the Timeline (one shared `KeyHistory`). Refusals such as `keyframe_limit`
 * show as a sentence in the inspector, not as a code.
 */
import { useEffect, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import type { Clip, Ease, MediaClip, KeyframeProp, TrackKind } from "../../video-edit/timeline.js";
import type { EditorStore } from "./editor-store.js";
import { LayerPanel } from "./LayerPanel.js";
import { LookPanel } from "./LookPanel.js";
import { hasLookPanel } from "./look-panel.js";
import { clipLabel, EASE_LABELS, formatTime, KEY_EASES, KEY_LABELS, KEY_RANGES, keyframeErrorText, keyIndexAt, keyProps, keysOf, localTime, propValueAt, removeKeyOps, setKeyOps, type KeyEdit, type KeyHistory } from "./timeline-view.js";

interface Draft { value: string; ease: Ease }
const STEP: Record<KeyframeProp, number> = { x: 1, y: 1, scale: 0.05, rotate: 1, opacity: 0.05, volume: 0.05 };
const ellipsis = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 } as const;
const btn = (on: boolean) => ({ padding: "2px 8px", borderRadius: 6, border: "1px solid #8886", background: "transparent", color: "inherit", cursor: on ? "pointer" : "default", opacity: on ? 1 : 0.5, whiteSpace: "nowrap" }) as const;

/** Sends one key change; on success it can be undone. Returns the message to show, or null. */
export async function applyKeyEdit(store: EditorStore, history: KeyHistory, clipId: string, edit: KeyEdit | null): Promise<string | null> {
  if (!edit) return null;
  if ("error" in edit) return edit.error;
  if (await store.applyOps(edit.ops)) {
    history.push({ clipId, ops: edit.undo });
    return null;
  }
  const text = keyframeErrorText(store.getState().toast);
  store.dismissToast();
  return text;
}
export async function undoKeyChange(store: EditorStore, history: KeyHistory): Promise<string | null> {
  const last = history.peek();
  if (!last || store.getState().busy) return null;
  const exists = store.getState().doc?.tracks.some((t) => t.clips.some((c) => c.id === last.clipId));
  if (!exists) {
    history.drop();
    return "That clip is gone, so its key change can't be undone.";
  }
  if (await store.applyOps(last.ops)) {
    history.drop();
    return null;
  }
  const text = keyframeErrorText(store.getState().toast);
  store.dismissToast();
  return text;
}

export function ClipInspector({ store, history }: { store: EditorStore; history: KeyHistory }) {
  const { doc, playhead, selectedClipId, busy } = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const undoCount = useSyncExternalStore(history.subscribe, history.size, history.size);
  const [drafts, setDrafts] = useState<Partial<Record<KeyframeProp, Draft>>>({});
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => setDrafts({}), [selectedClipId, playhead, doc]);
  useEffect(() => setMessage(null), [selectedClipId]);

  const found = ((): { clip: Clip; kind: TrackKind } | null => {
    for (const tr of doc?.tracks ?? []) for (const c of tr.clips as Clip[]) if (c.id === selectedClipId) return { clip: c, kind: tr.kind };
    return null;
  })();
  const props = found ? keyProps(found.kind) : [];
  const t = found ? localTime(found.clip, playhead) : null;

  const run = async (edit: KeyEdit | null) => {
    if (!found || busy) return;
    setMessage(await applyKeyEdit(store, history, found.clip.id, edit));
  };
  const undo = async () => setMessage(await undoKeyChange(store, history));
  function onKey(e: KeyboardEvent<HTMLElement>) {
    if ((e.key === "z" || e.key === "Z") && (e.metaKey || e.ctrlKey) && !e.shiftKey && undoCount) {
      e.preventDefault();
      void undo();
    }
  }

  const hint = !found ? "Select a clip on the timeline to animate it."
    : !props.length ? "Captions can't be animated."
    : t === null ? `Move the playhead inside ${clipLabel(found.clip)} to add or remove keys.`
    : `Keys at ${formatTime(t)} in the clip. Drag a ◆ on the timeline to move a key.`;
  return (
    <section aria-label="Clip inspector" data-editor-panel="inspector" onKeyDown={onKey} style={{ border: "1px solid #8884", borderRadius: 8, minWidth: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid #8883", minWidth: 0 }}>
        <strong>Keyframes</strong>
        <span style={{ ...ellipsis, flex: "1 1 160px", opacity: 0.75 }} title={found ? clipLabel(found.clip) : undefined}>{found ? clipLabel(found.clip) : "No clip selected"}</span>
        {undoCount ? <button type="button" onClick={() => void undo()} disabled={busy} title="Put the last key change back (Ctrl/Cmd+Z)" style={btn(!busy)}>Undo key change</button> : null}
      </div>
      <div data-inspector-hint style={{ padding: "6px 12px", fontSize: 12, opacity: 0.75, overflowWrap: "anywhere" }}>{hint}</div>
      {message ? <div role="alert" data-inspector-message style={{ padding: "0 12px 6px", fontSize: 12, color: "#c2410c", overflowWrap: "anywhere" }}>{message}</div> : null}
      {found ? props.map((prop) => {
        const clip = found.clip;
        const keys = keysOf(clip, prop);
        const at = t === null ? -1 : keyIndexAt(keys, t);
        const draft: Draft = drafts[prop] ?? { value: String(propValueAt(clip, prop, t ?? 0)), ease: at >= 0 ? keys[at].ease : "linear" };
        const value = Number(draft.value);
        const changed = at < 0 || keys[at].value !== value || keys[at].ease !== draft.ease;
        const can = t !== null && !busy;
        const [lo, hi] = KEY_RANGES[prop];
        return (
          <div key={prop} data-key-row={prop} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, padding: "4px 12px", minWidth: 0, borderTop: "1px solid #8882" }}>
            <span style={{ ...ellipsis, flex: "0 0 84px" }}>{at >= 0 ? "◆ " : ""}{KEY_LABELS[prop]}</span>
            <input type="number" aria-label={`${KEY_LABELS[prop]} at the playhead`} min={lo} max={hi} step={STEP[prop]} value={draft.value} disabled={!can}
              onChange={(e) => setDrafts({ ...drafts, [prop]: { ...draft, value: e.target.value } })} style={{ width: 84, minWidth: 0 }} />
            <select aria-label={`${KEY_LABELS[prop]} ease`} value={draft.ease} disabled={!can} onChange={(e) => setDrafts({ ...drafts, [prop]: { ...draft, ease: e.target.value as Ease } })} style={{ minWidth: 0, maxWidth: 120 }}>
              {KEY_EASES.map((e) => <option key={e} value={e}>{EASE_LABELS[e]}</option>)}
            </select>
            <button type="button" disabled={!can || !changed || draft.value.trim() === ""} onClick={() => void run(setKeyOps(clip, prop, t ?? 0, value, draft.ease))} style={btn(can && changed)}>
              {at >= 0 ? "Update key" : "Add key"}
            </button>
            {at >= 0 ? <button type="button" disabled={!can} onClick={() => void run(removeKeyOps(clip, prop, t ?? 0))} style={btn(can)}>Remove key</button> : null}
            <span data-key-count style={{ fontSize: 12, opacity: 0.7, whiteSpace: "nowrap" }}>{keys.length} {keys.length === 1 ? "key" : "keys"}</span>
          </div>
        );
      }) : null}
      {found && found.kind === "overlay" ? <LayerPanel store={store} clip={found.clip as MediaClip} /> : null}
      {found && hasLookPanel(found.kind) ? <LookPanel store={store} clip={found.clip as MediaClip} /> : null}
    </section>
  );
}
