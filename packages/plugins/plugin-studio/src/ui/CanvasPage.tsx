/**
 * The `studio-canvas` page: a list of boards, and one board as a React Flow canvas. Cards are prompt, image, video,
 * source and output; connections follow canvas-rules.ts (the worker checks them again on save). Changes autosave
 * with the revision the page loaded, so a save never overwrites someone else's newer one.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useViewport,
  type Connection,
  type Edge,
  type EdgeChange,
  type FinalConnectionState,
  type NodeChange,
  type NodeProps,
  type Viewport,
} from "@xyflow/react";
import flowCss from "@xyflow/react/dist/style.css";
import { useHostContext, useHostLocation, useHostNavigation, usePluginAction, usePluginData, type PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import { Button, errorText, Field, Input, Page, PageFrame, PageMessage, Section } from "@partnersinbiz/pib-plugin-ui";
import { acceptsInput, MAX_NODES, MAX_TEXT, NODE_TYPES, sendsOutput, type CanvasDoc, type NodeType } from "../canvas-rules.js";
import { cardInputs, modelOptions, type CardInputs } from "../canvas-inputs.js";
import { effectiveValue, headerCredits } from "../canvas-settings.js";
import { aspectCss, cardStatus, creditsLeft, markRunning } from "./card-look.js";
import { SidePanel } from "./SidePanel.js";
import { VersionsMenu } from "./Versions.js";
import { CARD_LABELS, cascadePosition, connectionProblem, fromFlow, History, isConflict, labelEdges, newId, resultCards, toFlow, RESULT_GAP_X, type CardData, type FlowNode, type Snapshot } from "./board.js";

interface Summary { id: string; title: string; client: { kind: string; id: string; name: string } | null; revision: number; cards: number; updatedAt: string }
interface Board extends Summary { doc: CanvasDoc }
interface LibraryAsset { id: string; name: string; kind: string; status?: string }
interface PageModel { id: string; label: string; kind: "image" | "video"; ratios: string[]; resolutions: string[]; minRefs?: number; maxRefs?: number }
interface Unavailable { id: string; label: string; kind: "image" | "video"; note: string }
interface GenRow { id: string; groupId: string; status: string; assetId: string | null; error: string | null }

const SAVE_DELAY_MS = 1200;
const POLL_MS = 4000;
/** Signed links last five minutes; fetch fresh ones before that. */
const URL_REFRESH_MS = 4 * 60 * 1000;
const FINISHED = new Set(["succeeded", "failed", "cancelled"]);
const NO_INPUTS: CardInputs = { prompt: "", referenceAssetIds: [], missing: [], outputIds: [] };
const row: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" };
const muted: CSSProperties = { color: "var(--muted-foreground)", fontSize: "var(--text-xs, 12px)" };
// Our card types are custom components; "output" shares a class name with React Flow's built-in output node, so its
// default box is reset here. Edges get the host's text colour so they read on light and dark themes. The pib-ui base
// rule `:where(svg){max-width:100%}` squeezes React Flow's edge svg (inside a 0px-wide layer) to nothing; undo it here.
// PAR-8046 look: the board fills the page under a slim top bar, a floating dock and zoom rail, 14 px handles with a
// 32 px hit area, media-first cards with a coloured kind chip. Kind colours reuse the host's status tokens.
const boardCss = `
.studio-canvas-flow { --studio-accent: var(--dashboard-run-accent, var(--ring)); --studio-scrim: color-mix(in oklab, var(--foreground) 82%, transparent); }
.studio-canvas-flow svg { max-width: none; }
.studio-canvas-flow .react-flow__node-output { padding: 0; width: auto; border: none; border-radius: 0; background: none; box-shadow: none; text-align: left; }
.studio-canvas-flow .react-flow__edge-path, .studio-canvas-flow .react-flow__connection-path { stroke: var(--muted-foreground); stroke-width: 2.5; }
.studio-canvas-flow .studio-edge-running .react-flow__edge-path { stroke: var(--studio-accent); }
.studio-canvas-flow .react-flow__handle { width: 0.875rem; height: 0.875rem; border: 2px solid var(--studio-accent); background: var(--card); transition: transform 120ms ease, background 120ms ease; }
.studio-canvas-flow .react-flow__handle::before { content: ""; position: absolute; inset: -0.5625rem; border-radius: 999px; }
.studio-canvas-flow .react-flow__handle:hover, .studio-canvas-flow .react-flow__handle.connectingfrom, .studio-canvas-flow .react-flow__handle.connectingto.valid { transform: translate(-50%, -50%) scale(1.35); background: var(--studio-accent); }
.studio-canvas-flow .react-flow__node:focus-visible, .studio-dock button:focus-visible, .studio-zoom button:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.studio-card { width: 16rem; box-sizing: border-box; padding: 0.5rem; display: grid; gap: 0.5rem; border-radius: 0.75rem; background: var(--card); color: var(--card-foreground, var(--foreground)); border: 1px solid var(--border); transition: box-shadow 120ms ease, opacity 120ms ease; }
.studio-card[data-selected="true"] { border-color: var(--studio-accent); box-shadow: var(--shadow-profile-popover); }
.studio-card[data-dim="true"] { opacity: 0.35; }
.studio-card-head { display: flex; align-items: center; gap: 0.5rem; min-width: 0; font-size: var(--text-compact, 13px); font-weight: 600; }
.studio-card-head > span:nth-child(2) { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.studio-kind { display: inline-grid; place-items: center; width: 1.25rem; height: 1.25rem; border-radius: 0.375rem; font-size: var(--text-micro, 11px); font-weight: 700; color: var(--background); background: var(--kind); flex: none; }
.studio-kind-prompt { --kind: var(--status-task-in_review); } .studio-kind-source { --kind: var(--status-task-in_progress); } .studio-kind-image { --kind: var(--status-task-todo); }
.studio-kind-video { --kind: color-mix(in oklab, var(--status-task-todo), var(--status-task-blocked)); } .studio-kind-output { --kind: var(--status-task-done); }
.studio-media { position: relative; width: 100%; overflow: hidden; border-radius: 0.5rem; background: var(--muted); }
.studio-media > img, .studio-media > video { display: block; width: 100%; height: 100%; object-fit: cover; }
.studio-media-empty { display: grid; place-items: center; padding: 0.5rem; box-sizing: border-box; border: 1px dashed var(--border); background: none; color: var(--muted-foreground); font-size: var(--text-micro, 11px); text-align: center; }
.studio-media-blur { filter: blur(0.5rem) brightness(0.7); transform: scale(1.1); }
.studio-pill { display: inline-flex; align-items: center; gap: 0.25rem; padding: 0.125rem 0.5rem; border-radius: 999px; font-size: var(--text-micro, 11px); font-weight: 600; white-space: nowrap; background: var(--studio-scrim); color: var(--background); }
.studio-pill::before { content: ""; width: 0.375rem; height: 0.375rem; border-radius: 999px; background: var(--tone, transparent); }
.studio-tone-running { --tone: var(--status-task-todo); } .studio-tone-draft { --tone: var(--status-task-todo); } .studio-tone-done, .studio-tone-approved { --tone: var(--status-task-done); } .studio-tone-rejected { --tone: var(--status-task-blocked); }
.studio-overlay { position: absolute; display: flex; gap: 0.25rem; }
.studio-progress { position: absolute; left: 0.5rem; right: 0.5rem; bottom: 0.5rem; display: grid; gap: 0.25rem; color: var(--background); font-size: var(--text-micro, 11px); font-weight: 600; }
.studio-progress > i { display: block; height: 0.25rem; border-radius: 999px; background: color-mix(in oklab, var(--background) 35%, transparent); overflow: hidden; }
.studio-progress > i::after { content: ""; display: block; width: 40%; height: 100%; border-radius: inherit; background: var(--studio-accent); animation: studio-run 1.6s ease-in-out infinite; }
@keyframes studio-run { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
.studio-card-foot { display: flex; align-items: center; gap: 0.5rem; min-width: 0; color: var(--muted-foreground); font-size: var(--text-micro, 11px); }
.studio-card-foot > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.studio-topbar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; min-height: 3rem; padding: 0 0.25rem; }
.studio-topbar h1 { margin: 0; font-size: var(--text-base, 1rem); font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.studio-chip { display: inline-flex; align-items: center; gap: 0.375rem; padding: 0.125rem 0.625rem; border: 1px solid var(--border); border-radius: 999px; font-size: var(--text-micro, 11px); color: var(--muted-foreground); white-space: nowrap; }
.studio-canvas-layout { display: flex; gap: 0.5rem; height: calc(100dvh - 13rem); min-height: 28rem; }
.studio-canvas-board { position: relative; flex: 1 1 auto; min-width: 0; border-radius: 0.75rem; overflow: hidden; background: var(--background); }
.studio-canvas-panel { flex: 0 0 22rem; width: 22rem; box-sizing: border-box; display: grid; gap: 10px; align-content: start; overflow-y: auto; padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--card); color: var(--card-foreground, var(--foreground)); }
.studio-canvas-versions { position: relative; }
.studio-canvas-versions-list { position: absolute; z-index: 20; top: calc(100% + 4px); left: 0; width: min(22rem, calc(100vw - 2rem)); max-height: 60dvh; overflow-y: auto; box-sizing: border-box; display: grid; gap: 8px; padding: 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--card); color: var(--card-foreground, var(--foreground)); box-shadow: 0 4px 16px rgb(0 0 0 / 0.15); }
.studio-canvas-versions-list button { flex: 0 0 auto; white-space: nowrap; }
@media (max-width: 640px) { .studio-canvas-versions-list { position: fixed; top: auto; left: 1rem; right: 1rem; width: auto; } }
.studio-canvas-big { position: sticky; bottom: -12px; padding: 8px 0 12px; background: var(--card); }
.studio-canvas-big button { width: 100%; padding-block: 12px; }
.studio-float { position: absolute; z-index: 5; display: flex; align-items: center; gap: 0.125rem; padding: 0.25rem; border: 1px solid var(--border); border-radius: 0.875rem; background: color-mix(in oklab, var(--card) 85%, transparent); backdrop-filter: blur(0.75rem); box-shadow: var(--shadow-profile-popover); }
.studio-float button { font: inherit; font-size: var(--text-compact, 13px); padding: 0.375rem 0.625rem; border: 0; border-radius: 0.625rem; background: none; color: var(--foreground); cursor: pointer; white-space: nowrap; }
.studio-float button:hover:not(:disabled), .studio-float button[aria-pressed="true"] { background: var(--accent); }
.studio-float button:disabled { opacity: 0.4; cursor: not-allowed; }
.studio-float hr { align-self: stretch; width: 1px; margin: 0.25rem; border: 0; background: var(--border); }
.studio-dock { left: 50%; bottom: 1rem; transform: translateX(-50%); max-width: calc(100% - 7rem); overflow-x: auto; }
.studio-zoom { right: 1rem; bottom: 1rem; flex-direction: column; }
.studio-zoom span { font-size: var(--text-micro, 11px); padding: 0.25rem 0; min-width: 2.75rem; text-align: center; }
@media (prefers-reduced-motion: reduce) {
  .studio-canvas-flow .react-flow__edge.animated path, .studio-progress > i::after { animation: none; }
  .studio-canvas-flow .react-flow__handle, .studio-card { transition: none; }
}
@media (max-width: 640px) {
  .studio-canvas-layout { flex-direction: column; height: auto; }
  .studio-canvas-board { flex: none; height: 60dvh; min-height: 22rem; }
  .studio-canvas-panel { flex: none; width: auto; max-height: 70dvh; }
  .studio-dock { left: 0.5rem; right: 0.5rem; bottom: 0.5rem; transform: none; max-width: none; }
  .studio-zoom { right: 0.5rem; bottom: 4rem; }
}
`;
const fieldStyle: CSSProperties = { width: "100%", boxSizing: "border-box", font: "inherit", fontSize: 12, padding: 4, border: "1px solid var(--border)", borderRadius: 4, background: "var(--background)", color: "var(--foreground)" };

