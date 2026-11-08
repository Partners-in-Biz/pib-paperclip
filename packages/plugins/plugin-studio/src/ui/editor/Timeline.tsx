/**
 * Timeline (PAR-8315): one lane per track, a ruler and the playhead. Click a clip to select it, click empty space or
 * the ruler to move the playhead, drag a video/overlay/audio clip's edge to trim it (PAR-8324: a ripple trim, the later
 * clips on the lane close up or make room; hold Alt/Option at release for a free trim that keeps the gap), Delete (key or button) removes the
 * selected clip. PAR-8317: drag a clip's body along its lane to reorder it, "Split at playhead" (or S) cuts the clip
 * under the playhead, "Add clip" joins a Library video or picture onto the end of the video track. PAR-8450: the button on a
 * join between two main-track clips opens the transition picker (15 xfade types + length; None removes it); "Undo
 * transition" (or Ctrl/Cmd+Z) puts the last picker change back. PAR-8451: a ◆ marker on a clip per keyframe time; drag it
 * along the clip to move those keys (one `setProps`, undone with the ClipInspector's shared `KeyHistory`). Each gesture sends exactly one `video-edit-apply-ops` batch through the store; the lanes always draw
 * the doc the server returned (a drag only previews locally until that answer arrives). No snapping in v1.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from "react";
import { useHostContext } from "@paperclipai/plugin-sdk/ui";
import type { Clip, TrackKind } from "../../video-edit/timeline.js";
import { clipCount, type EditorStore } from "./editor-store.js";
import { AddClipDialog } from "./AddClipDialog.js";
import { AudioTrack } from "./AudioTrack.js";
import { CaptionTrack } from "./CaptionTrack.js";
import { TextTrack } from "./TextTrack.js";
import { applyKeyEdit, undoKeyChange } from "./ClipInspector.js";
import { addClipOps, clipEnd, createKeyHistory, keyMarkers, moveKeysOps, type KeyHistory, clipJoins, DEFAULT_TRANSITION_SECONDS, TRANSITION_LABELS, TRANSITION_TYPES, transitionOps, type Join, type TransitionKind, type TransitionPick, clipLabel, clipLength, clipUnderPlayhead, docLength, fitScale, formatTime, hitTest, isTrimmable, pxToSeconds, reorderResult, rippleBox, secondsToPx, splitTarget, tickStep, trimResult, type LibraryPick, type TrimEdge } from "./timeline-view.js";

const LABEL_W = 104;
const LANE_H = 40;
const RULER_H = 22;
const EDGE_PX = 8;
/** A body press only becomes a reorder drag after this many px, so a click still just selects. */
const MOVE_SLOP_PX = 4;
const KIND_COLOR: Record<TrackKind, string> = { video: "#3b6fd9", overlay: "#7a4fd1", text: "#c2782a", caption: "#2f9a6b", audio: "#2a8fa8" };

/** `edge` is a trim drag; `move` is a body drag that reorders the clip on its lane (`trackId`) once `moved`. `free`: Alt is held (trim without ripple). */
interface Drag { clipId: string; edge: TrimEdge | "move"; trackId: string; originX: number; pointerId: number; delta: number; moved: boolean; free: boolean }

/** The picker's open join (`toId`) and its unsaved choice; `type: null` is None. */
interface Picking { toId: string; type: TransitionKind | null; duration: string }
/** One picker change to undo: the transition the join had before it. */
interface UndoEntry { toId: string; before: TransitionPick | null }
/** A keyframe marker drag: the keys at clip time `from` move by `delta` s. */
interface KeyDrag { clipId: string; from: number; originX: number; pointerId: number; delta: number }
const MARKER_PX = 10;
const JOIN_PX = 18;

const ellipsis = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 } as const;

