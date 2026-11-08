/**
 * Timeline (PAR-8315): one lane per track, a ruler and the playhead. Click a clip to select it, click empty space or
 * the ruler to move the playhead, drag a video/overlay/audio clip's edge to trim it, Delete (key or button) removes the
 * selected clip. Each gesture sends exactly one `video-edit-apply-ops` batch through the store; the lanes always draw
 * the doc the server returned (a drag only previews locally until that answer arrives). No snapping in v1.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from "react";
import type { Clip, TrackKind } from "../../video-edit/timeline.js";
import { clipCount, type EditorStore } from "./editor-store.js";
import { clipEnd, clipLabel, clipUnderPlayhead, docLength, fitScale, formatTime, hitTest, isTrimmable, pxToSeconds, secondsToPx, tickStep, trimResult, type TrimEdge } from "./timeline-view.js";

const LABEL_W = 104;
const LANE_H = 40;
const RULER_H = 22;
const EDGE_PX = 8;
const KIND_COLOR: Record<TrackKind, string> = { video: "#3b6fd9", overlay: "#7a4fd1", text: "#c2782a", caption: "#2f9a6b", audio: "#2a8fa8" };

interface Drag { clipId: string; edge: TrimEdge; originX: number; pointerId: number; delta: number }

const ellipsis = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 } as const;

export function Timeline({ store }: { store: EditorStore }) {
  const { doc, playhead, selectedClipId, busy } = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [drag, setDrag] = useState<Drag | null>(null);
  // The live drag also sits in a ref, so pointerup and pointercancel can't both send it: whoever clears it first wins.
  const dragRef = useRef<Drag | null>(null);
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
  const preview = drag && dragClip ? trimResult(dragClip, drag.edge, drag.delta) : null;

  const secondsAt = (e: PointerEvent<HTMLElement>) => pxToSeconds(e.clientX - e.currentTarget.getBoundingClientRect().left, pps);
  const movePlayhead = (e: PointerEvent<HTMLElement>) => store.setPlayhead(Math.min(Math.max(0, secondsAt(e)), duration));

  function onLaneDown(clips: Clip[], e: PointerEvent<HTMLDivElement>) {
    if (busy || dragRef.current || e.button !== 0) return;
    const hit = hitTest(clips, secondsAt(e), pps, EDGE_PX);
    if (!hit) {
      store.selectClip(null);
      movePlayhead(e);
      return;
    }
    store.selectClip(hit.clipId);
    if (hit.part === "body") return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setLiveDrag({ clipId: hit.clipId, edge: hit.part, originX: e.clientX, pointerId: e.pointerId, delta: 0 });
  }
  function onLaneMove(e: PointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (d && d.pointerId === e.pointerId) setLiveDrag({ ...d, delta: (e.clientX - d.originX) / pps });
  }
  function onLaneUp(e: PointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    dragRef.current = null; // one gesture, one batch
    const clip = findClip(d.clipId);
    const result = clip ? trimResult(clip, d.edge, (e.clientX - d.originX) / pps) : null;
    if (!result) return setDrag(null);
    void store.applyOps(result.ops).finally(() => setDrag(null));
  }
  function onLaneCancel(e: PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === e.pointerId) setLiveDrag(null);
  }
  const deleteSelected = () => {
    if (selectedClipId && !busy) void store.applyOps([{ op: "delete", clipId: selectedClipId }]);
  };
  function onKey(e: KeyboardEvent<HTMLElement>) {
    if ((e.key === "Delete" || e.key === "Backspace") && selected) {
      e.preventDefault();
      deleteSelected();
    } else if (e.key === "Escape" && dragRef.current) setLiveDrag(null);
  }

  const canDelete = Boolean(selected) && !busy;
  return (
    <section aria-label="Timeline" data-editor-panel="timeline" tabIndex={0} onKeyDown={onKey} style={{ border: "1px solid #8884", borderRadius: 8, minWidth: 0, outline: "none" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid #8883", minWidth: 0 }}>
        <strong>Timeline</strong>
        <span style={{ opacity: 0.75 }} data-timeline-summary>{tracks.length} tracks · {clipCount(doc)} clips · {formatTime(duration)}</span>
        <span style={{ ...ellipsis, flex: "1 1 160px", opacity: 0.75 }} data-timeline-playhead>
          Playhead {formatTime(playhead)}{atPlayhead ? ` · ${clipLabel(atPlayhead.clip)}` : ""}
        </span>
        <button type="button" onClick={deleteSelected} disabled={!canDelete} title={selected ? `Delete ${clipLabel(selected)}` : "Select a clip first"} style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #8886", background: "transparent", color: "inherit", cursor: canDelete ? "pointer" : "default", opacity: canDelete ? 1 : 0.5 }}>
          Delete clip
        </button>
      </div>
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
                  <div onPointerDown={(e) => onLaneDown(clips, e)} onPointerMove={onLaneMove} onPointerUp={onLaneUp} onPointerCancel={onLaneCancel} style={{ position: "relative", width: laneW, touchAction: "pan-y" }}>
                    {clips.map((clip) => {
                      const box = preview && drag?.clipId === clip.id ? preview : { start: clip.start, end: clipEnd(clip) };
                      const isSel = clip.id === selectedClipId;
                      const label = clipLabel(clip);
                      const handle = isTrimmable(clip) ? <span aria-hidden style={{ width: 6, alignSelf: "stretch", flex: "none", background: "#0004", cursor: "ew-resize" }} /> : null;
                      return (
                        <div key={clip.id} data-clip={clip.id} data-selected={isSel || undefined} title={`${label} · ${formatTime(box.start)}–${formatTime(box.end)}`}
                          style={{ position: "absolute", top: 4, bottom: 4, left: secondsToPx(box.start, pps), width: Math.max(2, secondsToPx(box.end - box.start, pps)), boxSizing: "border-box", borderRadius: 4, background: KIND_COLOR[track.kind], color: "#fff", border: isSel ? "2px solid #ffd54a" : "1px solid #0003", cursor: "pointer", overflow: "hidden", display: "flex", alignItems: "center" }}>
                          {handle}
                          <span style={{ ...ellipsis, flex: 1, padding: "0 4px", fontSize: 12 }}>{label}</span>
                          {handle}
                        </div>
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
    </section>
  );
}
