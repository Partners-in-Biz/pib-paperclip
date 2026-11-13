/**
 * Chroma key in the preview (PAR-8279 slice 3, D3d2): a `<canvas>` that draws the overlay clip's `<video>` through the
 * WebGL key of `chroma-gl.ts` (the `chroma.ts` formula the render compiles), on every new frame. The overlay keeps its
 * `<video>` for playback and sync but hides it; the canvas takes the video's place and style (grade filter, rounded
 * corners). Without WebGL (or when the context is lost) it reports "none": the caller shows the clip unkeyed with
 * `NoKeyLabel`.
 */
import { useEffect, useRef, type CSSProperties } from "react";
import type { ChromaKey } from "../../video-edit/timeline.js";
import { chromaUniforms, createChromaGl, NO_KEY_LABEL } from "./chroma-gl.js";

export type ChromaStatus = "gl" | "none";

export function ChromaLayer({ chromaKey, video, style, onStatus }: { chromaKey: ChromaKey; video: HTMLVideoElement | null; style: CSSProperties; onStatus: (s: ChromaStatus) => void }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const uniforms = useRef(chromaUniforms(chromaKey));
  uniforms.current = chromaUniforms(chromaKey);
  const status = useRef(onStatus);
  status.current = onStatus;
  useEffect(() => {
    const el = canvas.current;
    if (!el || !video) return;
    const gl = createChromaGl(el, uniforms.current);
    if (!gl) {
      status.current("none");
      return;
    }
    status.current("gl");
    // Draw when the frame may have changed: every animation frame while playing, else when time, seek or size moves.
    let last = "", raf = 0;
    const tick = () => {
      const at = `${video.currentTime}|${video.seeking}|${video.readyState}|${video.videoWidth}|${JSON.stringify(uniforms.current)}`;
      if ((!video.paused || at !== last) && !video.seeking && gl.draw(video, el, uniforms.current)) last = at;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const lost = (e: Event) => {
      e.preventDefault();
      status.current("none");
    };
    el.addEventListener("webglcontextlost", lost);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("webglcontextlost", lost);
      gl.dispose();
    };
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
