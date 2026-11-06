/**
 * The `studio-canvas` page: a list of boards, and one board as a React Flow canvas. Cards are prompt, image, video,
 * source and output; connections follow canvas-rules.ts (the worker checks them again on save). Changes autosave
 * with the revision the page loaded, so a save never overwrites someone else's newer one.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
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
import { Button, errorText, Field, Input, Page, PageFrame, PageHeader, PageMessage, Section } from "@partnersinbiz/pib-plugin-ui";
import { acceptsInput, MAX_NODES, MAX_TEXT, NODE_TYPES, sendsOutput, type CanvasDoc, type NodeType } from "../canvas-rules.js";
import { cardInputs, type CardInputs } from "../canvas-inputs.js";
import { headerCredits } from "../canvas-settings.js";
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
const boardCss = `
.studio-canvas-flow svg { max-width: none; }
.studio-canvas-flow .react-flow__node-output { padding: 0; width: auto; border: none; border-radius: 0; background: none; box-shadow: none; text-align: left; }
.studio-canvas-flow .react-flow__edge-path, .studio-canvas-flow .react-flow__connection-path { stroke: var(--muted-foreground); stroke-width: 2; }
.studio-canvas-flow .react-flow__handle { width: 10px; height: 10px; }
.studio-canvas-layout { display: flex; gap: 8px; height: calc(100dvh - 15rem); min-height: 28rem; }
.studio-canvas-board { position: relative; flex: 1 1 auto; min-width: 0; }
.studio-canvas-panel { flex: 0 0 22rem; width: 22rem; box-sizing: border-box; display: grid; gap: 10px; align-content: start; overflow-y: auto; padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--card); color: var(--card-foreground, var(--foreground)); }
.studio-canvas-versions { position: relative; }
.studio-canvas-versions-list { position: absolute; z-index: 20; top: calc(100% + 4px); left: 0; width: min(22rem, calc(100vw - 2rem)); max-height: 60dvh; overflow-y: auto; box-sizing: border-box; display: grid; gap: 8px; padding: 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--card); color: var(--card-foreground, var(--foreground)); box-shadow: 0 4px 16px rgb(0 0 0 / 0.15); }
.studio-canvas-versions-list button { flex: 0 0 auto; white-space: nowrap; }
@media (max-width: 640px) { .studio-canvas-versions-list { position: fixed; top: auto; left: 1rem; right: 1rem; width: auto; } }
.studio-canvas-big { position: sticky; bottom: -12px; padding: 8px 0 12px; background: var(--card); }
.studio-canvas-big button { width: 100%; padding-block: 12px; }
.studio-canvas-zoom { position: absolute; left: 8px; bottom: 8px; z-index: 5; display: flex; gap: 4px; align-items: center; }
@media (max-width: 640px) {
  .studio-canvas-layout { flex-direction: column; height: auto; }
  .studio-canvas-board { flex: none; height: 55dvh; min-height: 18rem; }
  .studio-canvas-panel { flex: none; width: auto; max-height: 70dvh; }
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
}
const BoardCtx = createContext<BoardContext>({ beforeEdit: () => undefined, library: [], companyId: "", client: "own", canGenerate: null, models: [], unavailable: [], inputs: new Map(), urls: {}, videos: new Set(), buildOn: () => undefined });

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

  // React Flow drops a refused connection silently; say why.
  const onConnectEnd = useCallback((_: MouseEvent | TouchEvent, c: FinalConnectionState) => {
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
  const shownEdges = useMemo(() => labelEdges(nodes, edges), [nodes, edges]);
  const nodeTypes = useMemo(() => Object.fromEntries(NODE_TYPES.map((t) => [t, Card])), []);
  const status = conflict ? "Not saved" : { saved: "All changes saved", dirty: "Unsaved changes", saving: "Saving…", error: "Save failed" }[state];
  const credits = overview.data && overview.data.caps ? headerCredits(overview.data as Parameters<typeof headerCredits>[0], client) : null;
  const dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");

  if (board.error) return <Page title="Studio canvas" description="" message={errorText(board.error)} messageTone="danger" actions={<a {...nav.linkProps("/studio-canvas")}>All canvases</a>}>{null}</Page>;
  if (!board.data) return <Page title="Studio canvas" description="Loading…">{null}</Page>;

  return (
    <PageFrame style={{ maxWidth: "none", padding: 12, gap: 8 }}>
      <PageHeader title={board.data.title} description={`${board.data.client?.name ?? "Own work"} · ${status}`} actions={<div style={row}>{credits ? <span aria-label="Credits this month" style={{ fontSize: 13, whiteSpace: "nowrap" }}><strong>{credits.used}</strong>{credits.cap === null ? " credits used this month · no cap set" : ` of ${credits.cap} credits used this month`}</span> : null}<a {...nav.linkProps("/studio-canvas")}>All canvases</a></div>} />
      {conflict ? (
        <div role="alert" style={{ ...row, padding: 10, border: "1px solid var(--destructive, #c00)", borderRadius: 6, marginBottom: 8 }}>
          <span style={{ flex: "1 1 16rem", minWidth: 0 }}>Someone else saved this canvas after you opened it, so your latest changes were not saved. Reload to see their version, then make your changes again.</span>
          <Button onClick={reload}>Reload canvas</Button>
        </div>
      ) : null}
      <PageMessage tone="danger" message={notice ?? undefined} />
      <div role="toolbar" aria-label="Canvas" title="Prompts and sources feed image and video cards; images feed images, videos and outputs; videos feed outputs. Select an image or video card to set it up and generate. Changes save on their own." style={row}>
        {NODE_TYPES.map((t) => (
          <Button key={t} variant="secondary" disabled={conflict} onClick={() => addCard(t)}>+ {CARD_LABELS[t]}</Button>
        ))}
        <Button variant="secondary" disabled={!history.current.canUndo || conflict} onClick={undo} aria-label="Undo">Undo</Button>
        <Button variant="secondary" disabled={!history.current.canRedo || conflict} onClick={redo} aria-label="Redo">Redo</Button>
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
      </div>
      <BoardCtx.Provider value={{ beforeEdit, library, companyId, client: client ?? "own", canGenerate: canGen, models: overview.data?.models ?? [], unavailable: overview.data?.unavailableModels ?? [], inputs, urls, videos, buildOn }}>
        <div className="studio-canvas-layout">
        <div className="studio-canvas-board">
        <div className="studio-canvas-flow" style={{ width: "100%", height: "100%", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
          <ReactFlow<FlowNode, Edge>
            nodes={nodes}
            edges={shownEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onConnectEnd={onConnectEnd}
            isValidConnection={isValidConnection}
            onNodeDragStart={beforeEdit}
            onMoveEnd={(_, vp) => { viewport.current = vp; }}
            defaultViewport={board.data.doc.viewport}
            nodesDraggable={!conflict}
            nodesConnectable={!conflict}
            colorMode={dark ? "dark" : "light"}
            minZoom={0.1}
            maxZoom={4}
            proOptions={{ hideAttribution: true }}
          >
            <Background />
          </ReactFlow>
        </div>
        <div className="studio-canvas-zoom" role="group" aria-label="Zoom">
          <Button variant="secondary" onClick={() => void flow.zoomOut()} aria-label="Zoom out">−</Button>
          <Button variant="secondary" onClick={() => void flow.zoomIn()} aria-label="Zoom in">+</Button>
          <Button variant="secondary" onClick={() => void flow.fitView({ padding: 0.2 })}>Fit</Button>
        </div>
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

function Card({ id, type, data, selected }: NodeProps<FlowNode>) {
  const { beforeEdit, library } = useContext(BoardCtx);
  const flow = useReactFlow<FlowNode, Edge>();
  const kind = type as NodeType;
  const set = (patch: Record<string, string>) => flow.updateNodeData(id, patch);
  const text = (key: string, label: string, rows = 3) => (
    <label style={{ display: "grid", gap: 2 }}>
      <span style={muted}>{label}</span>
      <textarea className="nodrag nowheel" rows={rows} maxLength={MAX_TEXT} value={data[key] ?? ""} onFocus={beforeEdit} onChange={(e) => set({ [key]: e.target.value })} style={{ ...fieldStyle, resize: "vertical" }} />
    </label>
  );
  const picked = library.find((a) => a.id === data.assetId);
  return (
    <div style={{ width: 220, boxSizing: "border-box", padding: 8, display: "grid", gap: 6, borderRadius: 8, background: "var(--card)", color: "var(--card-foreground, var(--foreground))", border: `1px solid ${selected ? "var(--primary)" : "var(--border)"}` }}>
      {acceptsInput(kind) ? <Handle type="target" position={Position.Left} /> : null}
      <strong style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.4 }}>{CARD_LABELS[kind]}</strong>
      <input className="nodrag" aria-label="Card name" maxLength={120} placeholder="Name" value={data.label ?? ""} onFocus={beforeEdit} onChange={(e) => set({ label: e.target.value })} style={fieldStyle} />
      {kind === "prompt" ? text("text", "Prompt", 4) : null}
      {kind === "image" || kind === "video" ? <GenerateSummary id={id} kind={kind} data={data} /> : null}
      {kind === "source" ? (
        <label style={{ display: "grid", gap: 2 }}>
          <span style={muted}>Library file</span>
          <select className="nodrag" value={data.assetId ?? ""} onFocus={beforeEdit} onChange={(e) => { const a = library.find((x) => x.id === e.target.value); set({ assetId: e.target.value, label: data.label || a?.name || "" }); }} style={fieldStyle}>
            <option value="">Pick a file…</option>
            {data.assetId && !picked ? <option value={data.assetId}>File {data.assetId.slice(0, 8)}</option> : null}
            {library.map((a) => <option key={a.id} value={a.id}>{a.kind === "video" ? "Video" : "Image"}: {a.name}</option>)}
          </select>
          {library.length === 0 ? <span style={muted}>No images or videos in this library yet.</span> : null}
        </label>
      ) : null}
      {kind === "output" || kind === "source" ? <CardPreview assetId={data.assetId} name={data.label || "Result"} /> : null}
      {kind === "output" && data.assetId ? <ResultBar id={id} assetId={data.assetId} status={library.find((a) => a.id === data.assetId)?.status} /> : null}
      {kind === "output" && !data.assetId ? <span style={muted}>Filled in when a generation runs.</span> : null}
      {sendsOutput(kind) ? <Handle type="source" position={Position.Right} /> : null}
    </div>
  );
}

/** A result card's review badge and actions: open it in the library, build on it, download it. */
function ResultBar({ id, assetId, status }: { id: string; assetId: string; status: string | undefined }) {
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
  const badge = status === "approved" ? "Approved" : status === "rejected" ? "Rejected" : status ? "Review needed" : null;
  return (
    <div className="nodrag" style={{ display: "grid", gap: 4 }}>
      {badge ? <span aria-label="Review status" style={{ ...muted, justifySelf: "start", padding: "1px 6px", border: "1px solid var(--border)", borderRadius: 999 }}>{badge}</span> : null}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        <a {...nav.linkProps(`/studio?asset=${encodeURIComponent(assetId)}`)} style={{ fontSize: 12 }}>Open in library</a>
        <Button variant="secondary" onClick={() => buildOn(id)}>Use as input</Button>
        <Button variant="secondary" onClick={download}>Download</Button>
      </div>
      {error ? <span role="alert" style={{ color: "var(--destructive)", fontSize: 12, overflowWrap: "anywhere" }}>{error}</span> : null}
    </div>
  );
}