/** What card components need from the board: undo before an edit, the library for source pickers, and what Generate needs. */
interface BoardContext {
  beforeEdit: () => void;
  library: LibraryAsset[];
  companyId: string;
  /** The board's client as the generate form names it ("kind:id"), or "own". */
  client: string;
  canGenerate: boolean | null;
  models: PageModel[];
  unavailable: Unavailable[];
  inputs: Map<string, CardInputs>;
  urls: Record<string, string>;
  videos: Set<string>;
  /** Adds an image card fed by this card, so a result can be built on. */
  buildOn: (cardId: string) => void;
  /** Cards the connection being dragged can't join. */
  dim: Set<string>;
}
const NO_DIM = new Set<string>();
const BoardCtx = createContext<BoardContext>({ beforeEdit: () => undefined, library: [], companyId: "", client: "own", canGenerate: null, models: [], unavailable: [], inputs: new Map(), urls: {}, videos: new Set(), buildOn: () => undefined, dim: NO_DIM });

/** Fresh signed preview links for the files on the board. People only: the action checks membership. */
function usePreviews(companyId: string, ids: string[]): Record<string, string> {
  const assetUrls = usePluginAction("asset-urls");
  const [urls, setUrls] = useState<Record<string, string>>({});
  const key = ids.join(",");
  useEffect(() => {
    if (!key) return setUrls({});
    let live = true;
    const load = () => assetUrls({ companyId, assetIds: key.split(",") }).then((out) => { if (live) setUrls((out as { urls?: Record<string, string> }).urls ?? {}); }).catch(() => undefined);
    void load();
    const timer = setInterval(() => void load(), URL_REFRESH_MS);
    return () => { live = false; clearInterval(timer); };
  }, [companyId, key]);
  return urls;
}

