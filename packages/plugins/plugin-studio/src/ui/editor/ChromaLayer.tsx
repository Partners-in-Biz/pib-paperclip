/**
 * Chroma key in the preview (PAR-8279 slice 3, D3d2): a `<canvas>` that draws the overlay clip's `<video>` through the
 * WebGL key of `chroma-gl.ts` (the `chroma.ts` formula the render compiles), on every new frame. The overlay keeps its
 * `<video>` for playback and sync but hides it; the canvas takes the video's place and style (grade filter, rounded
 * corners). The loop is `startChromaLoop`: without WebGL, on context loss, or when a draw throws (a cross-origin video
 * without CORS) it reports "none" and the caller shows the clip unkeyed with `NoKeyLabel`.
 */
import { useEffect, useRef, type CSSProperties } from "react";
import type { ChromaKey } from "../../video-edit/timeline.js";
import { chromaUniforms, NO_KEY_LABEL, startChromaLoop, type ChromaStatus } from "./chroma-gl.js";

export type { ChromaStatus };

export function ChromaLayer({ chromaKey, video, style, onStatus }: { chromaKey: ChromaKey; video: HTMLVideoElement | null; style: CSSProperties; onStatus: (s: ChromaStatus) => void }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const uniforms = useRef(chromaUniforms(chromaKey));
  uniforms.current = chromaUniforms(chromaKey);
  const status = useRef(onStatus);
  status.current = onStatus;
  useEffect(() => {
    const el = canvas.current;
    if (!el || !video) return;
    return startChromaLoop(el, video, () => uniforms.current, (s) => status.current(s));
  }, [video]);
  return <canvas ref={canvas} data-chroma-layer style={style} />;
}

/** The "preview without key" tag, drawn on top of the preview (outside the clip's blend group, so it stays legible). */
export function NoKeyLabel({ clipId }: { clipId: string }) {
  return (
    <div data-chroma-fallback={clipId} role="note" style={{ position: "absolute", left: 8, top: 8, zIndex: 50, padding: "2px 8px", borderRadius: 4, fontSize: 12, color: "white", background: "rgba(0,0,0,0.6)", pointerEvents: "none" }}>
      {NO_KEY_LABEL}
    </div>
  );
}
