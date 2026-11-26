import { memo, useEffect, useRef, useState } from "react";
import { ExternalLink, Globe, Play } from "lucide-react";
import { isPlanningCanvasWebLinkUrl, parseYouTubeUrl, type PlanningCanvasWebLinkData } from "@paperclipai/shared";
import { RefCard } from "@/components/planning-canvas/nodes/RefCard";

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

/**
 * The only frame URL a web link card can load: rebuilt from the stored `url` on every render
 * (PAR-14389 C.5). `parseYouTubeUrl` returns an 11-character id or null; nothing else of the
 * stored text reaches the frame. No site-wide policy backs this (Risk 6), so this is the defence.
 */
export function youTubeEmbedSrc(url: string): string | null {
  const id = parseYouTubeUrl(url);
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null;
}

/** The real host of a stored url, or null when the url is not one a card may hold. */
export function webLinkHost(url: string): string | null {
  if (!isPlanningCanvasWebLinkUrl(url)) return null;
  return new URL(url).hostname;
}

function previewText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** False once the card has scrolled or panned out of the window; the player is then removed. */
function useInView(ref: React.RefObject<HTMLElement | null>, active: boolean, onLeave: () => void) {
  const leave = useRef(onLeave);
  leave.current = onLeave;
  useEffect(() => {
    const el = ref.current;
    if (!active || !el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => !entry.isIntersecting)) leave.current();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, active]);
}

function OpenLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onPointerDown={stop}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground hover:bg-accent"
    >
      <ExternalLink className="size-3" />
      Open
    </a>
  );
}

/**
 * A web link card. Any editor or agent can write `url` and `preview` through the ops route, so
 * the card trusts neither: the host shown is always the host of `url`, preview text is drawn as
 * text below it, and a YouTube frame loads only after a click, from the rebuilt nocookie URL.
 */
export const WebLinkNode = memo(function WebLinkNode({ data }: { data: PlanningCanvasWebLinkData }) {
  const host = webLinkHost(data.url);
  const embedSrc = host ? youTubeEmbedSrc(data.url) : null;
  const [playing, setPlaying] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  useInView(boxRef, playing && !!embedSrc, () => setPlaying(false));

  if (!host) {
    return (
      <RefCard label="Web link" icon={<Globe className="size-3.5" />}>
        <p className="text-sm text-muted-foreground">This link can't be shown</p>
      </RefCard>
    );
  }
  const title = previewText(data.preview?.title);
  const description = previewText(data.preview?.description);

  return (
    <RefCard label={embedSrc ? "YouTube" : "Web link"} icon={embedSrc ? <Play className="size-3.5" /> : <Globe className="size-3.5" />}>
      <div className="flex min-w-0 items-center gap-2" data-weblink-host={host}>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground" title={host}>
          {host}
        </span>
        <OpenLink url={data.url} />
      </div>
      {embedSrc ? (
        <div ref={boxRef} className="relative min-h-0 flex-1 overflow-hidden rounded-lg bg-muted">
          {playing ? (
            <iframe
              title={title ? `YouTube video: ${title}` : "YouTube video"}
              src={embedSrc}
              sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
              allow="encrypted-media; picture-in-picture; fullscreen"
              referrerPolicy="strict-origin-when-cross-origin"
              loading="lazy"
              className="absolute inset-0 size-full border-0"
            />
          ) : (
            <button
              type="button"
              onPointerDown={stop}
              onClick={() => setPlaying(true)}
              className="flex size-full flex-col items-center justify-center gap-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Play className="size-6" />
              <span className="text-xs font-medium">Play video</span>
            </button>
          )}
        </div>
      ) : (
        <p className="truncate text-xs text-muted-foreground" title={data.url}>
          {data.url}
        </p>
      )}
      {title ? <p className="line-clamp-2 text-sm font-medium text-foreground">{title}</p> : null}
      {description && !embedSrc ? <p className="line-clamp-3 text-xs text-muted-foreground">{description}</p> : null}
    </RefCard>
  );
});