export function StudioCanvasPage({ context }: PluginPageProps) {
  const host = useHostContext();
  const companyId = context.companyId ?? host.companyId ?? null;
  const { search } = useHostLocation();
  const canvasId = new URLSearchParams(search).get("canvas");
  if (!companyId) return <Page title="Studio canvas" description="Pick a company first.">{null}</Page>;
  if (!canvasId) return <CanvasList companyId={companyId} />;
  return (
    <ReactFlowProvider>
      <style>{flowCss + boardCss}</style>
      <BoardEditor key={canvasId} companyId={companyId} canvasId={canvasId} />
    </ReactFlowProvider>
  );
}

/** True for people who may change canvases (the worker's canvasEditor check); false for viewers; null while loading. */
function useCanEdit(companyId: string): boolean | null {
  const meAction = usePluginAction("me");
  const [canEdit, setCanEdit] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    meAction({ companyId })
      .then((out) => live && setCanEdit((out as { canGenerate?: boolean }).canGenerate === true))
      .catch(() => live && setCanEdit(false));
    return () => {
      live = false;
    };
  }, [companyId]);
  return canEdit;
}

/** Archive a board after a confirm. Resolves true when it was archived. */
function useArchive(companyId: string, onError: (text: string) => void) {
  const archive = usePluginAction("canvas-archive");
  const [busyId, setBusyId] = useState<string | null>(null);
  const run = async (b: { id: string; title: string }) => {
    if (!window.confirm(`Archive "${b.title}"? It leaves the canvas list.`)) return false;
    setBusyId(b.id);
    try {
      await archive({ companyId, canvasId: b.id });
      return true;
    } catch (err) {
      onError(errorText(err));
      return false;
    } finally {
      setBusyId(null);
    }
  };
  return { run, busyId };
}

