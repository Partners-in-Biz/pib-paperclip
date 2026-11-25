/**
 * Studio's card on a Planning Canvas board (PAR-14280; plan PAR-14257 B.2 D): the `canvasNode` slot for an embed node
 * `{ plugin: "partnersinbiz.studio", type: "studio-media", assetId }`. Each draw asks Studio for the file's state and a
 * signed link with the board's scope (board-sign.ts); a file of other work than the board's, a restricted member's
 * client media and a person without Studio all get the same placeholder. Text from the node is drawn as text only.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { PluginCanvasNodeProps } from "@paperclipai/plugin-sdk/ui";
import { tokens } from "@partnersinbiz/pib-plugin-ui";
import { useStudioAction } from "./action.js";
import { boardSigner, nextCheckIn, RETRY_MS, type CardState } from "./board-sign.js";
import { posterFrameUrl } from "./library.js";

const frame: CSSProperties = { position: "relative", height: "100%", width: "100%", minWidth: 0, overflow: "hidden", borderRadius: 12, background: tokens.card, color: tokens.fg };
const note: CSSProperties = { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, height: "100%", padding: 12, textAlign: "center", fontSize: 12, color: tokens.muted, border: `1px dashed ${tokens.border}`, borderRadius: 12, overflowWrap: "anywhere" };
const caption: CSSProperties = { position: "absolute", left: 0, right: 0, bottom: 0, padding: "4px 8px", fontSize: 12, color: tokens.fg, background: `color-mix(in oklab, ${tokens.card} 85%, transparent)`, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };

/** The card for one state. Exported for the render harness and tests. */
export function BoardCardView({ state, onMediaError }: { state: CardState; onMediaError?: () => void }) {
  let body: ReactNode;
  switch (state.state) {
    case "ready":
      body = (
        <>
          {state.kind === "video" ? (
            <video src={posterFrameUrl(state.url)} controls muted playsInline preload="metadata" onError={onMediaError} style={{ display: "block", width: "100%", height: "100%", objectFit: "cover", background: tokens.bg }} aria-label={state.altText || state.name} />
          ) : (
            <img src={state.url} alt={state.altText || state.name} loading="lazy" decoding="async" draggable={false} onError={onMediaError} style={{ display: "block", width: "100%", height: "100%", objectFit: "cover" }} />
          )}
          {state.name ? <div style={caption} title={state.name}>{state.name}</div> : null}
        </>
      );
      break;
    case "removed":
      body = <Note title="Removed" line="This Studio file was removed." />;
      break;
    case "refused":
      body = <Note title="Studio media" line="Not shown on this board." />;
      break;
    case "off":
      body = <Note title="Studio media" line="Studio cards are switched off." />;
      break;
    case "error":
      body = <Note title="Studio media" line="Couldn't load. Trying again…" />;
      break;
    default:
      body = <Note title="Studio media" line="Loading…" />;
  }
  return (
    <div style={frame} data-studio-card={state.state}>
      {body}
    </div>
  );
}

function Note({ title, line }: { title: string; line: string }) {
  return (
    <div style={note}>
      <strong style={{ fontSize: 12, fontWeight: 600, color: tokens.fg }}>{title}</strong>
      <span>{line}</span>
    </div>
  );
}

export function StudioCanvasCard(props: PluginCanvasNodeProps) {
  const companyId = props.context?.companyId ?? null;
  const projectId = props.boardProjectId ?? null;
  const assetId = props.assetId;
  const call = useStudioAction("asset-urls");
  const [state, setState] = useState<CardState>({ state: "loading" });
  const [round, setRound] = useState(0);
  const lastErrorResign = useRef(0);

  // Ask on every draw, and again on each new round (expiry, retry, image error).
  useEffect(() => {
    if (!assetId || !companyId) {
      setState({ state: "removed" });
      return;
    }
    let live = true;
    void boardSigner.request(call, companyId, projectId, assetId, { fresh: round > 0 }).then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, [call, companyId, projectId, assetId, round]);

  // Re-sign before the link expires (300 s), or retry after a failure.
  useEffect(() => {
    const ms = nextCheckIn(state, Date.now());
    if (ms === null) return;
    const timer = setTimeout(() => setRound((r) => r + 1), ms);
    return () => clearTimeout(timer);
  }, [state]);

  // An image error re-signs once; a second error within RETRY_MS waits for the retry.
  const onMediaError = () => {
    if (!assetId || !companyId) return;
    boardSigner.forget(companyId, projectId, assetId);
    const now = Date.now();
    if (now - lastErrorResign.current >= RETRY_MS) {
      lastErrorResign.current = now;
      setRound((r) => r + 1);
    } else setState({ state: "error", retryAt: now + RETRY_MS });
  };

  return <BoardCardView state={state} onMediaError={onMediaError} />;
}