function CardPreview({ assetId, name, video }: { assetId: string | undefined; name: string; video?: boolean }) {
  const { urls, videos } = useContext(BoardCtx);
  if (!assetId) return null;
  const url = urls[assetId];
  const box: CSSProperties = { width: "100%", height: 120, objectFit: "cover", borderRadius: 6, background: "var(--muted, rgba(127,127,127,0.12))", display: "block" };
  if (!url) return <div style={{ ...box, display: "grid", placeItems: "center", ...muted }}>Loading preview…</div>;
  if (video || videos.has(assetId)) return <video className="nodrag" src={url} style={box} muted playsInline controls preload="metadata" />;
  return <img src={url} alt={name} style={box} />;
}

/** What an image or video card shows on the board: a one-line summary, the result, and where to configure it. */
function GenerateSummary({ id, kind, data }: { id: string; kind: "image" | "video"; data: CardData }) {
  const { inputs: all, models } = useContext(BoardCtx);
  const inputs = all.get(id) ?? NO_INPUTS;
  const model = models.find((m) => m.id === data.model);
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <span style={{ ...muted, overflowWrap: "anywhere" }}>
        {inputs.prompt || data.prompt ? `Prompt from ${(inputs.prompt || data.prompt).length} characters` : "No prompt yet"} · {inputs.referenceAssetIds.length} reference{inputs.referenceAssetIds.length === 1 ? "" : "s"}
        {model ? ` · ${model.label}` : ""}
      </span>
      {data.groupId ? <span style={muted}>Generating…</span> : <span style={muted}>Select the card to set it up and generate.</span>}
      <CardPreview assetId={data.assetId} name={data.label || CARD_LABELS[kind]} video={kind === "video"} />
    </div>
  );
}
