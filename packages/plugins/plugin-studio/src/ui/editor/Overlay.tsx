/**
 * Text overlay (PAR-8320): draws the text clips showing at the playhead over the player, placed the way the render's
 * drawtext places them (centred, then offset by transform x/y in output pixels; size = fontSize x scale, against the
 * project's height). Text is plain React text, never HTML. The browser draws a generic font of the same kind; the exact
 * TTF is a later ticket (B12), so the overlay says so.
 */
import { useSyncExternalStore } from "react";
import type { EditDoc } from "../../video-edit/timeline.js";
import type { EditorStore } from "./editor-store.js";
import { overlayStyle, PREVIEW_NOTE, textClips, visibleText } from "./text-track.js";

export function Overlay({ store }: { store: EditorStore }) {
  const { doc, playhead } = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  return <OverlayView doc={doc} playhead={playhead} />;
}

export function OverlayView({ doc, playhead }: { doc: EditDoc | null; playhead: number }) {
  if (!doc || !textClips(doc).length) return null;
  const { width, height } = doc.project;
  const shown = visibleText(doc, playhead);
  return (
    <div data-text-overlay aria-hidden={shown.length ? undefined : true} style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none", containerType: "size" }}>
      {shown.map(({ clip, opacity }) => (
        <div
          key={clip.id}
          data-overlay-clip={clip.id}
          style={overlayStyle(clip, { width, height }, opacity)}
        >
          {clip.text}
        </div>
      ))}
      <span data-overlay-note style={{ position: "absolute", left: 6, bottom: 6, padding: "1px 6px", borderRadius: 4, background: "#000a", color: "#fff", fontSize: 11 }}>{PREVIEW_NOTE}</span>
    </div>
  );
}