function CanvasList({ companyId }: { companyId: string }) {
  const nav = useHostNavigation();
  const list = usePluginData<{ canvases: Summary[] }>("canvases", { companyId, limit: 100 });
  const create = usePluginAction("canvas-create");
  const canEdit = useCanEdit(companyId);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const archive = useArchive(companyId, setError);
  const start = () => {
    setBusy(true);
    setError(null);
    create({ companyId, title: title.trim() || "Untitled canvas" })
      .then((out) => nav.navigate(`/studio-canvas?canvas=${encodeURIComponent((out as { id: string }).id)}`))
      .catch((err) => setError(errorText(err)))
      .finally(() => setBusy(false));
  };
  const boards = list.data?.canvases ?? [];
  return (
    <Page title="Studio canvas" description="Boards that wire prompts, library files and generations together." actions={<a {...nav.linkProps("/studio")}>Back to Studio</a>}>
      <PageMessage tone="danger" message={error ?? (list.error ? errorText(list.error) : undefined)} />
      <Section title="New canvas">
        <div style={row}>
          <Field label="Name">
            <Input value={title} maxLength={120} placeholder="Untitled canvas" onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Button disabled={busy} onClick={start}>{busy ? "Creating…" : "Create canvas"}</Button>
        </div>
      </Section>
      <Section title="Canvases">
        {!list.data && !list.error ? <span style={muted}>Loading…</span> : null}
        {list.data && boards.length === 0 ? <span style={muted}>No canvases yet. Create one above.</span> : null}
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6 }}>
          {boards.map((b) => (
            <li key={b.id} style={{ ...row, justifyContent: "space-between", minWidth: 0 }}>
              <a {...nav.linkProps(`/studio-canvas?canvas=${encodeURIComponent(b.id)}`)} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: "1 1 12rem" }}>{b.title}</a>
              <span style={muted}>{b.client?.name ?? "Own work"} · {b.cards} cards · {new Date(b.updatedAt).toLocaleString()}</span>
              {canEdit ? (
                <Button
                  variant="secondary"
                  disabled={archive.busyId !== null}
                  aria-label={`Archive ${b.title}`}
                  onClick={() => void archive.run(b).then((done) => { if (done) { setError(null); list.refresh(); } })}
                >
                  {archive.busyId === b.id ? "Archiving…" : "Archive"}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </Section>
    </Page>
  );
}

type SaveState = "saved" | "dirty" | "saving" | "error";

function BoardEditor({ companyId, canvasId }: { companyId: string; canvasId: string }) {
  const nav = useHostNavigation();
  const flow = useReactFlow();
  const board = usePluginData<Board>("canvas", { companyId, canvasId });
  const saveAction = usePluginAction("canvas-save");
  const client = board.data?.client ? `${board.data.client.kind}:${board.data.client.id}` : undefined;
  const assets = usePluginData<{ assets: LibraryAsset[] }>("assets", { companyId, client, limit: 60 });
  const library = useMemo(() => (assets.data?.assets ?? []).filter((a) => a.kind === "image" || a.kind === "video"), [assets.data]);

  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [gen, setGen] = useState(0);
  const [state, setState] = useState<SaveState>("saved");
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const canEdit = useCanEdit(companyId);
  const archive = useArchive(companyId, setNotice);

  const history = useRef(new History());
  const now = useRef<Snapshot>({ nodes: [], edges: [] });
  now.current = { nodes, edges };
  const genRef = useRef(gen);
  genRef.current = gen;
  const revision = useRef(0);
  const viewport = useRef<Viewport>({ x: 0, y: 0, zoom: 1 });
  const saving = useRef(false);
  const savedGen = useRef(0);
  const reloading = useRef(false);

  // Generate on a card: the same models, estimate and generate actions as the Generate tab.
  const overview = usePluginData<{ models?: PageModel[]; unavailableModels?: Unavailable[]; companyUsed: number; caps: Array<{ scopeKey: string; monthlyCredits: number }>; clientUsage: Array<{ scopeKey: string; used: number }> }>("overview", { companyId });
  const meAction = usePluginAction("me");
  const [canGen, setCanGen] = useState<boolean | null>(null);
  const [meUserId, setMeUserId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    meAction({ companyId })
      .then((out) => { if (live) { setCanGen((out as { canGenerate?: boolean }).canGenerate === true); setMeUserId((out as { userId?: string }).userId ?? null); } })
      .catch(() => { if (live) setCanGen(false); });
    return () => { live = false; };
  }, [companyId]);
  const videos = useMemo(() => new Set(library.filter((a) => a.kind === "video").map((a) => a.id)), [library]);
  const inputs = useMemo(
    () => new Map(nodes.filter((n) => n.type === "image" || n.type === "video").map((n) => [n.id, cardInputs(nodes, edges, n.id, (a) => videos.has(a))] as const)),
    [nodes, edges, videos],
  );
  const shown = useMemo(() => [...new Set(nodes.map((n) => n.data.assetId).filter((a): a is string => Boolean(a)))].sort().slice(0, 100), [nodes]);
  const urls = usePreviews(companyId, shown);

  // Follow the cards' running generations; a finished one fills the card and every output card it feeds.
  const pending = useMemo(() => [...new Set(nodes.map((n) => n.data.groupId).filter((g): g is string => Boolean(g)))].sort().slice(0, 20), [nodes]);
  const pendingKey = pending.join(",");
  const gens = usePluginData<{ generations: GenRow[] }>("generations", { companyId, groupIds: pending });
  const refreshGens = gens.refresh;
  useEffect(() => {
    if (!pendingKey) return;
    const timer = setInterval(() => refreshGens(), POLL_MS);
    return () => clearInterval(timer);
  }, [pendingKey, refreshGens]);
  useEffect(() => {
    const rows = gens.data?.generations ?? [];
    if (!rows.length || conflict) return;
    let stored = false;
    let nextNodes = now.current.nodes;
    let nextEdges = now.current.edges;
    let added = false;
    for (const n of now.current.nodes) {
      const mine = rows.filter((r) => r.groupId === n.data.groupId);
      if (!n.data.groupId || !mine.length || mine.some((r) => !FINISHED.has(r.status))) continue;
      const done = mine.filter((r) => r.assetId).map((r) => r.assetId as string);
      if (done.length) {
        flow.updateNodeData(n.id, { assetId: done[0], groupId: "" });
        // Each result is its own card next to this one; a wired output card is filled instead of a new one.
        const made = resultCards(nextNodes, nextEdges, n.id, done, MAX_NODES - nextNodes.length);
        for (const f of made.fills) flow.updateNodeData(f.id, { assetId: f.assetId });
        if (made.created.length) {
          nextNodes = [...nextNodes, ...made.created];
          nextEdges = [...nextEdges, ...made.edges];
          added = true;
        }
        stored = true;
      } else {
        flow.updateNodeData(n.id, { groupId: "" });
        setNotice(`${n.data.label || CARD_LABELS[n.type as NodeType]} card: the generation failed${mine[0]?.error ? `: ${mine[0].error}` : "."}`);
      }
    }
    if (added) {
      setNodes((ns) => [...ns, ...nextNodes.filter((c) => !ns.some((x) => x.id === c.id))]);
      setEdges((es) => [...es, ...nextEdges.filter((c) => !es.some((x) => x.id === c.id))]);
      changed();
    }
    if (stored) assets.refresh();
  }, [gens.data]);

  // Load the board once, and again after "Reload" on a conflict.
  useEffect(() => {
    const data = board.data;
    if (!data || (loaded && !(reloading.current && data.revision !== revision.current))) return;
    const snap = toFlow(data.doc);
    setNodes(snap.nodes);
    setEdges(snap.edges);
    revision.current = data.revision;
    viewport.current = data.doc.viewport;
    void flow.setViewport(data.doc.viewport);
    // Open with every card in view (a phone shows a small part of a saved desktop viewport). React Flow queues this
    // until the new cards are measured. maxZoom 1 keeps a board with one card from zooming in on it.
    if (snap.nodes.length > 0) void flow.fitView({ padding: 0.2, maxZoom: 1 });
    history.current.clear();
    savedGen.current = gen;
    reloading.current = false;
    setConflict(false);
    setState("saved");
    setLoaded(true);
  }, [board.data]);

  const changed = useCallback(() => {
    setGen((g) => g + 1);
    setState((s) => (s === "saving" ? s : "dirty"));
  }, []);
  const beforeEdit = useCallback(() => {
    history.current.push(now.current);
    setTick((t) => t + 1);
  }, []);

  const save = useCallback(async () => {
    if (saving.current || conflict) return;
    saving.current = true;
    const at = gen;
    setState("saving");
    try {
      const out = (await saveAction({ companyId, canvasId, baseRevision: revision.current, doc: fromFlow(now.current.nodes, now.current.edges, viewport.current) })) as { revision: number };
      revision.current = out.revision;
      savedGen.current = at;
      setNotice(null);
      setState(genRef.current === at ? "saved" : "dirty");
    } catch (err) {
      if (isConflict(err)) setConflict(true);
      else setNotice(errorText(err));
      setState("error");
    } finally {
      saving.current = false;
    }
  }, [companyId, canvasId, conflict, gen, saveAction]);

  // Autosave a moment after the last change; one save at a time.
  useEffect(() => {
    // After a failed save, wait for the next change or "Save now" instead of retrying in a loop.
    if (!loaded || conflict || gen === savedGen.current || state === "saving" || state === "error") return;
    const t = setTimeout(() => void save(), SAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [gen, loaded, conflict, state, save]);

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (state === "saved") return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [state]);

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    if (changes.some((c) => c.type === "remove")) beforeEdit();
    setNodes((ns) => applyNodeChanges(changes, ns));
    if (changes.some((c) => c.type === "remove" || c.type === "add" || c.type === "replace" || (c.type === "position" && c.dragging === false))) changed();
  }, [beforeEdit, changed]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    if (changes.some((c) => c.type === "remove")) beforeEdit();
    setEdges((es) => applyEdgeChanges(changes, es));
    if (changes.some((c) => c.type === "remove" || c.type === "add")) changed();
  }, [beforeEdit, changed]);

  const onConnect = useCallback((c: Connection) => {
    const problem = connectionProblem(now.current.nodes, now.current.edges, c.source, c.target);
    if (problem) return setNotice(problem);
    beforeEdit();
    setNotice(null);
    setEdges((es) => addEdge({ id: newId("e"), source: c.source, target: c.target }, es));
    changed();
  }, [beforeEdit, changed]);

  // While dragging a connection, cards it can't join dim.
  const [dim, setDim] = useState<Set<string>>(NO_DIM);
  const onConnectStart = useCallback((_: MouseEvent | TouchEvent, p: { nodeId: string | null; handleType: "source" | "target" | null }) => {
    const from = p.nodeId;
    if (!from) return;
    const { nodes: ns, edges: es } = now.current;
    setDim(new Set(ns.filter((n) => n.id !== from && (p.handleType === "target" ? connectionProblem(ns, es, n.id, from) : connectionProblem(ns, es, from, n.id)) !== null).map((n) => n.id)));
  }, []);

  // React Flow drops a refused connection silently; say why.
  const onConnectEnd = useCallback((_: MouseEvent | TouchEvent, c: FinalConnectionState) => {
    setDim(NO_DIM);
    if (c.isValid !== false || !c.fromNode || !c.toNode) return;
    const [source, target] = c.fromHandle?.type === "target" ? [c.toNode.id, c.fromNode.id] : [c.fromNode.id, c.toNode.id];
    setNotice(connectionProblem(now.current.nodes, now.current.edges, source, target));
  }, []);

  const isValidConnection = useCallback((c: Connection | Edge) => connectionProblem(now.current.nodes, now.current.edges, c.source, c.target) === null, []);

  const addCard = (type: NodeType) => {
    if (nodes.length >= MAX_NODES) return setNotice(`A canvas holds at most ${MAX_NODES} cards.`);
    const el = document.querySelector(".studio-canvas-flow");
    const box = el?.getBoundingClientRect();
    const centre = box ? flow.screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height / 2 }) : { x: 0, y: 0 };
    // Cascade from the viewport centre: each card already at that spot pushes the new one CASCADE_STEP down-right.
    const position = cascadePosition(nodes, { x: centre.x - 110, y: centre.y - 60 });
    beforeEdit();
    setNodes((ns) => [...ns, { id: newId("n"), type, position, data: {} }]);
    changed();
  };

  const buildOn = useCallback((cardId: string) => {
    const from = now.current.nodes.find((n) => n.id === cardId);
    if (!from) return;
    if (now.current.nodes.length >= MAX_NODES) return setNotice(`A canvas holds at most ${MAX_NODES} cards.`);
    const id = newId("n");
    beforeEdit();
    setNodes((ns) => [...ns, { id, type: "image", position: { x: from.position.x + RESULT_GAP_X, y: from.position.y }, data: {} }]);
    setEdges((es) => [...es, { id: newId("e"), source: cardId, target: id }]);
    changed();
  }, [beforeEdit, changed]);

  const restore = (snap: Snapshot | null) => {
    if (!snap) return;
    setNodes(snap.nodes);
    setEdges(snap.edges);
    changed();
  };
  const undo = () => restore(history.current.undo(now.current));
  const redo = () => restore(history.current.redo(now.current));

  // Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z, but not while typing in a card.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z" || t?.closest("input, textarea, select, [contenteditable]")) return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const reload = () => {
    reloading.current = true;
    board.refresh();
  };

  const selectedNodes = nodes.filter((n) => n.selected);
  const selectedCard = selectedNodes.length === 1 ? selectedNodes[0] : null;
  const panelEdit = useCallback((id: string, patch: Record<string, string>) => {
    // Typing is one undo step (taken when the field gets focus); chips and steppers are one step each.
    if (!("prompt" in patch || "label" in patch)) beforeEdit();
    flow.updateNodeData(id, patch);
  }, [beforeEdit, flow]);
  const shownEdges = useMemo(() => markRunning(nodes, labelEdges(nodes, edges)), [nodes, edges]);
  const [selectMode, setSelectMode] = useState(false);
  const nodeTypes = useMemo(() => Object.fromEntries(NODE_TYPES.map((t) => [t, Card])), []);
  const status = conflict ? "Not saved" : { saved: "All changes saved", dirty: "Unsaved changes", saving: "Saving…", error: "Save failed" }[state];
  const credits = overview.data && overview.data.caps ? headerCredits(overview.data as Parameters<typeof headerCredits>[0], client) : null;
  const dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");

  if (board.error) return <Page title="Studio canvas" description="" message={errorText(board.error)} messageTone="danger" actions={<a {...nav.linkProps("/studio-canvas")}>All canvases</a>}>{null}</Page>;
  if (!board.data) return <Page title="Studio canvas" description="Loading…">{null}</Page>;

  return (
    <PageFrame style={{ maxWidth: "none", padding: 12, gap: 8 }}>
      <header className="studio-topbar">
        <h1>{board.data.title}</h1>
        <span className="studio-chip">{board.data.client?.name ?? "Own work"}</span>
        <span className="studio-chip" role="status">{status}</span>
        <span style={{ flex: "1 1 0" }} />
        {credits ? <span className="studio-chip" aria-label="Credits this month" style={{ color: "var(--foreground)" }}>{credits.cap === null ? `${credits.used} credits used · no cap set` : `${creditsLeft(credits.used, credits.cap)} of ${credits.cap} credits left`}</span> : null}
        {state === "error" && !conflict ? <Button onClick={() => void save()}>Save now</Button> : null}
        <VersionsMenu companyId={companyId} canvasId={canvasId} canEdit={canEdit === true} saved={state === "saved" && !conflict} revision={() => revision.current} onRestored={reload} />
        {canEdit ? (
          <Button
            variant="secondary"
            disabled={archive.busyId !== null}
            onClick={() => void archive.run({ id: canvasId, title: board.data?.title ?? "this canvas" }).then((done) => { if (done) { setState("saved"); nav.navigate("/studio-canvas"); } })}
          >
            {archive.busyId ? "Archiving…" : "Archive"}
          </Button>
        ) : null}
        <a {...nav.linkProps("/studio-canvas")} style={{ fontSize: "var(--text-compact, 13px)" }}>All canvases</a>
      </header>
      {conflict ? (
        <div role="alert" style={{ ...row, padding: 10, border: "1px solid var(--destructive, #c00)", borderRadius: 6, marginBottom: 8 }}>
          <span style={{ flex: "1 1 16rem", minWidth: 0 }}>Someone else saved this canvas after you opened it, so your latest changes were not saved. Reload to see their version, then make your changes again.</span>
          <Button onClick={reload}>Reload canvas</Button>
        </div>
      ) : null}
      <PageMessage tone="danger" message={notice ?? undefined} />
      <BoardCtx.Provider value={{ beforeEdit, library, companyId, client: client ?? "own", canGenerate: canGen, models: overview.data?.models ?? [], unavailable: overview.data?.unavailableModels ?? [], inputs, urls, videos, buildOn, dim }}>
        <div className="studio-canvas-layout">
        <div className="studio-canvas-board studio-canvas-flow">
          <ReactFlow<FlowNode, Edge>
            nodes={nodes}
            edges={shownEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onConnectStart={onConnectStart}
            onConnectEnd={onConnectEnd}
            isValidConnection={isValidConnection}
            onNodeDragStart={beforeEdit}
            onMoveEnd={(_, vp) => { viewport.current = vp; }}
            defaultViewport={board.data.doc.viewport}
            nodesDraggable={!conflict}
            nodesConnectable={!conflict}
            selectionOnDrag={selectMode}
            panOnDrag={!selectMode}
            colorMode={dark ? "dark" : "light"}
            minZoom={0.1}
            maxZoom={4}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1.5} color="var(--muted-foreground)" bgColor="var(--background)" />
          </ReactFlow>
          <div className="studio-float studio-dock" role="toolbar" aria-label="Canvas" title="Prompts and sources feed image and video cards; images feed images, videos and outputs; videos feed outputs. Select an image or video card to set it up and generate. Changes save on their own.">
            <button type="button" aria-pressed={selectMode} onClick={() => setSelectMode(!selectMode)} title="Drag on the board to select several cards">Select</button>
            <hr />
            {NODE_TYPES.map((t) => (
              <button key={t} type="button" disabled={conflict} onClick={() => addCard(t)}>+ {CARD_LABELS[t]}</button>
            ))}
            <hr />
            <button type="button" disabled={!history.current.canUndo || conflict} onClick={undo} aria-label="Undo" title="Undo">↶</button>
            <button type="button" disabled={!history.current.canRedo || conflict} onClick={redo} aria-label="Redo" title="Redo">↷</button>
          </div>
          <ZoomRail />
        </div>
        {selectedCard ? (
          <SidePanel
            key={selectedCard.id}
            card={{ id: selectedCard.id, type: selectedCard.type as string, data: selectedCard.data }}
            companyId={companyId}
            canvasId={canvasId}
            meUserId={meUserId}
            client={client ?? "own"}
            canGenerate={canGen}
            models={overview.data?.models ?? []}
            unavailable={overview.data?.unavailableModels ?? []}
            inputs={inputs.get(selectedCard.id) ?? NO_INPUTS}
            assetStatus={library.find((a) => a.id === selectedCard.data.assetId)?.status}
            edit={(patch) => panelEdit(selectedCard.id, patch)}
            beforeEdit={beforeEdit}
            onGenerated={(groupId) => { flow.updateNodeData(selectedCard.id, { groupId }); overview.refresh(); }}
            onBuildOn={() => buildOn(selectedCard.id)}
            onClose={() => setNodes((ns) => ns.map((n) => (n.selected ? { ...n, selected: false } : n)))}
          />
        ) : null}
        </div>
      </BoardCtx.Provider>
    </PageFrame>
  );
}

