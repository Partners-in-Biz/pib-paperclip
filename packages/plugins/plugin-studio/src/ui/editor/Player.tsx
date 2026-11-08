/**
 * Preview player (PAR-8314): plays the video clip under the store's playhead from its signed preview URL (the same
 * links the Library uses; media never goes through RPC), with play/pause and a scrubber bound to the playhead.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useHostContext } from "@paperclipai/plugin-sdk/ui";
import { Button } from "@partnersinbiz/pib-plugin-ui";
import type { EditorStore } from "./editor-store.js";
import { clipAt, clipLength, timelineEnd, videoClips } from "./player-clips.js";
import { usePreviewUrls } from "../previews.js";

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function Player({ store }: { store: EditorStore }) {
  const host = useHostContext();
  const companyId = host.companyId ?? "";
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const { doc, playhead } = state;
  const clips = videoClips(doc);
  const end = timelineEnd(doc);
  const clip = clipAt(doc, playhead);
  const previews = usePreviewUrls(companyId, [...new Set(clips.map((c) => c.assetId))]);
  const url = clip ? previews.urls[clip.assetId] : undefined;
  const ref = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const aspect = doc ? `${doc.project.width} / ${doc.project.height}` : "16 / 9";

  // Follow the playhead: when it moves away from where the video is, seek the video.
  useEffect(() => {
    const v = ref.current;
    if (!v || !clip) return;
    const want = clip.in + (playhead - clip.start) * (clip.speed || 1);
    if (Math.abs(v.currentTime - want) > 0.25) v.currentTime = want;
    v.playbackRate = clip.speed || 1;
  }, [clip?.id, clip?.in, clip?.start, clip?.speed, playhead, url]);

  // Playing: the video drives the playhead; at the clip's end, hand over to the next clip or stop.
  const onTime = () => {
    const v = ref.current;
    if (!v || !clip || v.paused) return;
    const t = clip.start + (v.currentTime - clip.in) / (clip.speed || 1);
    if (t >= clip.start + clipLength(clip) - 0.02) {
      const next = clips.find((c) => c.start >= clip.start + clipLength(clip) - 0.001 && c.id !== clip.id);
      if (next) store.setPlayhead(next.start);
      else {
        v.pause();
        setPlaying(false);
        store.setPlayhead(Math.max(0, end - 0.001));
      }
      return;
    }
    store.setPlayhead(t);
  };

  const toggle = () => {
    const v = ref.current;
    if (playing) {
      v?.pause();
      setPlaying(false);
      return;
    }
    if (end > 0 && playhead >= end - 0.01) store.setPlayhead(0);
    setPlaying(true);
    void v?.play().catch(() => setPlaying(false));
  };
  // A clip change while playing keeps playing.
  useEffect(() => {
    if (playing) void ref.current?.play().catch(() => setPlaying(false));
  }, [clip?.id, url, playing]);

  return (
    <section aria-label="Player" data-editor-panel="player" style={{ display: "grid", gap: 8, minWidth: 0 }}>
      <div style={{ width: "100%", maxWidth: 480, maxHeight: "60vh", aspectRatio: aspect, margin: "0 auto", borderRadius: 8, overflow: "hidden", background: "rgba(127,127,127,0.12)", display: "grid", placeItems: "center", minWidth: 0 }}>
        {clip && url ? (
          <video ref={ref} src={url} muted={false} playsInline preload="auto" onTimeUpdate={onTime} onPause={() => setPlaying(false)} onPlay={() => setPlaying(true)} style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }} />
        ) : (
          <div style={{ padding: 12, textAlign: "center", opacity: 0.7 }}>
            {clips.length === 0 ? "Nothing to play yet." : clip ? (previews.error ?? "Loading the video…") : "No video at this point."}
          </div>
        )}
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
