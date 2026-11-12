/**
 * Adjust & Look panel (PAR-10160), mounted from the ClipInspector for the selected video or overlay clip: six adjust
 * sliders, a grid of the 12 pib-basic looks (each thumbnail is a test card run through the same SVG filter the Player
 * uses), look intensity, "Apply to all clips" (one ops batch), Reset and Undo. Each change is one `setProps` batch;
 * Undo puts the last one back. Refusals show as a sentence here.
 */
import { useId, useMemo, useState, useSyncExternalStore } from "react";
import { ADJUST_RANGE, toSvgFilter } from "../../video-edit/looks.js";
import type { MediaClip } from "../../video-edit/timeline.js";
import type { EditorStore } from "./editor-store.js";
import { createKeyHistory } from "./timeline-view.js";
import { ADJUST_ROWS, adjustValue, applyToAllOps, isGraded, LOOK_IDS, lookLabel, mediaClips, resetOps, setAdjustOps, setIntensityOps, setLookOps, type LookEdit } from "./look-panel.js";

const btn = (on: boolean) => ({ padding: "2px 8px", borderRadius: 6, border: "1px solid #8886", background: "transparent", color: "inherit", cursor: on ? "pointer" : "default", opacity: on ? 1 : 0.5, whiteSpace: "nowrap" }) as const;
const ellipsis = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 } as const;
/** Save when the pointer or key is released, or focus leaves. */
const release = (fn: () => Promise<void>) => ({ onPointerUp: () => void fn(), onKeyUp: () => void fn(), onBlur: () => void fn() });
const CARD = [["0", "#f4d6b8"], ["0.3", "#c98b5e"], ["0.5", "#4f8f4a"], ["0.7", "#3b6fb6"], ["1", "#2a2233"]] as const;

/** A 64x40 test card through one look at full strength (or none). */
function Swatch({ lookId, uid }: { lookId: string | null; uid: string }) {
  const filter = lookId ? toSvgFilter({ pack: "pib-basic", id: lookId, intensity: 1 }, { id: `${uid}f` }) : "";
  return (
    <svg aria-hidden width={64} height={40} viewBox="0 0 64 40" style={{ display: "block", maxWidth: "100%", borderRadius: 4 }}>
      <defs>
        <linearGradient id={`${uid}g`} x1="0" x2="1" y1="0" y2="0.4">{CARD.map(([o, c]) => <stop key={o} offset={o} stopColor={c} />)}</linearGradient>
        {filter ? <g dangerouslySetInnerHTML={{ __html: filter }} /> : null}
      </defs>
      <rect width={64} height={40} fill={`url(#${uid}g)`} filter={filter ? `url(#${uid}f)` : undefined} />
    </svg>
  );
}

export function LookPanel({ store, clip }: { store: EditorStore; clip: MediaClip }) {
  const { doc, busy } = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const history = useMemo(() => createKeyHistory(20), []);
  const undoCount = useSyncExternalStore(history.subscribe, history.size, history.size);
  const [message, setMessage] = useState<string | null>(null);
  const uid = useId().replace(/[^A-Za-z0-9]/g, "");
  // A slider drags on a local value and saves once when released, so a drag is one change and one undo step.
  const [drafts, setDrafts] = useState<Record<string, number>>({});
  const commit = async (key: string, edit: (v: number) => LookEdit | null) => {
    const v = drafts[key];
    if (v === undefined) return;
    await run(edit(v));
    setDrafts(({ [key]: _gone, ...rest }) => rest);
  };
  const others = mediaClips(doc).filter((c) => c.id !== clip.id).length;

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

  return (
    <div data-look-panel style={{ borderTop: "1px solid #8883", minWidth: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "8px 12px", minWidth: 0 }}>
        <strong>Adjust &amp; Look</strong>
        <span style={{ flex: "1 1 40px" }} />
        <button type="button" data-look-apply-all disabled={busy || !isGraded(clip) || !others} onClick={() => void run(applyToAllOps(doc, clip))} style={btn(!busy && isGraded(clip) && others > 0)} title="Copy this clip's look and adjust to every other video and overlay clip">Apply to all clips</button>
        <button type="button" data-look-reset disabled={busy || !isGraded(clip)} onClick={() => void run(resetOps(clip))} style={btn(!busy && isGraded(clip))}>Reset</button>
        <button type="button" data-look-undo disabled={busy || !undoCount} onClick={() => void undo()} style={btn(!busy && undoCount > 0)}>Undo</button>
      </div>
      {message ? <div role="alert" data-look-message style={{ padding: "0 12px 6px", fontSize: 12, color: "#c2410c", overflowWrap: "anywhere" }}>{message}</div> : null}
      <div role="group" aria-label="Looks" data-look-grid style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))", gap: 6, padding: "0 12px 8px", minWidth: 0 }}>
        {LOOK_IDS.map((id) => {
          const on = clip.look?.id === id;
          return (
            <button key={id} type="button" data-look-id={id} aria-pressed={on} disabled={busy} onClick={() => void run(setLookOps(clip, id))} title={on ? `${lookLabel(id)} (click to remove)` : lookLabel(id)}
              style={{ display: "grid", gap: 2, padding: 3, minWidth: 0, borderRadius: 6, border: on ? "2px solid currentColor" : "1px solid #8886", background: "transparent", color: "inherit", cursor: busy ? "default" : "pointer", fontSize: 11 }}>
              <Swatch lookId={id} uid={`${uid}${id.replace(/\W/g, "")}`} />
              <span style={ellipsis}>{lookLabel(id)}</span>
            </button>
          );
        })}
      </div>
      {clip.look ? (
        <label data-look-intensity style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, padding: "4px 12px", minWidth: 0 }}>
          <span style={{ ...ellipsis, flex: "0 0 120px" }}>Look strength</span>
          <input type="range" aria-label="Look strength" min={0} max={1} step={0.01} value={drafts.intensity ?? clip.look.intensity} onChange={(e) => setDrafts({ ...drafts, intensity: Number(e.target.value) })}
            {...release(() => commit("intensity", (v) => setIntensityOps(clip, v)))} style={{ flex: "1 1 120px", minWidth: 0 }} />
          <span style={{ width: 44, textAlign: "right", fontSize: 12 }}>{Math.round((drafts.intensity ?? clip.look.intensity) * 100)}%</span>
        </label>
      ) : null}
      {ADJUST_ROWS.map(({ field, label, step }) => {
        const [lo, hi] = ADJUST_RANGE[field];
        const v = drafts[field] ?? adjustValue(clip, field);
        return (
          <label key={field} data-adjust-row={field} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, padding: "4px 12px", minWidth: 0, borderTop: "1px solid #8882" }}>
            <span style={{ ...ellipsis, flex: "0 0 120px" }}>{label}</span>
            <input type="range" aria-label={label} min={lo} max={hi} step={step} value={v} onChange={(e) => setDrafts({ ...drafts, [field]: Number(e.target.value) })}
              {...release(() => commit(field, (n) => setAdjustOps(clip, field, n)))} style={{ flex: "1 1 120px", minWidth: 0 }} />
            <span style={{ width: 52, textAlign: "right", fontSize: 12 }}>{Number.isInteger(step) ? v : v.toFixed(2)}</span>
          </label>
        );
      })}
    </div>
  );
}
