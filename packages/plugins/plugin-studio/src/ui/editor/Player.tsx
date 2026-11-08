/**
 * Preview player (PAR-8314, multi-clip PAR-8319): plays the edit live from the clips' signed preview URLs (the same
 * links the Library uses; media never goes through RPC). `preview-plan.ts` says what shows at the playhead. Two
 * `<video>` slots take turns: one shows the current clip (playbackRate = speed, volume and fades applied) while the
 * other preloads the next clip at its in point, so a hand-over is a swap, not a load. A gap shows black. While playing,
 * a clock drives the playhead (so gaps play too); the showing video is re-seeked only when it drifts.
 */
import { useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { useHostContext } from "@paperclipai/plugin-sdk/ui";
import { Button } from "@partnersinbiz/pib-plugin-ui";
import type { EditorStore } from "./editor-store.js";
import { assignSlots, buildPreviewPlan, frameAt, type PreviewSlots } from "./preview-plan.js";
import { usePreviewUrls } from "../previews.js";
import { Overlay } from "./Overlay.js";
import { audioClips, audioFrameAt, audioMute, audioWindow } from "./audio-track.js";

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
/** Seconds the playing video may drift from the clock before it is re-seeked. */
const DRIFT = 0.3;
/** Seconds a paused video may be off its frame before it is re-seeked. */
const STILL = 0.04;
/** A playhead jump this big while playing is a scrub: the clock restarts from it. */
const SCRUB = 0.05;

export function Player({ store }: { store: EditorStore }) {
  const host = useHostContext();
  const companyId = host.companyId ?? "";
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const { doc, playhead } = state;
  const plan = useMemo(() => buildPreviewPlan(doc), [doc]);
  const byId = useMemo(() => new Map(plan.segments.map((s) => [s.clipId, s])), [plan]);
  const end = plan.end;
  const frame = frameAt(plan, playhead);
  // Audio clips near the playhead get an <audio> element (PAR-8322); their assets' links load with the video's.
  const audioNear = audioWindow(doc, playhead);
  const allAudio = useMemo(() => audioClips(doc), [doc]);
  const previews = usePreviewUrls(companyId, [...new Set([...plan.segments.map((s) => s.assetId), ...allAudio.map((a) => a.clip.assetId)])]);
  useSyncExternalStore(audioMute.subscribe, audioMute.getSnapshot, audioMute.getSnapshot);
  const [playing, setPlaying] = useState(false);
  const aspect = doc ? `${doc.project.width} / ${doc.project.height}` : "16 / 9";

  const videos = useRef<[HTMLVideoElement | null, HTMLVideoElement | null]>([null, null]);
  const slotRef = useRef<PreviewSlots>({ slots: [null, null], active: 0 });
  // assignSlots is idempotent, so a repeated render (StrictMode) lands on the same slots.
  slotRef.current = assignSlots(slotRef.current, frame.segment, frame.next);
  const { slots, active } = slotRef.current;
  const live = useRef({ plan, error: previews.error });
  live.current = { plan, error: previews.error };

  // A slot's new src resets its position when the load starts, so seeks wait for metadata; this re-syncs then.
  const [, resync] = useReducer((n: number) => n + 1, 0);

  // After every render: the showing slot plays (or holds) its frame; the other is paused and muted on its clip's in point.
  useEffect(() => {
    for (const i of [0, 1] as const) {
      const v = videos.current[i];
      const seg = slots[i] ? byId.get(slots[i]!) : undefined;
      if (!v || !seg) continue;
      if (v.playbackRate !== seg.speed) v.playbackRate = seg.speed;
      const ready = v.readyState >= 1 && !v.seeking;
      if (i === active && frame.segment?.clipId === seg.clipId) {
        v.muted = false;
        v.volume = frame.volume;
        if (ready && Math.abs(v.currentTime - frame.sourceTime) > (playing ? DRIFT : STILL)) v.currentTime = frame.sourceTime;
        if (playing && v.paused) void v.play().catch(() => undefined);
        if (!playing && !v.paused) v.pause();
      } else {
        v.muted = true;
        if (!v.paused) v.pause();
        if (ready && Math.abs(v.currentTime - seg.in) > STILL) v.currentTime = seg.in;
      }
    }
  });

  // Audio clips: the one(s) under the playhead play (volume and fades applied, track mute honoured); the rest wait.
  const audios = useRef(new Map<string, HTMLAudioElement>());
  useEffect(() => {
    for (const { trackId, clip } of audioNear) {
      const a = audios.current.get(clip.id);
      if (!a) continue;
      const f = audioFrameAt(clip, playhead);
      if (a.playbackRate !== clip.speed) a.playbackRate = clip.speed;
      a.muted = !f || audioMute.isMuted(trackId);
      if (!f) {
        if (!a.paused) a.pause();
        continue;
      }
      a.volume = f.volume;
      const ready = a.readyState >= 1 && !a.seeking;
      if (ready && Math.abs(a.currentTime - f.sourceTime) > (playing ? DRIFT : STILL)) a.currentTime = f.sourceTime;
      if (playing && a.paused) void a.play().catch(() => undefined);
      if (!playing && !a.paused) a.pause();
    }
  });

  // Playing: a clock moves the playhead. It holds while the showing video buffers and follows a scrub made mid-play.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let base = store.getState().playhead;
    let at = performance.now();
    let last = base;
    const tick = (now: number) => {
      const { plan: p, error } = live.current;
      const current = store.getState().playhead;
      const f = frameAt(p, current);
      const v = f.segment ? videos.current[slotRef.current.active] : null;
      const buffering = !!f.segment && !error && (!v || (!v.error && (v.seeking || v.readyState < 3)));
      if (buffering || Math.abs(current - last) > SCRUB) {
        base = current;
        at = now;
      }
      const t = base + (now - at) / 1000;
      if (t >= p.end) {
        store.setPlayhead(Math.max(0, p.end - 0.001));
        setPlaying(false);
        return;
      }
      last = t;
      store.setPlayhead(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, store]);

  const toggle = () => {
    if (playing) {
      setPlaying(false);
      return;
    }
    const restart = end > 0 && playhead >= end - 0.01;
    if (restart) store.setPlayhead(0);
    // Start the showing video inside the click, so the browser lets it play with sound.
    const v = videos.current[active];
    if (!restart && frame.segment && v) void v.play().catch(() => undefined);
    setPlaying(true);
  };

  const urlOf = (i: 0 | 1) => {
    const seg = slots[i] ? byId.get(slots[i]!) : undefined;
    return seg ? previews.urls[seg.assetId] : undefined;
  };
  const hasClips = plan.segments.length > 0;
  const message = !hasClips ? "Nothing to play yet." : frame.segment && !previews.urls[frame.segment.assetId] ? (previews.error ?? "Loading the video…") : null;

  return (
    <section aria-label="Player" data-editor-panel="player" data-preview-clip={frame.segment?.clipId ?? frame.kind} style={{ display: "grid", gap: 8, minWidth: 0 }}>
      <div style={{ position: "relative", width: "100%", maxWidth: 480, maxHeight: "60vh", aspectRatio: aspect, margin: "0 auto", borderRadius: 8, overflow: "hidden", background: hasClips ? "black" : "rgba(127,127,127,0.12)", display: "grid", placeItems: "center", minWidth: 0 }}>
        {([0, 1] as const).map((i) => {
          const src = urlOf(i);
          const showing = i === active && !!frame.segment && slots[i] === frame.segment.clipId;
          return src ? (
            <video
              key={i}
              ref={(el) => {
                videos.current[i] = el;
              }}
              src={src}
              data-preview-slot={i}
              data-clip-id={slots[i] ?? ""}
              data-showing={showing ? "true" : "false"}
              playsInline
              muted={!showing}
              preload="auto"
              onLoadedMetadata={resync}
              onSeeked={resync}
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", display: "block", opacity: showing ? frame.opacity : 0 }}
            />
          ) : null;
        })}
        {audioNear.map(({ clip }) => {
          const src = previews.urls[clip.assetId];
          return src ? (
            <audio key={clip.id} ref={(el) => { if (el) audios.current.set(clip.id, el); else audios.current.delete(clip.id); }} src={src} data-audio-clip={clip.id} preload="auto" onLoadedMetadata={resync} />
          ) : null;
        })}
        <Overlay store={store} />
        {message ? <div style={{ position: "relative", padding: 12, textAlign: "center", opacity: 0.7, color: hasClips ? "white" : undefined }}>{message}</div> : null}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <Button onClick={toggle} disabled={end <= 0}>{playing ? "Pause" : "Play"}</Button>
        <input
          type="range"
          aria-label="Playhead"
          min={0}
          max={end || 0}
          step={0.01}
          value={Math.min(playhead, end || 0)}
          disabled={end <= 0}
          onChange={(e) => store.setPlayhead(Number(e.target.value))}
          style={{ flex: "1 1 auto", minWidth: 0 }}
        />
        <span style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{fmt(playhead)} / {fmt(end)}</span>
      </div>
    </section>
  );
}
