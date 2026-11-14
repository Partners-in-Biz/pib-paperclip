/**
 * Beat markers and "Cut to beat" for the selected audio clip (PAR-10180). "Find beats" asks the worker
 * (`video-edit-detect-beats`) and draws a tick per beat on a strip the length of the clip; "Preview cuts" asks
 * `video-edit-cut-to-beat` for a dry run and lists the cuts; "Apply cuts" saves exactly those ops through the store,
 * and "Undo cuts" saves the ops that put the clips back. Logic lives in beat-panel.ts (unit tested).
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useHostContext } from "@paperclipai/plugin-sdk/ui";
import { useStudioAction } from "../action.js";
import { audioLength } from "./audio-track.js";
import { beatsAnswer, cutPlan, cuttableTracks, EVERY_CHOICES, markerPercents, type BeatsAnswer, type CutPlan } from "./beat-panel.js";
import type { EditorStore } from "./editor-store.js";
import { formatTime } from "./timeline-view.js";
import type { AudioClip } from "../../video-edit/timeline.js";

const field = { display: "grid", gap: 2, fontSize: 12, minWidth: 0 } as const;
const input = { padding: "4px 6px", borderRadius: 6, border: "1px solid #8886", background: "transparent", color: "inherit", minWidth: 0, width: "100%", boxSizing: "border-box" } as const;
const btn = (on: boolean) => ({ padding: "4px 10px", borderRadius: 6, border: "1px solid #8886", background: "transparent", color: "inherit", cursor: on ? "pointer" : "default", opacity: on ? 1 : 0.5, whiteSpace: "nowrap" }) as const;

export function BeatPanel({ store, clip }: { store: EditorStore; clip: AudioClip }) {
  const { doc, edit, busy, revision } = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const companyId = useHostContext().companyId ?? "";
  const detect = useStudioAction("video-edit-detect-beats");
  const cut = useStudioAction("video-edit-cut-to-beat");
  const tracks = useMemo(() => cuttableTracks(doc), [doc]);
  const [beats, setBeats] = useState<BeatsAnswer | null>(null);
  const [trackId, setTrackId] = useState("");
  const [every, setEvery] = useState<number>(1);
  const [plan, setPlan] = useState<CutPlan | null>(null);
  const [undo, setUndo] = useState<CutPlan["undo"] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const chosen = tracks.some((t) => t.id === trackId) ? trackId : tracks[0]?.id ?? "";
  // A different clip or someone else's save makes the markers and the preview stale.
  useEffect(() => { setBeats(null); setPlan(null); setUndo(null); setMessage(null); }, [clip.id]);
  useEffect(() => { setPlan(null); }, [revision, chosen, every]);

  const ask = async <T,>(run: () => Promise<T>): Promise<T | null> => {
    setWorking(true);
    setMessage(null);
    try { return await run(); } catch (err) { setMessage(err instanceof Error && err.message ? err.message : "That didn't work. Try again."); return null; } finally { setWorking(false); }
  };
  const find = async () => {
    if (!edit) return;
    const raw = await ask(() => detect({ companyId, editId: edit.id, clipId: clip.id }));
    if (raw === null) return;
    const found = beatsAnswer(raw);
    if (!found) return setMessage("Studio sent an unexpected answer. Try again.");
    setBeats(found);
    if (!found.timelineBeats.length) setMessage(found.warning ?? "No beats were found in this clip.");
  };
  const preview = async () => {
    if (!edit || !doc || revision === null || !chosen) return;
    const raw = await ask(() => cut({ companyId, editId: edit.id, baseRevision: revision, musicClipId: clip.id, trackId: chosen, every, dryRun: true }));
    if (raw === null) return;
    const made = cutPlan(doc, (raw as { ops?: unknown }).ops);
    if (!made) return setMessage("Studio sent cuts this edit can't take. Reload and try again.");
    if (!made.rows.length) return setMessage("No clip on that track ends near a beat, so there is nothing to cut.");
    setPlan(made);
  };
  const apply = async () => {
    if (!plan || busy) return;
    const back = plan.undo;
    if (await store.applyOps(plan.ops)) { setUndo(back); setPlan(null); setMessage(`${plan.rows.length} cut${plan.rows.length === 1 ? "" : "s"} applied.`); return; }
    setMessage(store.getState().toast ?? "The cuts weren't saved.");
    store.dismissToast();
  };
  const revert = async () => {
    if (!undo || busy) return;
    if (await store.applyOps(undo)) { setUndo(null); setMessage("Cuts undone."); return; }
    setMessage(store.getState().toast ?? "Undo wasn't saved.");
    store.dismissToast();
  };
  const ticks = beats ? markerPercents(beats.timelineBeats, clip.start, audioLength(clip)) : [];
  const idle = busy || working;

  return (
    <div data-beat-panel style={{ display: "grid", gap: 8, minWidth: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, minWidth: 0 }}>
        <strong style={{ fontSize: 12 }}>Beats</strong>
        <button type="button" data-beat-find disabled={idle || !edit} onClick={() => void find()} style={btn(!idle && Boolean(edit))}>{working && !beats ? "Finding…" : "Find beats"}</button>
        {beats && beats.timelineBeats.length ? <span style={{ fontSize: 12, opacity: 0.75 }}>{Math.round(beats.tempo)} bpm · {beats.timelineBeats.length} beats</span> : null}
      </div>
      {ticks.length ? (
        <div data-beat-markers role="img" aria-label={`${ticks.length} beat markers across the audio clip`} style={{ position: "relative", height: 18, borderRadius: 4, border: "1px solid #8883", overflow: "hidden" }}>
          {ticks.map((p, i) => <span key={i} style={{ position: "absolute", left: `${p}%`, top: 2, bottom: 2, width: 1, background: "currentColor", opacity: 0.8 }} />)}
        </div>
      ) : null}
      {beats && beats.timelineBeats.length ? (
        tracks.length ? (
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "end", gap: 8, minWidth: 0 }}>
            <label style={{ ...field, minWidth: 120 }}>Cut track
              <select aria-label="Track to cut" data-beat-track value={chosen} onChange={(e) => setTrackId(e.target.value)} style={input}>
                {tracks.map((t) => <option key={t.id} value={t.id}>{t.kind} · {t.id} ({t.clips} clip{t.clips === 1 ? "" : "s"})</option>)}
              </select>
            </label>
            <label style={{ ...field, minWidth: 96 }}>Every
              <select aria-label="Cut every nth beat" data-beat-every value={every} onChange={(e) => setEvery(Number(e.target.value))} style={input}>
                {EVERY_CHOICES.map((n) => <option key={n} value={n}>{n === 1 ? "beat" : `${n} beats`}</option>)}
              </select>
            </label>
            <button type="button" data-beat-preview disabled={idle || !chosen} onClick={() => void preview()} style={btn(!idle && Boolean(chosen))}>Preview cuts</button>
          </div>
        ) : <span style={{ fontSize: 12, opacity: 0.75 }}>Add a video clip to cut it to the beat.</span>
      ) : null}
      {plan ? (
        <div data-beat-plan style={{ display: "grid", gap: 6, minWidth: 0 }}>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, maxHeight: 140, overflowY: "auto", overflowWrap: "anywhere" }}>
            {plan.rows.map((r) => <li key={r.clipId}>{r.clipId}: {formatTime(r.from)} → {formatTime(r.to)}, cut at {formatTime(r.cutAt)}</li>)}
          </ul>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button type="button" data-beat-apply disabled={idle} onClick={() => void apply()} style={btn(!idle)}>Apply {plan.rows.length} cut{plan.rows.length === 1 ? "" : "s"}</button>
            <button type="button" disabled={idle} onClick={() => setPlan(null)} style={btn(!idle)}>Discard</button>
          </div>
        </div>
      ) : null}
      {undo ? <div><button type="button" data-beat-undo disabled={idle} onClick={() => void revert()} style={btn(!idle)}>Undo cuts</button></div> : null}
      {message ? <div role="status" style={{ fontSize: 12, overflowWrap: "anywhere" }}>{message}</div> : null}
    </div>
  );
}
