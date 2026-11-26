/**
 * Studio's library panel on a Planning Canvas board (PAR-14280; plan PAR-14257 B.2 D): the `canvasPanel` slot. It
 * lists only the files that pass the board's scope ("board-library") and places one as an embed node through the
 * host's `applyOps`, which runs as the viewer, so the board's own access check decides the edit. When Studio's
 * "Generate on boards" switch is on, it also offers "Add generate card": one empty generate card (PAR-14817).
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { PluginCanvasPanelProps } from "@paperclipai/plugin-sdk/ui";
import { errorText, tokens } from "@partnersinbiz/pib-plugin-ui";
import { STUDIO_MEDIA_CARD, STUDIO_PLUGIN_KEY } from "../plugin-key.js";
import { useStudioAction } from "./action.js";
import { BoardCardView } from "./BoardCard.js";
import { readBoard } from "./BoardGenerateCard.js";
import { FromDrive } from "./FromDrive.js";
import { boardScopeOf, clientNotes, clientReplyFrom, confirmText, currentLink, driveClientOf, MISSING_VALUE, OWN_VALUE, pickerValue, readOnlyLine, setErrorText, showPicker, studioCardCount, type ClientLoad, type PendingChange } from "./board-client.js";
import { newGenerateCardOp } from "./board-generate.js";
import { boardSigner, embedNodeOp, libraryLoadFromError, placeAt, showGenerateEntry, RESIGN_MARGIN_MS, SIGNED_FOR_MS, type BoardLibraryItem, type BoardLibraryReply, type CardState, type LibraryLoad } from "./board-sign.js";

const panel: CSSProperties = { display: "flex", flexDirection: "column", gap: 10, padding: 12, minWidth: 0, color: tokens.fg, fontSize: 13 };
const muted: CSSProperties = { fontSize: 12, color: tokens.muted, overflowWrap: "anywhere" };
const grid: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 };
const tile: CSSProperties = { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 };
/** `placing` while "Add generate card" runs. */
export const GENERATE_PLACING = "__generate__";

const button: CSSProperties = { width: "100%", minWidth: 0, padding: "4px 6px", fontSize: 12, borderRadius: 8, border: `1px solid ${tokens.border}`, background: tokens.secondary, color: tokens.secondaryFg, cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };

const field: CSSProperties = { width: "100%", minWidth: 0, padding: "4px 6px", fontSize: 12, borderRadius: 8, border: `1px solid ${tokens.border}`, background: tokens.secondary, color: tokens.fg, textOverflow: "ellipsis" };
const ellipsis: CSSProperties = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };

/** The panel's Client header (PAR-14848; plan PAR-14835 Approach 6). Exported for the render harness. */
export function ClientHeader({ client, projectName, pending, busy, error, driveClient, companyId, onPick, onConfirm, onCancel, onRetry, onImported }: {
  client: ClientLoad;
  projectName: string | null;
  pending: PendingChange | null;
  busy: boolean;
  error: string | null;
  /** The effective client for From Drive ("own" for own work); null hides the button (viewers, missing client). */
  driveClient: string | null;
  companyId: string;
  onPick: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onImported: () => void;
}) {
  if (client.status === "loading") return <p style={muted}>Loading client…</p>;
  if (client.status === "error") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        <p role="status" style={muted}>{client.message}</p>
        <button type="button" style={button} onClick={onRetry}>Try again</button>
      </div>
    );
  }
  const { reply } = client;
  const notes = clientNotes(reply);
  const line = readOnlyLine(reply, projectName);
  const clients = reply.clients ?? [];
  const value = pickerValue(reply);
  return (
    <div data-studio-board-client style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      {showPicker(reply) ? (
        <label style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <span style={muted}>Client</span>
          <select style={field} value={value} disabled={busy || pending !== null} onChange={(e) => onPick(e.target.value)} title={line}>
            {reply.missing ? <option value={MISSING_VALUE} disabled>{`${reply.missing.name || "Unknown client"} (not in the CRM)`}</option> : null}
            <option value={OWN_VALUE}>Own work</option>
            {clients.map((c) => <option key={c.ref} value={c.ref}>{c.name}</option>)}
          </select>
        </label>
      ) : (
        <span style={{ ...muted, ...ellipsis }} title={line}>{line}</span>
      )}
      {notes.map((note) => <p key={note} style={muted}>{note}</p>)}
      {pending ? (
        <div role="group" aria-label="Confirm client change" style={{ display: "grid", gap: 6, padding: 8, borderRadius: 8, border: `1px solid ${tokens.border}` }}>
          <p style={{ ...muted, color: tokens.fg }}>{confirmText(pending)}</p>
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" style={button} onClick={onCancel} disabled={busy}>Cancel</button>
            <button type="button" style={button} onClick={onConfirm} disabled={busy}>{busy ? "Saving…" : "Switch client"}</button>
          </div>
        </div>
      ) : null}
      {error ? <p role="alert" style={{ ...muted, color: tokens.destructive }}>{error}</p> : null}
      {driveClient ? <FromDrive companyId={companyId} client={driveClient} variant="panel" small onImported={onImported} /> : null}
    </div>
  );
}