export function Timeline({ store, keyHistory }: { store: EditorStore; keyHistory?: KeyHistory }) {
  const { doc, edit, playhead, selectedClipId, busy } = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const companyId = useHostContext().companyId ?? "";
  const [adding, setAdding] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [drag, setDrag] = useState<Drag | null>(null);
  // The live drag also sits in a ref, so pointerup and pointercancel can't both send it: whoever clears it first wins.
  const dragRef = useRef<Drag | null>(null);
  const [picking, setPicking] = useState<Picking | null>(null);
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const [ownHistory] = useState(createKeyHistory);
  const history = keyHistory ?? ownHistory;
  const [keyDrag, setKeyDrag] = useState<KeyDrag | null>(null);
  const keyDragRef = useRef<KeyDrag | null>(null);
  const [keyNote, setKeyNote] = useState<string | null>(null);
  const setLiveKeyDrag = (d: KeyDrag | null) => {
    keyDragRef.current = d;
    setKeyDrag(d);
  };
  const editId = edit?.id ?? null;
  useEffect(() => {
    setPicking(null);
    setUndoStack([]);
  }, [editId]);
  const setLiveDrag = (d: Drag | null) => {
    dragRef.current = d;
    setDrag(d);
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const tracks = doc?.tracks ?? [];
  const duration = docLength(doc);
  const pps = fitScale(duration, width - LABEL_W - 24);
  const laneW = Math.max(width - LABEL_W, Math.ceil(secondsToPx(Math.max(duration, 1), pps)) + 48);
  const step = tickStep(pps);
  const ticks: number[] = [];
  for (let t = 0; secondsToPx(t, pps) <= laneW - 40; t += step) ticks.push(t);
  const atPlayhead = clipUnderPlayhead(doc, playhead);
  const findClip = (id: string): Clip | null => {
    for (const t of tracks) for (const c of t.clips as Clip[]) if (c.id === id) return c;
    return null;
  };
  const selected = selectedClipId ? findClip(selectedClipId) : null;
  const dragClip = drag ? findClip(drag.clipId) : null;
  const preview = !drag || !dragClip ? null
    : drag.edge === "move" ? (drag.moved ? { start: Math.max(0, dragClip.start + drag.delta), end: Math.max(0, dragClip.start + drag.delta) + clipLength(dragClip) } : null)
    : trimResult(dragClip, drag.edge, drag.delta, drag.free);
  const ripple = drag && dragClip && preview && "shift" in preview && preview.shift ? { trackId: drag.trackId, clip: dragClip, result: preview } : null;

  const secondsAt = (e: PointerEvent<HTMLElement>) => pxToSeconds(e.clientX - e.currentTarget.getBoundingClientRect().left, pps);
  const movePlayhead = (e: PointerEvent<HTMLElement>) => store.setPlayhead(Math.min(Math.max(0, secondsAt(e)), duration));

  function onLaneDown(trackId: string, clips: Clip[], e: PointerEvent<HTMLDivElement>) {
    if (busy || dragRef.current || e.button !== 0) return;
    const hit = hitTest(clips, secondsAt(e), pps, EDGE_PX);
    if (!hit) {
      store.selectClip(null);
      movePlayhead(e);
      return;
    }
    store.selectClip(hit.clipId);
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setLiveDrag({ clipId: hit.clipId, edge: hit.part === "body" ? "move" : hit.part, trackId, originX: e.clientX, pointerId: e.pointerId, delta: 0, moved: hit.part !== "body", free: e.altKey });
  }
  function onLaneMove(e: PointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.originX;
    setLiveDrag({ ...d, delta: dx / pps, moved: d.moved || Math.abs(dx) > MOVE_SLOP_PX, free: e.altKey });
  }
  function onLaneUp(e: PointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    dragRef.current = null; // one gesture, one batch
    const clip = findClip(d.clipId);
    const delta = (e.clientX - d.originX) / pps;
    const moved = d.moved || Math.abs(e.clientX - d.originX) > MOVE_SLOP_PX;
    const lane = tracks.find((t) => t.id === d.trackId);
    const result = !clip ? null : d.edge === "move" ? (moved && lane ? reorderResult(lane.id, lane.clips as Clip[], clip.id, delta) : null) : trimResult(clip, d.edge, delta, e.altKey); // Alt at release: free trim
    if (!result) return setDrag(null);
    void store.applyOps(result.ops).finally(() => setDrag(null));
  }
  function onLaneCancel(e: PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === e.pointerId) setLiveDrag(null);
  }
  function onMarkerDown(clipId: string, from: number, e: PointerEvent<HTMLElement>) {
    e.stopPropagation();
    if (busy || dragRef.current || keyDragRef.current || e.button !== 0) return;
    e.preventDefault();
    store.selectClip(clipId);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setLiveKeyDrag({ clipId, from, originX: e.clientX, pointerId: e.pointerId, delta: 0 });
  }
  function onMarkerMove(e: PointerEvent<HTMLElement>) {
    const d = keyDragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    e.stopPropagation();
    setLiveKeyDrag({ ...d, delta: (e.clientX - d.originX) / pps });
  }
  function onMarkerUp(e: PointerEvent<HTMLElement>) {
    const d = keyDragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    e.stopPropagation();
    keyDragRef.current = null; // one gesture, one batch
    const clip = findClip(d.clipId);
    const edit = clip ? moveKeysOps(clip, d.from, d.from + (e.clientX - d.originX) / pps) : null;
    if (!clip || !edit) return setKeyDrag(null);
    void applyKeyEdit(store, history, clip.id, edit).then((note) => setKeyNote(note)).finally(() => setKeyDrag(null));
  }
  const deleteSelected = () => {
    if (selectedClipId && !busy) void store.applyOps([{ op: "delete", clipId: selectedClipId }]);
  };
  const split = splitTarget(doc, selectedClipId, playhead);
  const splitAtPlayhead = () => {
    if (split && !busy) void store.applyOps([{ op: "split", clipId: split.clipId, at: split.at }]);
  };
  const client = (edit as { client?: { kind?: string | null; id?: string | null } | null } | null)?.client ?? null;
  const addPicked = async (pick: LibraryPick) => {
    const made = addClipOps(doc, pick);
    if ("error" in made) return made.error;
    if (!(await store.applyOps(made.ops))) return store.getState().toast ?? "The clip wasn't added. Try again.";
    store.selectClip(made.clipId);
    store.setPlayhead(made.start);
    return null;
  };
  function onKey(e: KeyboardEvent<HTMLElement>) {
    if (e.target !== e.currentTarget && (e.target as HTMLElement).closest?.("input, select, textarea, [role=dialog]")) return;
    if ((e.key === "Delete" || e.key === "Backspace") && selected) {
      e.preventDefault();
      deleteSelected();
    } else if ((e.key === "s" || e.key === "S") && !e.metaKey && !e.ctrlKey && !e.altKey && split) {
      e.preventDefault();
      splitAtPlayhead();
    } else if ((e.key === "z" || e.key === "Z") && (e.metaKey || e.ctrlKey) && !e.shiftKey && undoStack.length) {
      e.preventDefault();
      void undoTransition();
    } else if ((e.key === "z" || e.key === "Z") && (e.metaKey || e.ctrlKey) && !e.shiftKey && history.size()) {
      e.preventDefault();
      void undoKeyChange(store, history).then(setKeyNote);
    } else if (e.key === "Escape" && keyDragRef.current) setLiveKeyDrag(null);
    else if (e.key === "Escape" && dragRef.current) setLiveDrag(null);
    else if (e.key === "Escape" && picking) setPicking(null);
  }

  const joins = clipJoins(doc);
  const joinFor = (toId: string) => joins.find((j) => j.toId === toId) ?? null;
  const nameOf = (id: string) => {
    const c = findClip(id);
    return c ? clipLabel(c) : id;
  };
  const pickJoin = (j: Join) =>
    setPicking({ toId: j.toId, type: j.transition?.type ?? "fade", duration: String(j.transition?.duration ?? Math.min(DEFAULT_TRANSITION_SECONDS, j.maxDuration)) });
  const pickJoinNow = picking ? joinFor(picking.toId) : null;
  const pickedLength = picking ? Number(picking.duration) : NaN;
  const pickedOps = picking && pickJoinNow ? transitionOps(doc, picking.toId, picking.type ? { type: picking.type, duration: pickedLength } : null) : null;
  /** Sends one picker change; on success it can be undone. */
  async function applyTransition(toId: string, pick: TransitionPick | null) {
    const join = joinFor(toId);
    const ops = join ? transitionOps(doc, toId, pick) : null;
    if (!join || !ops || busy) return;
    if (await store.applyOps(ops)) {
      setUndoStack((u) => [...u.slice(-19), { toId, before: join.transition }]);
      setPicking(null);
    }
  }
  async function undoTransition() {
    const last = undoStack[undoStack.length - 1];
    if (!last || busy) return;
    const ops = transitionOps(store.getState().doc, last.toId, last.before);
    if (ops && !(await store.applyOps(ops))) return;
    setUndoStack((u) => u.slice(0, -1));
  }

  const canDelete = Boolean(selected) && !busy;
  const canSplit = Boolean(split) && !busy;
  const btn = (on: boolean) => ({ padding: "4px 10px", borderRadius: 6, border: "1px solid #8886", background: "transparent", color: "inherit", cursor: on ? "pointer" : "default", opacity: on ? 1 : 0.5, whiteSpace: "nowrap" }) as const;
  return (
    <section aria-label="Timeline" data-editor-panel="timeline" tabIndex={0} onKeyDown={onKey} style={{ border: "1px solid #8884", borderRadius: 8, minWidth: 0, outline: "none" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid #8883", minWidth: 0 }}>
        <strong>Timeline</strong>
        <span style={{ opacity: 0.75 }} data-timeline-summary>{tracks.length} tracks · {clipCount(doc)} clips · {formatTime(duration)}</span>
        <span style={{ ...ellipsis, flex: "1 1 160px", opacity: 0.75 }} data-timeline-playhead>
          Playhead {formatTime(playhead)}{atPlayhead ? ` · ${clipLabel(atPlayhead.clip)}` : ""}
        </span>
        <button type="button" onClick={() => setAdding(true)} disabled={busy || !companyId} title="Join a Library video or picture onto the end of the video track" style={btn(!busy && Boolean(companyId))}>
          Add clip
        </button>
        <button type="button" onClick={splitAtPlayhead} disabled={!canSplit} title={split ? `Split ${split.clipId} at ${formatTime(split.at)} (S)` : "Move the playhead inside a clip first"} style={btn(canSplit)}>
          Split at playhead
        </button>
        <button type="button" onClick={deleteSelected} disabled={!canDelete} title={selected ? `Delete ${clipLabel(selected)}` : "Select a clip first"} style={btn(canDelete)}>
          Delete clip
        </button>
        {undoStack.length ? (
          <button type="button" onClick={() => void undoTransition()} disabled={busy} title="Put the last transition change back (Ctrl/Cmd+Z)" style={btn(!busy)}>
            Undo transition
          </button>
        ) : null}
      </div>
      {picking && pickJoinNow ? (
        <div role="group" aria-label="Transition picker" data-transition-picker={picking.toId} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid #8883", minWidth: 0 }}>
          <span style={{ ...ellipsis, flex: "1 1 180px" }} title={`${nameOf(pickJoinNow.fromId)} → ${nameOf(pickJoinNow.toId)}`}>
            Transition {nameOf(pickJoinNow.fromId)} → {nameOf(pickJoinNow.toId)}
          </span>
          <label style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
            Type
            <select aria-label="Transition type" value={picking.type ?? "none"} onChange={(e) => setPicking({ ...picking, type: e.target.value === "none" ? null : (e.target.value as TransitionKind) })} style={{ minWidth: 0, maxWidth: 180 }}>
              <option value="none">None</option>
              {TRANSITION_TYPES.map((t) => <option key={t} value={t}>{TRANSITION_LABELS[t]}</option>)}
            </select>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
            Length (s)
            <input type="number" aria-label="Transition length in seconds" min={0.1} max={pickJoinNow.maxDuration} step={0.1} value={picking.duration} disabled={!picking.type} onChange={(e) => setPicking({ ...picking, duration: e.target.value })} style={{ width: 64 }} />
          </label>
          <button type="button" onClick={() => void applyTransition(picking.toId, picking.type ? { type: picking.type, duration: pickedLength } : null)} disabled={busy || !pickedOps} style={btn(!busy && Boolean(pickedOps))}>
            Apply
          </button>
          {pickJoinNow.transition ? (
            <button type="button" onClick={() => void applyTransition(picking.toId, null)} disabled={busy} style={btn(!busy)}>
              Remove
            </button>
          ) : null}
          <button type="button" onClick={() => setPicking(null)} style={btn(true)}>Close</button>
          <span data-transition-hint style={{ flexBasis: "100%", minWidth: 0, overflowWrap: "anywhere", fontSize: 12, opacity: 0.7 }}>
            {picking.type && !(pickedLength >= 0.1 && pickedLength <= pickJoinNow.maxDuration) ? `Pick a length from 0.1 to ${pickJoinNow.maxDuration} s.` : `Up to ${pickJoinNow.maxDuration} s. The clips overlap by the length; later clips on this track move to make room.`}
          </span>
        </div>
      ) : null}
      <TextTrack store={store} />
      <CaptionTrack store={store} />
      <AudioTrack store={store} />
      <div ref={scrollRef} style={{ overflowX: "auto", overflowY: "hidden", minWidth: 0 }}>
        {tracks.length === 0 ? (
          <div style={{ padding: 16, opacity: 0.75 }}>No tracks yet. Add a clip to start.</div>
        ) : (
          <div style={{ position: "relative", width: LABEL_W + laneW, opacity: busy ? 0.7 : 1 }}>
            <div style={{ display: "flex", height: RULER_H, borderBottom: "1px solid #8883" }}>
              <div style={{ position: "sticky", left: 0, zIndex: 2, width: LABEL_W, flex: "none", background: "var(--background, Canvas)" }} />
              <div aria-label="Ruler: click to move the playhead" onPointerDown={(e) => !busy && movePlayhead(e)} style={{ position: "relative", width: laneW, cursor: "pointer", overflow: "hidden" }}>
                {ticks.map((t) => (
                  <span key={t} style={{ position: "absolute", left: secondsToPx(t, pps), top: 0, bottom: 0, borderLeft: "1px solid #8886", paddingLeft: 3, fontSize: 11, opacity: 0.7, whiteSpace: "nowrap" }}>{formatTime(t)}</span>
                ))}
              </div>
            </div>
            {tracks.map((track) => {
              const clips = track.clips as Clip[];
              return (
                <div key={track.id} data-track={track.id} style={{ display: "flex", height: LANE_H, borderBottom: "1px solid #8882" }}>
                  <div title={`${track.kind} · ${track.id}`} style={{ ...ellipsis, position: "sticky", left: 0, zIndex: 2, width: LABEL_W, flex: "none", boxSizing: "border-box", padding: "0 8px", lineHeight: `${LANE_H}px`, fontSize: 12, background: "var(--background, Canvas)", borderRight: "1px solid #8883" }}>
                    {track.kind} · {track.id}
                  </div>
                  <div onPointerDown={(e) => onLaneDown(track.id, clips, e)} onPointerMove={onLaneMove} onPointerUp={onLaneUp} onPointerCancel={onLaneCancel} style={{ position: "relative", width: laneW, touchAction: "pan-y" }}>
                    {clips.map((clip) => {
                      const box = preview && drag?.clipId === clip.id ? preview
                        : ripple && ripple.trackId === track.id ? rippleBox(clip, ripple.clip, ripple.result)
                        : { start: clip.start, end: clipEnd(clip) };
                      const isSel = clip.id === selectedClipId;
                      const label = clipLabel(clip);
                      const handle = isTrimmable(clip) ? <span aria-hidden style={{ width: 6, alignSelf: "stretch", flex: "none", background: "#0004", cursor: "ew-resize" }} /> : null;
                      return (
                        <div key={clip.id} data-clip={clip.id} data-selected={isSel || undefined} title={`${label} · ${formatTime(box.start)}–${formatTime(box.end)}`}
                          style={{ position: "absolute", top: 4, bottom: 4, left: secondsToPx(box.start, pps), width: Math.max(2, secondsToPx(box.end - box.start, pps)), boxSizing: "border-box", borderRadius: 4, background: KIND_COLOR[track.kind], color: "#fff", border: isSel ? "2px solid #ffd54a" : "1px solid #0003", cursor: drag?.clipId === clip.id && drag.edge === "move" && drag.moved ? "grabbing" : "grab", zIndex: drag?.clipId === clip.id ? 1 : undefined, overflow: "hidden", display: "flex", alignItems: "center" }}>
                          {handle}
                          <span style={{ ...ellipsis, flex: 1, padding: "0 4px", fontSize: 12 }}>{label}</span>
                          {handle}
                          {drag?.clipId === clip.id ? null : keyMarkers(clip).map((m) => {
                            const live = keyDrag && keyDrag.clipId === clip.id && keyDrag.from === m.t;
                            const t = live ? Math.min(Math.max(0, m.t + keyDrag.delta), clipLength(clip)) : m.t;
                            const left = Math.min(Math.max(0, secondsToPx(t, pps) - MARKER_PX / 2), Math.max(0, secondsToPx(clipLength(clip), pps) - MARKER_PX));
                            return (
                              <span key={`key-${m.t}`} role="button" data-key-marker={`${clip.id}@${m.t}`} aria-label={`Key at ${formatTime(t)} (${m.props.join(", ")}): drag to move`} title={`Key at ${formatTime(t)}: ${m.props.join(", ")}. Drag to move.`}
                                onPointerDown={(e) => onMarkerDown(clip.id, m.t, e)} onPointerMove={onMarkerMove} onPointerUp={onMarkerUp} onPointerCancel={(e) => keyDragRef.current?.pointerId === e.pointerId && setLiveKeyDrag(null)}
                                style={{ position: "absolute", bottom: 3, left, width: MARKER_PX, height: MARKER_PX, boxSizing: "border-box", transform: "rotate(45deg)", background: live ? "#fff" : "#ffd54a", border: "1px solid #0008", cursor: "ew-resize", touchAction: "none", zIndex: 2 }} />
                            );
                          })}
                        </div>
                      );
                    })}
                    {drag ? null : joins.filter((j) => j.trackId === track.id).map((j) => {
                      const label = j.transition ? `${TRANSITION_LABELS[j.transition.type] ?? j.transition.type} ${j.transition.duration} s` : "No transition";
                      const open = picking?.toId === j.toId;
                      const can = j.maxDuration >= 0.1 && !busy;
                      return (
                        <span key={`join-${j.toId}`} style={{ display: "contents" }}>
                          {j.transition ? <span aria-hidden data-transition-window={j.toId} style={{ position: "absolute", top: 4, bottom: 4, left: secondsToPx(j.at - j.overlap / 2, pps), width: Math.max(2, secondsToPx(j.overlap, pps)), background: "repeating-linear-gradient(135deg, #fff5 0 4px, #0000 4px 8px)", pointerEvents: "none", zIndex: 2 }} /> : null}
                          <button type="button" data-join={j.toId} aria-label={`Transition between ${nameOf(j.fromId)} and ${nameOf(j.toId)}: ${label}`} title={`${nameOf(j.fromId)} → ${nameOf(j.toId)}: ${label}`}
                            disabled={!can} onPointerDown={(e) => e.stopPropagation()} onClick={() => (open ? setPicking(null) : pickJoin(j))}
                            style={{ position: "absolute", top: (LANE_H - JOIN_PX) / 2, left: secondsToPx(j.at, pps) - JOIN_PX / 2, width: JOIN_PX, height: JOIN_PX, padding: 0, borderRadius: "50%", border: open ? "2px solid #ffd54a" : "1px solid #0006", background: j.transition ? "#ffd54a" : "#fff", color: "#000", fontSize: 11, lineHeight: 1, cursor: can ? "pointer" : "default", zIndex: 3 }}>
                            {j.transition ? "⇄" : "+"}
                          </button>
                        </span>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            <div aria-hidden data-playhead style={{ position: "absolute", top: 0, bottom: 0, left: LABEL_W + secondsToPx(playhead, pps), width: 2, marginLeft: -1, background: "#e5484d", pointerEvents: "none", zIndex: 1 }} />
          </div>
        )}
      </div>
      {tracks.length ? <div data-timeline-help style={{ ...ellipsis, padding: "4px 12px", fontSize: 12, opacity: 0.7 }}>Alt-drag an edge: trim without closing the gap · drag a ◆ to move a key</div> : null}
      {keyNote ? <div role="alert" data-key-note style={{ padding: "0 12px 6px", fontSize: 12, color: "#c2410c", overflowWrap: "anywhere" }}>{keyNote}</div> : null}
      {adding ? <AddClipDialog companyId={companyId} client={client} busy={busy} onPick={addPicked} onClose={() => setAdding(false)} /> : null}
    </section>
  );
}
