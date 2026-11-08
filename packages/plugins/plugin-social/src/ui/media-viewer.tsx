import { useEffect, useState } from "react";
import { useEscapeToClose } from "@partnersinbiz/pib-plugin-ui";

export interface ViewerItem {
  url: string;
  kind: string;
  name?: string;
  altText?: string | null;
}

const navButton = {
  width: 44,
  height: 44,
  flexShrink: 0,
  borderRadius: 999,
  border: "1px solid rgba(255,255,255,.3)",
  background: "rgba(0,0,0,.5)",
  color: "#fff",
  fontSize: 20,
  cursor: "pointer",
} as const;

/** Images and videos at full size. Render it next to a Sheet or Modal, not inside one: it sits above both. */
export function MediaViewer({ items, start, onClose }: { items: ViewerItem[]; start: number; onClose: () => void }) {
  const [index, setIndex] = useState(start);
  const count = items.length;
  const item = items[index];
  const step = (by: number) => setIndex((i) => (i + by + count) % count);
  useEscapeToClose(true, onClose);
  useEffect(() => {
    if (count < 2) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") step(-1);
      if (event.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [count]);
  if (!item) return null;
  const caption = item.altText ?? item.name;
  const media = { maxWidth: "100%", maxHeight: "calc(100dvh - 130px)", borderRadius: 8, display: "block", minWidth: 0 } as const;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={item.kind === "video" ? "Video" : "Image"}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{ position: "fixed", inset: 0, zIndex: 90, background: "rgba(0,0,0,.88)", display: "grid", gridTemplateRows: "auto minmax(0, 1fr) auto", gap: 8, padding: 12, color: "#fff" }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, fontSize: 13 }}>
        <span>{count > 1 ? `${index + 1} of ${count}` : ""}</span>
        <span style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <a href={item.url} target="_blank" rel="noreferrer" style={{ color: "#fff" }}>Open in new tab</a>
          <button type="button" aria-label="Close" onClick={onClose} style={{ ...navButton, width: 36, height: 36, fontSize: 16 }}>✕</button>
        </span>
      </div>
      <div
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
        style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, minHeight: 0, minWidth: 0 }}
      >
        {count > 1 ? <button type="button" aria-label="Previous" onClick={() => step(-1)} style={navButton}>‹</button> : null}
        {item.kind === "video" ? (
          <video key={item.url} src={item.url} controls autoPlay playsInline style={media} />
        ) : (
          <img key={item.url} src={item.url} alt={item.altText ?? ""} style={{ ...media, objectFit: "contain" }} />
        )}
        {count > 1 ? <button type="button" aria-label="Next" onClick={() => step(1)} style={navButton}>›</button> : null}
      </div>
      {caption ? <div style={{ fontSize: 12, lineHeight: 1.4, maxHeight: 54, overflow: "auto", textAlign: "center", opacity: 0.85 }}>{caption}</div> : <span />}
    </div>
  );
}
