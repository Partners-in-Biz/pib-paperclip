/**
 * Studio's library panel on a Planning Canvas board (PAR-14280; plan PAR-14257 B.2 D): the `canvasPanel` slot. It
 * lists only the files that pass the board's scope ("board-library") and places one as an embed node through the
 * host's `applyOps`, which runs as the viewer, so the board's own access check decides the edit.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { PluginCanvasPanelProps } from "@paperclipai/plugin-sdk/ui";
import { errorText, tokens } from "@partnersinbiz/pib-plugin-ui";
import { STUDIO_MEDIA_CARD, STUDIO_PLUGIN_KEY } from "../plugin-key.js";
import { useStudioAction } from "./action.js";
import { BoardCardView } from "./BoardCard.js";
import { boardSigner, embedNodeOp, libraryLoadFromError, placeAt, RESIGN_MARGIN_MS, SIGNED_FOR_MS, type BoardLibraryItem, type BoardLibraryReply, type CardState, type LibraryLoad } from "./board-sign.js";

const panel: CSSProperties = { display: "flex", flexDirection: "column", gap: 10, padding: 12, minWidth: 0, color: tokens.fg, fontSize: 13 };
const muted: CSSProperties = { fontSize: 12, color: tokens.muted, overflowWrap: "anywhere" };
const grid: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 };
const tile: CSSProperties = { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 };
const button: CSSProperties = { width: "100%", minWidth: 0, padding: "4px 6px", fontSize: 12, borderRadius: 8, border: `1px solid ${tokens.border}`, background: tokens.secondary, color: tokens.secondaryFg, cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };

/** The panel for one load state. Exported for the render harness. */
export function BoardLibraryView({ load, canEdit, thumbs, placing, message, onPlace }: {
  load: LibraryLoad;
  canEdit: boolean;
  thumbs: Record<string, CardState>;
  placing: string | null;
  message: string | null;
  onPlace: (item: BoardLibraryItem) => void;
}) {
  let body;
  if (load.status === "loading") body = <p style={muted}>Loading Studio files…</p>;
  else if (load.status === "off") body = <p style={muted}>Studio cards are switched off in Studio's settings.</p>;
  else if (load.status === "error") body = <p style={muted}>{load.message}</p>;
  else if (load.reply.withheld) body = <p style={muted}>Client media from Studio isn't shown to you on this board.</p>;
  else if (!load.reply.assets.length) body = <p style={muted}>No Studio images or videos for this board's work yet.</p>;
  else {
    body = (
      <div style={grid}>
        {load.reply.assets.map((item) => (
          <div key={item.id} style={tile} data-studio-library-item={item.id}>
            <div style={{ aspectRatio: "4 / 3", minWidth: 0 }}>
              <BoardCardView state={thumbs[item.id] ?? { state: "loading" }} />
            </div>
            <button type="button" style={{ ...button, opacity: canEdit ? 1 : 0.5 }} disabled={!canEdit || placing !== null} onClick={() => onPlace(item)} aria-label={`Place ${item.name} on the board`} title={canEdit ? `Place ${item.name} on the board` : "You can view this board but not edit it."}>
              {placing === item.id ? "Placing…" : "Place on board"}
            </button>
          </div>
        ))}
      </div>
    );
  }
  const scopeLine = load.status !== "ready" ? null : load.reply.withheld ? "Client work" : load.reply.board.kind === "client" ? `${load.reply.board.name ?? "Client"}'s files` : "Own work";
  return (
    <section aria-label="Studio library" style={panel}>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <strong style={{ fontSize: 13, fontWeight: 600 }}>Studio library</strong>
        {scopeLine ? <span style={{ ...muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={scopeLine}>{scopeLine}</span> : null}
      </div>
      {message ? <p role="status" style={muted}>{message}</p> : null}
      {body}
    </section>
  );
}

function StudioBoardLibraryBody(props: PluginCanvasPanelProps) {
  const companyId = props.context?.companyId ?? null;
  const projectId = props.boardProjectId ?? null;
  const list = useStudioAction("board-library");
  const urls = useStudioAction("asset-urls");
  const [load, setLoad] = useState<LibraryLoad>({ status: "loading" });
  const [thumbs, setThumbs] = useState<Record<string, CardState>>({});
  const [placing, setPlacing] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const placed = useRef(0);

  useEffect(() => {
    if (!companyId || !props.boardId) return;
    let live = true;
    let renew: ReturnType<typeof setInterval> | undefined;
    setLoad({ status: "loading" });
    list({ companyId, boardScope: { projectId } })
      .then((out) => {
        if (!live) return;
        const reply = out as BoardLibraryReply;
        setLoad({ status: "ready", reply });
        const sign = (fresh: boolean) => {
          for (const item of reply.assets) {
            void boardSigner.request(urls, companyId, projectId, item.id, { fresh }).then((state) => {
              if (live) setThumbs((prev) => ({ ...prev, [item.id]: state }));
            });
          }
        };
        sign(false);
        // Thumbnails are signed links too: renew them before they expire.
        renew = setInterval(() => sign(true), SIGNED_FOR_MS - RESIGN_MARGIN_MS);
      })
      .catch((error: unknown) => {
        if (!live) return;
        setLoad(libraryLoadFromError(error));
      });
    return () => {
      live = false;
      if (renew) clearInterval(renew);
    };
  }, [list, urls, companyId, projectId, props.boardId]);

  const onPlace = useCallback(
    (item: BoardLibraryItem) => {
      setPlacing(item.id);
      setMessage(null);
      const op = embedNodeOp({ pluginKey: STUDIO_PLUGIN_KEY, type: STUDIO_MEDIA_CARD, assetId: item.id, name: item.name, kind: item.kind, at: placeAt(placed.current) });
      props
        .applyOps([op])
        .then((out) => {
          const result = (out as { results?: Array<{ status?: string; reason?: string }> } | null)?.results?.[0];
          if (result && result.status !== "applied") setMessage(`The board refused the card (${result.reason ?? result.status}).`);
          else {
            placed.current += 1;
            setMessage(`Placed ${item.name} on the board.`);
          }
        })
        .catch((error: unknown) => setMessage(`The card wasn't placed: ${errorText(error)}`))
        .finally(() => setPlacing(null));
    },
    [props.applyOps],
  );

  return <BoardLibraryView load={load} canEdit={props.accessLevel === "edit"} thumbs={thumbs} placing={placing} message={message} onPlace={onPlace} />;
}

export const StudioBoardLibrary = StudioBoardLibraryBody;