const KIND_LETTER: Record<NodeType, string> = { prompt: "T", source: "S", image: "I", video: "V", output: "O" };

function Card({ id, type, data, selected }: NodeProps<FlowNode>) {
  const { beforeEdit, library, dim } = useContext(BoardCtx);
  const flow = useReactFlow<FlowNode, Edge>();
  const kind = type as NodeType;
  const set = (patch: Record<string, string>) => flow.updateNodeData(id, patch);
  const picked = library.find((a) => a.id === data.assetId);
  const status = cardStatus(kind, data, picked?.status);
  return (
    <div className="studio-card" data-selected={selected ? "true" : undefined} data-dim={dim.has(id) ? "true" : undefined}>
      {acceptsInput(kind) ? <Handle type="target" position={Position.Left} /> : null}
      <div className="studio-card-head">
        <span className={`studio-kind studio-kind-${kind}`} aria-hidden="true">{KIND_LETTER[kind]}</span>
        <span title={data.label || CARD_LABELS[kind]}>{data.label || CARD_LABELS[kind]}</span>
        {status && kind !== "output" ? <span className={`studio-pill studio-tone-${status.tone}`}>{status.label}</span> : null}
      </div>
      {kind === "prompt" ? (
        <>
          <textarea className="nodrag nowheel" aria-label="Prompt" rows={4} maxLength={MAX_TEXT} placeholder="Describe the image or video" value={data.text ?? ""} onFocus={beforeEdit} onChange={(e) => set({ text: e.target.value })} style={{ ...fieldStyle, resize: "vertical", border: 0, background: "none", padding: 0 }} />
          <span style={muted}>{(data.text ?? "").length} / {MAX_TEXT}</span>
        </>
      ) : null}
      {kind === "image" || kind === "video" ? <GenerateSummary id={id} kind={kind} data={data} /> : null}
      {kind === "source" ? (
        <>
          <Media assetId={data.assetId} name={data.label || "Source"} ratio="4:3" empty="Pick a library file below" />
          <select className="nodrag" aria-label="Library file" value={data.assetId ?? ""} onFocus={beforeEdit} onChange={(e) => { const a = library.find((x) => x.id === e.target.value); set({ assetId: e.target.value, label: data.label || a?.name || "" }); }} style={fieldStyle}>
            <option value="">Pick a file…</option>
            {data.assetId && !picked ? <option value={data.assetId}>File {data.assetId.slice(0, 8)}</option> : null}
            {library.map((a) => <option key={a.id} value={a.id}>{a.kind === "video" ? "Video" : "Image"}: {a.name}</option>)}
          </select>
          {library.length === 0 ? <span style={muted}>No images or videos in this library yet.</span> : null}
        </>
      ) : null}
      {kind === "output" ? (
        <Media assetId={data.assetId} name={data.label || "Result"} ratio="4:3" empty="Filled in when a generation runs.">
          {status ? <div className="studio-overlay" style={{ left: "0.5rem", top: "0.5rem" }}><span className={`studio-pill studio-tone-${status.tone}`} aria-label="Review status">{status.label}</span></div> : null}
        </Media>
      ) : null}
      {kind === "output" && data.assetId ? <ResultBar id={id} assetId={data.assetId} /> : null}
      {sendsOutput(kind) ? <Handle type="source" position={Position.Right} /> : null}
    </div>
  );
}