/** The panel for one load state. Exported for the render harness. */
export function BoardLibraryView({ load, canEdit, thumbs, placing, message, onPlace, onAddGenerate, header }: {
  load: LibraryLoad;
  canEdit: boolean;
  thumbs: Record<string, CardState>;
  /** The file id being placed, or GENERATE_PLACING while a generate card is. */
  placing: string | null;
  message: string | null;
  onPlace: (item: BoardLibraryItem) => void;
  onAddGenerate?: () => void;
  /** The Client header (picker or read-only line, notes, From Drive). */
  header?: ReactNode;
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
  // With the Client header the line above the files is the header itself; without it (old harness) keep the scope line.
  const scopeLine = header || load.status !== "ready" ? null : load.reply.withheld ? "Client work" : load.reply.board.kind === "client" ? `${load.reply.board.name ?? "Client"}'s files` : "Own work";
  return (
    <section aria-label="Studio library" style={panel}>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <strong style={{ fontSize: 13, fontWeight: 600 }}>Studio library</strong>
        {scopeLine ? <span style={{ ...muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={scopeLine}>{scopeLine}</span> : null}
      </div>
      {header}
      {showGenerateEntry(load) && onAddGenerate ? (
        <button type="button" data-studio-add-generate style={{ ...button, padding: "6px 8px", opacity: canEdit ? 1 : 0.5 }} disabled={!canEdit || placing !== null} onClick={onAddGenerate} title={canEdit ? "Place an empty generate card on the board" : "You can view this board but not edit it."}>
          {placing === GENERATE_PLACING ? "Adding…" : "Add generate card"}
        </button>
      ) : null}
      {message ? <p role="status" style={muted}>{message}</p> : null}
      {body}
    </section>
  );
}

function StudioBoardLibraryBody(props: PluginCanvasPanelProps) {
  const companyId = props.context?.companyId ?? null;
  const projectId = props.boardProjectId ?? null;
  const boardId = props.boardId ?? null;
  const boardScope = boardScopeOf(projectId, boardId);
  const list = useStudioAction("board-library");
  const clientAction = useStudioAction("board-client");
  const setClientAction = useStudioAction("board-client-set");
  const meAction = useStudioAction("me");
  const urls = useStudioAction("asset-urls");
  const [load, setLoad] = useState<LibraryLoad>({ status: "loading" });
  const [thumbs, setThumbs] = useState<Record<string, CardState>>({});
  const [placing, setPlacing] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const placed = useRef(0);
  const [client, setClient] = useState<ClientLoad>({ status: "loading" });
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [setting, setSetting] = useState(false);
  const [setError, setSetError] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [canGenerate, setCanGenerate] = useState(false);
  // Bumped after the client changes or a file is imported: the list and the signed links load again.
  const [reloads, setReloads] = useState(0);

  const loadClient = useCallback(async (): Promise<void> => {
    if (!companyId || !boardId) return;
    try {
      setClient({ status: "ready", reply: clientReplyFrom(await clientAction({ companyId, boardScope })) });
    } catch (error) {
      setClient({ status: "error", message: `Couldn't load this board's client. ${errorText(error)}` });
    }
  }, [clientAction, companyId, projectId, boardId]);

  useEffect(() => void loadClient(), [loadClient]);
  useEffect(() => {
    meAction({}).then((out) => setCanGenerate((out as { canGenerate?: unknown } | null)?.canGenerate === true), () => setCanGenerate(false));
  }, [meAction]);
  // The project's name, for "<Client> (from project <name>)". Only read when the project decides the client.
  const fromProject = client.status === "ready" && client.reply.source === "project";
  useEffect(() => {
    if (!fromProject || !projectId) return;
    let live = true;
    fetch(`/api/projects/${encodeURIComponent(projectId)}`, { credentials: "include", cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { name?: unknown } | null) => live && setProjectName(typeof body?.name === "string" && body.name ? body.name : null), () => undefined);
    return () => { live = false; };
  }, [fromProject, projectId]);

  const writeClient = useCallback(
    async (target: string | null) => {
      if (!companyId || client.status !== "ready") return;
      setSetting(true);
      setSetError(null);
      try {
        await setClientAction({ companyId, boardScope, client: target, expected: currentLink(client.reply) });
        setPending(null);
        setReloads((n) => n + 1);
      } catch (error) {
        setPending(null);
        setSetError(setErrorText(error));
      } finally {
        // Success or any set error: what the panel shows comes from the server again.
        await loadClient();
        setSetting(false);
      }
    },
    [companyId, client, setClientAction, projectId, boardId, loadClient],
  );

  const onPick = useCallback(
    async (value: string) => {
      if (client.status !== "ready" || !companyId) return;
      const target = value === OWN_VALUE ? null : value;
      if (target === currentLink(client.reply)) return;
      const label = target ? (client.reply.clients ?? []).find((c) => c.ref === target)?.name ?? "this client" : "Own work";
      let cards = 0;
      try {
        cards = studioCardCount(await readBoard(companyId, props.boardId));
      } catch {
        cards = 1; // unknown: ask, never skip the confirmation
      }
      if (cards > 0) setPending({ client: target, label, cards });
      else await writeClient(target);
    },
    [client, companyId, props.boardId, writeClient],
  );

  useEffect(() => {
    if (!companyId || !props.boardId) return;
    let live = true;
    let renew: ReturnType<typeof setInterval> | undefined;
    setLoad({ status: "loading" });
    list({ companyId, boardScope })
      .then((out) => {
        if (!live) return;
        const reply = out as BoardLibraryReply;
        setLoad({ status: "ready", reply });
        const sign = (fresh: boolean) => {
          for (const item of reply.assets) {
            void boardSigner.request(urls, companyId, projectId, boardId, item.id, { fresh }).then((state) => {
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
  }, [list, urls, companyId, projectId, props.boardId, reloads]);

  const place = useCallback(
    (id: string, op: Parameters<PluginCanvasPanelProps["applyOps"]>[0][number], done: string) => {
      setPlacing(id);
      setMessage(null);
      props
        .applyOps([op])
        .then((out) => {
          const result = (out as { results?: Array<{ status?: string; reason?: string }> } | null)?.results?.[0];
          if (result && result.status !== "applied") setMessage(`The board refused the card (${result.reason ?? result.status}).`);
          else {
            placed.current += 1;
            setMessage(done);
          }
        })
        .catch((error: unknown) => setMessage(`The card wasn't placed: ${errorText(error)}`))
        .finally(() => setPlacing(null));
    },
    [props.applyOps],
  );

  const onPlace = useCallback(
    (item: BoardLibraryItem) =>
      place(item.id, embedNodeOp({ pluginKey: STUDIO_PLUGIN_KEY, type: STUDIO_MEDIA_CARD, assetId: item.id, name: item.name, kind: item.kind, at: placeAt(placed.current) }), `Placed ${item.name} on the board.`),
    [place],
  );

  const onAddGenerate = useCallback(() => place(GENERATE_PLACING, newGenerateCardOp(placeAt(placed.current)), "Added a generate card to the board."), [place]);

  const header = (
    <ClientHeader
      client={client}
      projectName={projectName}
      pending={pending}
      busy={setting}
      error={setError}
      driveClient={client.status === "ready" ? driveClientOf(client.reply, canGenerate) : null}
      companyId={companyId ?? ""}
      onPick={(v) => void onPick(v)}
      onConfirm={() => void writeClient(pending?.client ?? null)}
      onCancel={() => setPending(null)}
      onRetry={() => void loadClient()}
      onImported={() => {
        setReloads((n) => n + 1);
        void loadClient();
      }}
    />
  );

  return <BoardLibraryView header={header} load={load} canEdit={props.accessLevel === "edit"} thumbs={thumbs} placing={placing} message={message} onPlace={onPlace} onAddGenerate={onAddGenerate} />;
}

export const StudioBoardLibrary = StudioBoardLibraryBody;
