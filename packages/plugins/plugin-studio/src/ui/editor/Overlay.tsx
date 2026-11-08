/**
 * Text overlay (PAR-8320): draws the text clips showing at the playhead over the player, placed the way the render's
 * drawtext places them (centred, then offset by transform x/y in output pixels; size = fontSize x scale, against the
 * project's height). Text is plain React text, never HTML. The font is the render's own TTF, loaded in the browser
 * from the plugin's served fonts (B12; ../fonts.ts).
 */
import { useSyncExternalStore } from "react";
import type { EditDoc } from "../../video-edit/timeline.js";
import type { EditorStore } from "./editor-store.js";
import { captionStyle, STYLE_LOOK, visibleCaptions, captionClips } from "./caption-timing.js";
import { useStudioFonts } from "../fonts.js";
import { overlayStyle, textClips, visibleText } from "./text-track.js";

export function Overlay({ store }: { store: EditorStore }) {
  const { doc, playhead } = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  return <OverlayView doc={doc} playhead={playhead} />;
}

export function OverlayView({ doc, playhead }: { doc: EditDoc | null; playhead: number }) {
  useStudioFonts();
  if (!doc || (!textClips(doc).length && !captionClips(doc).length)) return null;
  const { width, height } = doc.project;
  const shown = visibleText(doc, playhead);
  const captions = visibleCaptions(doc, playhead);
  return (
    <div data-text-overlay aria-hidden={shown.length || captions.length ? undefined : true} style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none", containerType: "size" }}>
      {shown.map(({ clip, opacity }) => (
        <div
          key={clip.id}
          data-overlay-clip={clip.id}
          style={overlayStyle(clip, { width, height }, opacity)}
        >
          {clip.text}
        </div>
      ))}
      {captions.map(({ clip, words }) => (
        <div key={clip.id} data-overlay-caption={clip.id} data-caption-style={clip.style} style={captionStyle(clip.style, { width, height })}>
          {words.map((w, i) => (
            <span key={i} data-word-active={w.active ? "" : undefined} style={{ color: w.spoken ? STYLE_LOOK[clip.style].spoken : STYLE_LOOK[clip.style].unspoken }}>{i ? " " : ""}{w.text}</span>
          ))}
        </div>
      ))}
    </div>
  );
}