/** A result card's actions: open it in the library, build on it, download it. */
function ResultBar({ id, assetId }: { id: string; assetId: string }) {
  const { companyId, buildOn } = useContext(BoardCtx);
  const nav = useHostNavigation();
  const assetUrl = usePluginAction("asset-url");
  const [error, setError] = useState<string | null>(null);
  const download = () => {
    setError(null);
    assetUrl({ companyId, assetId })
      .then((out) => window.open((out as { url: string }).url, "_blank", "noopener"))
      .catch((err) => setError(errorText(err)));
  };
  return (
    <div className="nodrag" style={{ display: "grid", gap: 4 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        <a {...nav.linkProps(`/studio?asset=${encodeURIComponent(assetId)}`)} style={{ fontSize: 12 }}>Open in library</a>
        <Button variant="secondary" onClick={() => buildOn(id)}>Use as input</Button>
        <Button variant="secondary" onClick={download}>Download</Button>
      </div>
      {error ? <span role="alert" style={{ color: "var(--destructive)", fontSize: 12, overflowWrap: "anywhere" }}>{error}</span> : null}
    </div>
  );
}

/** The card's media, full width at the card's ratio, with overlays on top; a dashed frame at that ratio when empty. */
function Media({ assetId, name, video, ratio, empty, children }: { assetId: string | undefined; name: string; video?: boolean; ratio: string | undefined; empty: string; children?: ReactNode }) {
  const { urls, videos } = useContext(BoardCtx);
  const style: CSSProperties = { aspectRatio: aspectCss(ratio) };
  if (!assetId) return <div className="studio-media studio-media-empty" style={style}>{empty}</div>;
  const url = urls[assetId];
  return (
    <div className="studio-media" style={style}>
      {!url ? <div className="studio-media-empty" style={{ height: "100%", border: 0 }}>Loading preview…</div>
        : video || videos.has(assetId) ? <video className="nodrag" src={url} muted playsInline controls preload="metadata" />
        : <img src={url} alt={name} />}
      {children}
    </div>
  );
}

/** An image or video card on the board: the result first (or the run's progress over its blurred reference), then the model and prompt. */
function GenerateSummary({ id, kind, data }: { id: string; kind: "image" | "video"; data: CardData }) {
  const { inputs: all, models, unavailable, urls } = useContext(BoardCtx);
  const inputs = all.get(id) ?? NO_INPUTS;
  // The same pick as the side panel: the saved model if this card can use it, else the first one that fits.
  const options = modelOptions(kind, inputs.referenceAssetIds.length, models, unavailable);
  const pick = options.find((o) => o.id === data.model && !o.disabled) ?? options.find((o) => !o.disabled);
  const model = models.find((m) => m.id === pick?.id);
  const ratio = effectiveValue(data.ratio, model?.ratios ?? []);
  const resolution = effectiveValue(data.resolution, model?.resolutions ?? []);
  const prompt = inputs.prompt || data.prompt || "";
  const ref = inputs.referenceAssetIds[0];
  const refUrl = ref ? urls[ref] : undefined;
  const refs = inputs.referenceAssetIds.length;
  return (
    <>
      {data.groupId ? (
        <div className="studio-media" style={{ aspectRatio: aspectCss(ratio) }}>
          {refUrl ? <img className="studio-media-blur" src={refUrl} alt="" /> : null}
          <div className="studio-progress" role="status"><span><span className="studio-pill studio-tone-running">Generating {kind}…</span></span><i /></div>
        </div>
      ) : (
        <Media assetId={data.assetId} name={data.label || CARD_LABELS[kind]} video={kind === "video"} ratio={ratio} empty={prompt ? "Select the card to generate" : "Wire in a prompt, then select the card to generate"}>
          <div className="studio-overlay" style={{ left: "0.5rem", bottom: "0.5rem" }}>
            {ratio ? <span className="studio-pill">{ratio}</span> : null}
            {resolution ? <span className="studio-pill">{resolution}</span> : null}
          </div>
        </Media>
      )}
      <div className="studio-card-foot">
        <span title={model?.label} style={{ flex: "0 1 auto", color: "var(--foreground)" }}>{model?.label ?? "No model"}</span>
        <span title={prompt || undefined} style={{ flex: "1 1 0" }}>{prompt || "No prompt yet"}</span>
        {refs ? <span style={{ flex: "none" }}>{refs} ref{refs === 1 ? "" : "s"}</span> : null}
      </div>
    </>
  );
}

/** Bottom-right zoom rail: in, the current zoom, out, fit. */
function ZoomRail() {
  const flow = useReactFlow();
  const { zoom } = useViewport();
  return (
    <div className="studio-float studio-zoom" role="group" aria-label="Zoom">
      <button type="button" aria-label="Zoom in" onClick={() => void flow.zoomIn()}>+</button>
      <span aria-label="Zoom level">{Math.round(zoom * 100)}%</span>
      <button type="button" aria-label="Zoom out" onClick={() => void flow.zoomOut()}>−</button>
      <button type="button" onClick={() => void flow.fitView({ padding: 0.2 })}>Fit</button>
    </div>
  );
}
